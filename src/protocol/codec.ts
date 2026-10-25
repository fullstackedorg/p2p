// Length-prefixed JSON frames. See docs/3-subsystems/codec.md.
import { P2PError } from "./errors.ts";
import type { Frame } from "./types.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function parse(text: string): Frame {
    let frame: unknown;
    try {
        frame = JSON.parse(text);
    } catch {
        throw new P2PError("INVALID_FRAME", "Frame payload is not valid JSON");
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
        throw new P2PError("INVALID_FRAME", "Frame payload is not a JSON object");
    }
    if (typeof (frame as Frame).type !== "string") {
        throw new P2PError("INVALID_FRAME", "Frame has no string type");
    }
    return frame as Frame;
}

export function encodeFrame(frame: Frame, maxPayloadBytes: number): Uint8Array {
    const payload = encoder.encode(JSON.stringify(frame));
    if (payload.byteLength > maxPayloadBytes) {
        throw new P2PError(
            "PAYLOAD_TOO_LARGE",
            `Frame of ${payload.byteLength} bytes exceeds ${maxPayloadBytes}`
        );
    }
    const out = new Uint8Array(4 + payload.byteLength);
    new DataView(out.buffer).setUint32(0, payload.byteLength);
    out.set(payload, 4);
    return out;
}

export function encodedSize(frame: Frame): number {
    return encoder.encode(JSON.stringify(frame)).byteLength;
}

export function encodeLinkMessage(frame: Frame): string {
    return JSON.stringify(frame);
}

export function decodeLinkMessage(message: string): Frame {
    return parse(message);
}

export class FrameDecoder {
    maxPayloadBytes: number;
    private chunks: Uint8Array[] = [];
    private buffered = 0;
    private expected = -1;

    constructor(maxPayloadBytes: number) {
        this.maxPayloadBytes = maxPayloadBytes;
    }

    get bufferedBytes(): number {
        return this.buffered;
    }

    push(chunk: Uint8Array): Frame[] {
        if (chunk.byteLength > 0) {
            this.chunks.push(chunk);
            this.buffered += chunk.byteLength;
        }
        const frames: Frame[] = [];
        for (;;) {
            if (this.expected < 0) {
                if (this.buffered < 4) break;
                const header = this.take(4);
                const length = new DataView(header.buffer, header.byteOffset, 4).getUint32(0);
                if (length === 0) throw new P2PError("INVALID_FRAME", "Frame length is 0");
                if (length > this.maxPayloadBytes) {
                    throw new P2PError(
                        "PAYLOAD_TOO_LARGE",
                        `Frame of ${length} bytes exceeds ${this.maxPayloadBytes}`
                    );
                }
                this.expected = length;
            }
            if (this.buffered < this.expected) break;
            const payload = this.take(this.expected);
            this.expected = -1;
            let text: string;
            try {
                text = decoder.decode(payload);
            } catch {
                throw new P2PError("INVALID_FRAME", "Frame payload is not valid UTF-8");
            }
            frames.push(parse(text));
        }
        return frames;
    }

    private take(size: number): Uint8Array {
        const first = this.chunks[0];
        if (first.byteLength >= size) {
            const out = first.subarray(0, size);
            if (first.byteLength === size) this.chunks.shift();
            else this.chunks[0] = first.subarray(size);
            this.buffered -= size;
            return out;
        }
        const out = new Uint8Array(size);
        let offset = 0;
        while (offset < size) {
            const chunk = this.chunks[0];
            const n = Math.min(chunk.byteLength, size - offset);
            out.set(chunk.subarray(0, n), offset);
            offset += n;
            if (n === chunk.byteLength) this.chunks.shift();
            else this.chunks[0] = chunk.subarray(n);
        }
        this.buffered -= size;
        return out;
    }
}
