// One control socket: handshake, dispatch, closing. See docs/1-concepts/protocol-spec.md §2, §6.4, §7.
import crypto from "node:crypto";
import type net from "node:net";
import { encodeFrame, FrameDecoder } from "../protocol/codec.ts";
import { CLOSE_REASONS, P2PError, type CloseReason } from "../protocol/errors.ts";
import {
    PROTOCOL_VERSION,
    isId,
    isPlainObject,
    type Capabilities,
    type Frame,
    type Mode,
    type Role,
} from "../protocol/types.ts";
import type { Authenticator } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import { PEER_HANDLERS, type HandlerContext } from "./handlers.ts";
import { query, schema } from "./inspect.ts";
import type { Logger } from "./log.ts";
import type { Channels } from "./channels.ts";
import type { Member, Registry } from "./registry.ts";
import type { StateStore } from "./state-store.ts";

export type SessionHost = {
    config: ServerConfig;
    registry: Registry;
    channels: Channels;
    store: StateStore;
    auth: Authenticator;
    log: Logger;
    onOpen(session: Session): void;
    onClose(session: Session, reason: CloseReason): void;
};

const INSPECTOR_FRAMES = new Set(["schema", "query", "ping", "bye"]);

export class Session implements Member {
    sessionId = crypto.randomBytes(16).toString("base64url");
    peerId = "";
    deviceId = "";
    name = "";
    meta: Record<string, unknown> = {};
    role: Role = "ro";
    mode: Mode = "peer";
    capabilities: Capabilities = { webrtc: false, media: false };
    connectedAt = 0;
    channels = new Map<string, Record<string, unknown>>();
    links: Record<string, string> = {};
    requests = new Map<string, { from: string; expires: number }>();
    outOfSync = new Set<string>();
    authenticated = false;
    closed = false;
    lastReceived: number;
    private socket: net.Socket;
    private host: SessionHost;
    private decoder: FrameDecoder;
    private authTimer: NodeJS.Timeout;
    private ctx: HandlerContext;

    constructor(socket: net.Socket, host: SessionHost) {
        this.socket = socket;
        this.host = host;
        const { config } = host;
        this.decoder = new FrameDecoder(config.maxPayloadBytes);
        this.lastReceived = config.now();
        this.ctx = {
            registry: host.registry,
            channels: host.channels,
            store: host.store,
            member: this,
            now: config.now,
            ack: (f, x) => this.ack(f, x),
        };
        socket.setNoDelay(true);
        socket.on("data", (chunk) => this.onData(chunk as Buffer));
        socket.on("error", () => {});
        socket.on("close", () => this.onSocketClose());
        this.authTimer = setTimeout(() => this.close("auth_timeout"), config.authTimeoutMs);
    }

    writableLength(): number {
        return this.socket.writableLength;
    }

    write(bytes: Uint8Array): void {
        if (!this.closed) this.socket.write(bytes);
    }

    send(frame: Frame): void {
        this.write(encodeFrame(frame, Number.MAX_SAFE_INTEGER));
    }

