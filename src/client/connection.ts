// The control socket: handshake, acks, heartbeat. See docs/4-client/transports.md §1.
import { EventEmitter } from "node:events";
import net from "node:net";
import { encodeFrame, FrameDecoder } from "../protocol/codec.ts";
import { closeReasonCode, isCloseReason, P2PError, type CloseReason } from "../protocol/errors.ts";
import { LIMITS, type ConnectedFrame, type Frame } from "../protocol/types.ts";

/** The byte stream the Client needs; a node:net Socket satisfies it. */
export type SocketLike = {
    write(chunk: Uint8Array): unknown;
    end(): unknown;
    destroy(): unknown;
    on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
    on(event: "close" | "error" | "connect", listener: (...args: any[]) => void): unknown;
    setNoDelay?(noDelay: boolean): unknown;
    /** node:net: `true` until the TCP connection is established. */
    connecting?: boolean;
};

export type Dialer = (host: string, port: number) => SocketLike;

const defaultDialer: Dialer = (host, port) => net.connect({ host, port });

type Pending = { resolve: (f: Frame) => void; reject: (e: P2PError) => void; timer: any };

export class Connection extends EventEmitter {
    maxPayloadBytes = 1_048_576;
    private socket: SocketLike;
    private decoder: FrameDecoder;
    private reqId = 0;
    private pending = new Map<number, Pending>();
    private closeReason: CloseReason | null = null;
    private ended = false;
    private lastSent = Date.now();
    private lastReceived = Date.now();
    private heartbeat: any = null;
    /** Frames that arrive after `connected` and before the Client attaches. */
    private held: Frame[] | null = null;
    /** The socket is open (connect fired, or a stream that is open from the start). */
    private opened: boolean;
    private received = false;

    private constructor(socket: SocketLike) {
        super();
        this.socket = socket;
        this.opened = socket.connecting !== true;
        this.decoder = new FrameDecoder(64 * 1024 * 1024);
        socket.setNoDelay?.(true);
        socket.on("connect", () => (this.opened = true));
        socket.on("data", (chunk) => {
            this.received = true;
            this.onData(chunk);
        });
        socket.on("error", () => {});
        socket.on("close", () => this.onClose());
    }

    /** Opens the socket and authenticates; rejects with the close reason's error code. */
    static open(
        host: string,
        port: number,
        auth: Frame,
        timeoutMs: number,
        dial: Dialer = defaultDialer
    ): Promise<{ conn: Connection; connected: ConnectedFrame }> {
        return new Promise((resolve, reject) => {
            const conn = new Connection(dial(host, port));
            const fail = (reason: CloseReason) => {
                cleanup();
                const err = new P2PError(closeReasonCode(reason), `Connection closed: ${reason}`);
                err.reason = reason;
                reject(err);
            };
            const timer = setTimeout(() => {
                cleanup();
                const stage = conn.opened || conn.received ? "handshake" : "socket";
                conn.destroy("connection_lost");
                const message =
                    stage === "socket"
                        ? `Connect timed out: the socket to ${host}:${port} never opened`
                        : `Connect timed out: ${host}:${port} accepted the connection but sent no reply`;
                const err = new P2PError("TIMEOUT", message);
                err.stage = stage;
                reject(err);
            }, timeoutMs);
            const onFrame = (frame: Frame) => {
                if (frame.type !== "connected") return;
                cleanup();
                conn.held = [];
                conn.maxPayloadBytes = frame.limits?.maxPayloadBytes ?? conn.maxPayloadBytes;
                conn.startHeartbeat(frame.heartbeat?.intervalMs, frame.heartbeat?.timeoutMs);
                resolve({ conn, connected: frame as ConnectedFrame });
            };
            const cleanup = () => {
                clearTimeout(timer);
                conn.off("frame", onFrame);
                conn.off("closed", fail);
            };
            conn.on("frame", onFrame);
            conn.once("closed", fail);
            conn.send({ ...auth, reqId: conn.nextReqId() });
        });
    }

    /** Starts delivering frames (including those received since `connected`). */
    attach(listener: (frame: Frame) => void): void {
        const held = this.held ?? [];
        this.held = null;
        this.on("frame", listener);
        for (const frame of held) listener(frame);
    }

    nextReqId(): number {
        return ++this.reqId;
    }

    get isOpen(): boolean {
        return !this.ended;
    }

    send(frame: Frame): void {
        if (this.ended) throw new P2PError("DISCONNECTED", "Not connected");
        this.socket.write(encodeFrame(frame, this.maxPayloadBytes));
        this.lastSent = Date.now();
    }

    /** Sends a frame with a reqId and resolves with its ack (rejects with its error). */
    request(frame: Frame): Promise<Frame> {
        return new Promise((resolve, reject) => {
            const reqId = this.nextReqId();
            const timer = setTimeout(() => {
                this.pending.delete(reqId);
                reject(new P2PError("TIMEOUT", "No acknowledgement", reqId));
            }, LIMITS.ackTimeoutMs);
            this.pending.set(reqId, { resolve, reject, timer });
            try {
                this.send({ ...frame, reqId });
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(reqId);
                reject(err);
            }
        });
    }

    /** Clean close: bye, then wait for the Server to end the socket (at most 1 s). */
    async close(): Promise<void> {
        if (this.ended) return;
        try {
            this.send({ type: "bye" });
        } catch {}
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                this.destroy("client_close");
                resolve();
            }, 1000);
            this.once("closed", () => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    destroy(reason: CloseReason): void {
        if (!this.closeReason) this.closeReason = reason;
        this.socket.destroy();
        this.onClose();
    }

    private startHeartbeat(intervalMs = 10_000, timeoutMs = 30_000): void {
        const tick = Math.max(20, Math.min(intervalMs, timeoutMs) / 4);
        this.heartbeat = setInterval(() => {
            const now = Date.now();
            if (now - this.lastReceived > timeoutMs) return this.destroy("heartbeat_timeout");
            if (now - this.lastSent >= intervalMs) {
                try {
                    this.send({ type: "ping" });
                } catch {}
            }
        }, tick);
        this.heartbeat.unref?.();
    }

    private onData(chunk: Uint8Array): void {
        this.lastReceived = Date.now();
        let frames: Frame[];
        try {
            frames = this.decoder.push(chunk);
        } catch {
            return this.destroy("connection_lost");
        }
        for (const frame of frames) this.onFrame(frame);
    }

    private onFrame(frame: Frame): void {
        if (frame.type === "close") {
            if (isCloseReason(frame.reason)) this.closeReason = frame.reason;
            return;
        }
        if (frame.type === "pong") return;
        const pending = typeof frame.reqId === "number" ? this.pending.get(frame.reqId) : undefined;
        if (pending && (frame.type === "ack" || frame.type === "error")) {
            this.pending.delete(frame.reqId);
            clearTimeout(pending.timer);
            if (frame.type === "ack") pending.resolve(frame);
            else pending.reject(new P2PError(frame.code, frame.message, frame.reqId));
            return;
        }
        if (this.held) this.held.push(frame);
        else this.emit("frame", frame);
    }

    private onClose(): void {
        if (this.ended) return;
        this.ended = true;
        clearInterval(this.heartbeat);
        const reason = this.closeReason ?? "connection_lost";
        for (const [reqId, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new P2PError("DISCONNECTED", "Connection closed", reqId));
        }
        this.pending.clear();
        this.emit("closed", reason);
    }
}
