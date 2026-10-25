// Media over the socket relay: MediaRecorder -> media:chunk -> MediaSource. See docs/4-client/media.md §2.
import type { Frame, PeerInfo } from "../protocol/types.ts";

const SLICE_MS = 100;
const BITRATE = 250_000;
const RESTART_MIN_MS = 1000;

export type MediaHost = {
    sessionId(): string;
    peers(): PeerInfo[];
    linked(sessionId: string): boolean;
    send(frame: Frame): void;
    onStream(from: string, stream: MediaStream): void;
    onEnded(from: string): void;
};

export function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

export function fromBase64(data: string): Uint8Array {
    const binary = atob(data);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

function pickMime(stream: MediaStream): string {
    const video = stream.getVideoTracks().length > 0;
    const audio = stream.getAudioTracks().length > 0;
    const candidates = video
        ? audio
            ? ["video/webm;codecs=vp8,opus", "video/webm"]
            : ["video/webm;codecs=vp8", "video/webm"]
        : ["audio/webm;codecs=opus", "audio/webm"];
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) ?? candidates[0];
}

class Sender {
    private recorder: MediaRecorder | null = null;
    private gen = 0;
    private chain: Promise<void> = Promise.resolve();
    private lastStart = 0;
    private pendingRestart: any = null;
    private stream: MediaStream;
    private streamId: string;
    private host: MediaHost;

    constructor(stream: MediaStream, streamId: string, host: MediaHost) {
        this.stream = stream;
        this.streamId = streamId;
        this.host = host;
    }

    start(): void {
        const mime = pickMime(this.stream);
        const video = this.stream.getVideoTracks().length > 0;
        const recorder = new MediaRecorder(this.stream, {
            mimeType: mime,
            audioBitsPerSecond: video ? 64_000 : BITRATE,
            videoBitsPerSecond: video ? BITRATE - 64_000 : undefined,
        });
        const gen = ++this.gen;
        let seq = 0;
        recorder.ondataavailable = (e) => {
            if (!e.data.size) return;
            const chunk = { seq: seq++, blob: e.data };
            this.chain = this.chain.then(async () => {
                const data = toBase64(new Uint8Array(await chunk.blob.arrayBuffer()));
                const deliveredTo = this.host.peers().filter((p) => this.host.linked(p.sessionId));
                const frame = { type: "media:chunk", streamId: this.streamId, gen, seq: chunk.seq };
                try {
                    this.host.send({
                        ...frame,
                        mime,
                        init: chunk.seq === 0,
                        data,
                        deliveredTo: deliveredTo.map((p) => p.sessionId),
                    });
                } catch {}
            });
        };
        recorder.start(SLICE_MS);
        this.recorder = recorder;
        this.lastStart = Date.now();
    }

    /** A fresh recorder generation (new init chunk), at most once per second. */
    restart(): void {
        if (this.pendingRestart) return;
        const wait = Math.max(0, this.lastStart + RESTART_MIN_MS - Date.now());
        this.pendingRestart = setTimeout(() => {
            this.pendingRestart = null;
            if (!this.recorder) return;
            this.stopRecorder();
            this.start();
        }, wait);
    }

    stop(): void {
        clearTimeout(this.pendingRestart);
        this.pendingRestart = null;
        this.stopRecorder();
    }

    private stopRecorder(): void {
        if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
        this.recorder = null;
    }
}

class Receiver {
    stream: MediaStream | null = null;
    private video: HTMLVideoElement;
    private source = new MediaSource();
    private buffer: SourceBuffer | null = null;
    private queue: Uint8Array[] = [];
    private gen = -1;
    private nextSeq = 0;
    private synced = false;
    private mime: string;

    constructor(mime: string, onReady: (stream: MediaStream) => void) {
        this.mime = mime;
        this.video = document.createElement("video");
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.style.display = "none";
        document.body.appendChild(this.video);
        this.video.src = URL.createObjectURL(this.source);
        this.source.addEventListener("sourceopen", () => {
            this.buffer = this.source.addSourceBuffer(this.mime);
            this.buffer.mode = "sequence";
            this.buffer.addEventListener("updateend", () => this.pump());
            this.pump();
            void this.video.play().catch(() => {});
            const capture =
                (this.video as any).captureStream ?? (this.video as any).mozCaptureStream;
            this.stream = capture.call(this.video) as MediaStream;
            onReady(this.stream);
        });
    }