    close(reason: CloseReason): void {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.authTimer);
        if (this.authenticated) this.host.onClose(this, reason);
        this.socket.write(encodeFrame({ type: "close", reason }, Number.MAX_SAFE_INTEGER));
        this.socket.end();
        setTimeout(() => this.socket.destroy(), 1000).unref();
    }

    private onSocketClose(): void {
        clearTimeout(this.authTimer);
        if (this.closed) return;
        this.closed = true;
        if (this.authenticated) this.host.onClose(this, CLOSE_REASONS.connectionLost);
    }

    private ack(frame: Frame, extra?: Record<string, unknown>): void {
        if (typeof frame.reqId === "number")
            this.send({ type: "ack", reqId: frame.reqId, ...extra });
    }

    private fail(frame: Frame, err: unknown): void {
        const p2p = err instanceof P2PError ? err : null;
        if (!p2p)
            this.host.log.error("frame handler failed", { type: frame.type, error: String(err) });
        const out: Frame = {
            type: "error",
            code: p2p?.code ?? "INVALID_ARGUMENT",
            message: p2p?.message ?? "Internal error",
        };
        if (typeof frame.reqId === "number") out.reqId = frame.reqId;
        this.send(out);
    }

    private onData(chunk: Buffer): void {
        this.lastReceived = this.host.config.now();
        let frames: Frame[];
        try {
            frames = this.decoder.push(chunk);
        } catch (err) {
            const tooLarge = err instanceof P2PError && err.code === "PAYLOAD_TOO_LARGE";
            return this.close(tooLarge ? "payload_too_large" : "invalid_frame");
        }
        for (const frame of frames) {
            if (this.closed) return;
            if (!this.authenticated) this.preAuth(frame);
            else this.dispatch(frame);
        }
    }

    private preAuth(frame: Frame): void {
        if (frame.type === "health") {
            this.send({ type: "health", ok: true });
            return this.close("client_close");
        }
        if (frame.type !== "auth") return this.close("invalid_frame");
        if (frame.version !== PROTOCOL_VERSION) return this.close("unsupported_version");
        if (frame.mode !== undefined && frame.mode !== "peer" && frame.mode !== "inspect") {
            return this.close("invalid_frame");
        }
        const role = this.host.auth.authenticate(frame.user, frame.password);
        if (!role) {
            this.host.log.warn("authentication failed", { user: String(frame.user).slice(0, 64) });
            return this.close("auth_failed");
        }
        this.identify(frame, role);
        const { registry, channels, config } = this.host;
        const replaced =
            this.mode === "peer" ? registry.findDevice(this.peerId, this.deviceId) : undefined;
        if (registry.connections - (replaced ? 1 : 0) >= config.maxConnections) {
            return this.close("server_full");
        }
        replaced?.close("session_replaced");
        clearTimeout(this.authTimer);
        this.authenticated = true;
        this.connectedAt = config.now();
        const isPeer = this.mode === "peer";
        this.send({
            type: "connected",
            reqId: frame.reqId,
            sessionId: this.sessionId,
            peerId: this.peerId,
            deviceId: this.deviceId,
            role,
            peers: isPeer ? [...registry.peers.values()].map((m) => registry.info(m)) : [],
            channels: isPeer ? channels.list() : [],
            iceServers: config.iceServers,
            limits: {
                maxPayloadBytes: config.maxPayloadBytes,
                maxChannelsPerSession: config.maxChannelsPerSession,
            },
            heartbeat: {
                intervalMs: config.heartbeatIntervalMs,
                timeoutMs: config.heartbeatTimeoutMs,
            },
        });
        registry.join(this, replaced?.sessionId);
        this.host.onOpen(this);
    }

    private identify(frame: Frame, role: Role): void {
        const peer = isPlainObject(frame.peer) ? frame.peer : {};
        this.role = role;
        this.mode = frame.mode === "inspect" ? "inspect" : "peer";
        const fallback = this.mode === "inspect" ? `inspect:${this.sessionId}` : this.sessionId;
        this.peerId = isId(peer.id) ? peer.id : fallback;
        this.name = isId(peer.name) ? peer.name : this.peerId;
        if (this.mode === "inspect") {
            this.deviceId = this.sessionId;
            return;
        }
        this.meta = isPlainObject(peer.meta) ? peer.meta : {};
        this.deviceId = isId(frame.deviceId) ? frame.deviceId : this.sessionId;
        const caps = isPlainObject(frame.capabilities) ? frame.capabilities : {};
        this.capabilities = { webrtc: caps.webrtc === true, media: caps.media === true };
    }

    private dispatch(frame: Frame): void {
        if (frame.type === "ping") return this.send({ type: "pong" });
        if (frame.type === "bye") return this.close("client_close");
        if (frame.type === "auth") return this.close("invalid_frame");
        const handler = PEER_HANDLERS[frame.type];
        const known = handler || frame.type === "schema" || frame.type === "query";
        if (!known) return this.close("invalid_frame");
        try {
            if (this.mode === "inspect" && !INSPECTOR_FRAMES.has(frame.type)) {
                throw new P2PError("FORBIDDEN", "Inspector sessions only run schema and query");
            }
            if (frame.type === "schema") {
                const { maxStateBytes, maxConnections, maxChannels } = this.host.config;
                const limits = { maxStateBytes, maxConnections, maxChannels };
                return this.ack(frame, schema(this.ctx, frame, limits) as Record<string, unknown>);
            }
            if (frame.type === "query") return this.ack(frame, { result: query(this.ctx, frame) });
            handler(this.ctx, frame);
        } catch (err) {
            this.fail(frame, err);
        }
    }
}