    push(frame: Frame): void {
        if (frame.init) {
            if (frame.gen !== this.gen && this.buffer && this.source.readyState === "open") {
                try {
                    this.buffer.abort();
                } catch {}
                this.queue = [];
            }
            this.gen = frame.gen;
            this.nextSeq = 0;
            this.synced = true;
        }
        if (!this.synced || frame.gen !== this.gen || frame.seq !== this.nextSeq) {
            this.synced = false; // a gap: wait for the next init chunk
            return;
        }
        this.nextSeq++;
        this.queue.push(fromBase64(frame.data));
        this.pump();
    }

    end(): void {
        try {
            if (this.source.readyState === "open") this.source.endOfStream();
        } catch {}
        this.video.remove();
        URL.revokeObjectURL(this.video.src);
    }

    private pump(): void {
        const sb = this.buffer;
        if (!sb || sb.updating) return;
        const ranges = sb.buffered;
        if (ranges.length) {
            const end = ranges.end(ranges.length - 1);
            if (end - this.video.currentTime > 1) this.video.currentTime = end - 0.1;
            const start = ranges.start(0);
            if (this.video.currentTime - start > 3)
                return sb.remove(start, this.video.currentTime - 1);
        }
        const next = this.queue.shift();
        if (next) sb.appendBuffer(next as BufferSource);
    }
}

export class MediaFallback {
    private host: MediaHost;
    private stream: MediaStream | null = null;
    private streamId = "";
    private sender: Sender | null = null;
    private receivers = new Map<string, Receiver>();
    private counter = 0;

    constructor(host: MediaHost) {
        this.host = host;
    }

    share(stream: MediaStream | null): void {
        this.stopSharing();
        this.stream = stream;
        if (stream) this.streamId = `${this.host.sessionId()}:${++this.counter}`;
        this.update(false);
    }

    stopSharing(): void {
        this.sender?.stop();
        this.sender = null;
        if (this.stream) {
            try {
                this.host.send({ type: "media:end", streamId: this.streamId });
            } catch {}
        }
        this.stream = null;
    }

    /** Runs the recorder only while a media-capable peer is not linked. */
    update(newFallbackPeer: boolean): void {
        if (!this.stream) return;
        const needed = this.host
            .peers()
            .some((p) => p.capabilities.media && !this.host.linked(p.sessionId));
        if (needed && !this.sender) {
            this.sender = new Sender(this.stream, this.streamId, this.host);
            this.sender.start();
        } else if (!needed && this.sender) {
            this.sender.stop();
            this.sender = null;
        } else if (needed && newFallbackPeer) this.sender?.restart();
    }

    onChunk(from: string, frame: Frame): void {
        const key = `${from}:${frame.streamId}`;
        let receiver = this.receivers.get(key);
        if (!receiver) {
            if (!frame.init || typeof frame.mime !== "string") return;
            receiver = new Receiver(frame.mime, (stream) => this.host.onStream(from, stream));
            this.receivers.set(key, receiver);
        }
        receiver.push(frame);
    }

    onEnd(from: string, streamId: string): void {
        const key = `${from}:${streamId}`;
        this.receivers.get(key)?.end();
        if (this.receivers.delete(key)) this.host.onEnded(from);
    }

    onResync(streamId: string): void {
        if (streamId === this.streamId) this.sender?.restart();
    }

    peerLeft(sessionId: string): void {
        for (const key of [...this.receivers.keys()]) {
            if (key.startsWith(sessionId + ":"))
                this.onEnd(sessionId, key.slice(sessionId.length + 1));
        }
    }

    reset(): void {
        this.sender?.stop();
        this.sender = null;
        for (const r of this.receivers.values()) r.end();
        this.receivers.clear();
    }
}
