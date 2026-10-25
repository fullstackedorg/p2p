// P2PClient: public API, connection lifecycle, frame routing. See docs/4-client/client-api.md.
import { EventEmitter } from "node:events";
import { isRetryable, P2PError, type CloseReason } from "../protocol/errors.ts";
import {
    PROTOCOL_VERSION,
    type Capabilities,
    type ConnectedFrame,
    type Frame,
    type Mode,
    type PeerInfo,
    type Role,
    type Target,
    type Transport,
} from "../protocol/types.ts";
import { Connection, type Dialer } from "./connection.ts";
import { requireWriter, socketOf, type ClientContext } from "./context.ts";
import { MediaFallback } from "./media-fallback.ts";
import { Messaging } from "./messaging.ts";
import { PeerTable } from "./peers.ts";
import { routeFrame } from "./router.ts";
import type { P2PClientEvents } from "./events.ts";
import { SharedState, type WriteResult } from "./state.ts";
import { LinkManager, type LinkTiming } from "./webrtc.ts";
import {
    createLinkHost,
    createMediaHost,
    detectCapabilities,
    linkEligible,
    randomId,
} from "./wiring.ts";

/** Fields `beforeConnect` may override for one connection attempt. */
export type ConnectionOverrides = Partial<{
    host: string;
    port: number;
    user: string;
    password: string;
}>;

/** Options of `P2PClient.connect`. Only `host` is required (plus `user` / `password` on a secured Server). */
export type ClientOptions = {
    /** Server host: anything `node:net` can reach (native in Node.js, the runtime's in FullStacked). */
    host: string;
    /** Server port. Default 4444. */
    port?: number;
    /**
     * Username: decides the role (`admin`, `rw` or read-only `ro`). Optional against a Server in
     * open mode (no password configured), which accepts everyone as `rw`.
     */
    user?: string;
    /** Password of `user`. Optional in open mode. */
    password?: string;
    /** `"peer"` (default) joins the room; `"inspect"` is an invisible session for `getSchema` / `query` only. */
    mode?: Mode;
    /**
     * Who this peer is. `id` is the user's identity (e.g. the authenticated user id) and is shared by
     * all of that user's devices; it defaults to the sessionId. `meta` is this device's presence.
     */
    peer?: { id?: string; name?: string; meta?: Record<string, unknown> };
    /**
     * This Client instance. Default: random per P2PClient, kept across reconnects. Two live clients
     * with the same `peer.id` and `deviceId` replace each other, so never share one between tabs.
     */
    deviceId?: string;
    /** Called before the first connection and every reconnect; returned fields override the options. */
    beforeConnect?: (info: {
        attempt: number;
        reason: CloseReason | null;
    }) => ConnectionOverrides | Promise<ConnectionOverrides>;
    /** `false` forces socket-only; `{ iceServers }` overrides the Server's ICE servers. Default: auto. */
    webrtc?: boolean | { iceServers?: RTCIceServer[] };
    /** `false` disables reconnection. Default `{ initialDelayMs: 1000, maxDelayMs: 30000 }`. */
    reconnect?: boolean | { initialDelayMs?: number; maxDelayMs?: number };
    /** TCP connect plus handshake deadline per attempt. Default 10000. */
    connectTimeoutMs?: number;
    /** Default `request()` timeout. Default 10000. */
    requestTimeoutMs?: number;
    /** Replaces how the control socket is opened (tests, custom transports). Default `node:net`. */
    connect?: Dialer;
    /** Link deadlines; the defaults are the spec's 15 s open deadline and 30 s retry delay. Tests only. */
    timing?: Partial<LinkTiming>;
};

/**
 * The client driver: one control socket to the Server, WebRTC links to other peers when the
 * environment has them. Create it with `await P2PClient.connect(options)`.
 *
 * - Presence: `getActivePeers`, `getPeers`, `getPeer`, `updatePresence`, `peer:*` events.
 * - Messaging: `broadcast`, `send`, `request`, and the `message` event (with `event.reply`).
 * - Shared state: `getState`, `setState`, `deleteState`, `clearState`, `state:changed`.
 * - Media: `shareMedia`, `stopMedia`, `peer:media` (FullStacked webview only).
 *
 * A peer is one device of one user: the same `peerId` can appear several times. Errors are
 * `P2PError` with a `code` such as `READ_ONLY`, `PEER_NOT_FOUND` or `TIMEOUT`.
 */
export class P2PClient extends EventEmitter<P2PClientEvents> implements ClientContext {
    /** This connection; changes on every reconnect. */
    sessionId = "";
    /** The user's identity (from `peer.id`, else the first sessionId); kept across reconnects. */
    peerId = "";
    /** This Client instance; kept across reconnects. */
    deviceId: string;
    /** `"admin"`, `"rw"` or `"ro"` (read-only). May change on reconnect (`role:changed`). */
    role: Role = "ro";
    /** What this environment supports: `webrtc` (links) and `media` (shareMedia). */
    capabilities: Capabilities;
    /** When this session was established (epoch ms). */
    connectedAt = 0;
    /** @internal */
    peers = new PeerTable();
    /** @internal */
    links: LinkManager | null = null;
    /** @internal */
    conn: Connection | null = null;
    /** @internal */
    iceServers: RTCIceServer[] = [];
    /** @internal */
    sharedStream: MediaStream | null = null;
    /** @internal */
    messaging: Messaging;
    /** @internal */
    state: SharedState;
    /** @internal */
    media: MediaFallback | null;
    private options: ClientOptions;
    private meta: Record<string, unknown>;
    private name = "";
    private seq = 0;
    private closing = false;
    private finished = false;
    private sleepTimer: any = null;

    private constructor(options: ClientOptions) {
        super();
        this.options = options;
        this.deviceId = options.deviceId ?? randomId();
        this.meta = options.peer?.meta ?? {};
        this.capabilities = detectCapabilities(options.webrtc);
        this.messaging = new Messaging(this);
        this.state = new SharedState(this);
        this.media = this.capabilities.media ? new MediaFallback(createMediaHost(this)) : null;
    }

    /**
     * Connects and joins the room. Resolves once peers and state are loaded, so `getActivePeers()`
     * and `getState()` are usable immediately. Rejects with `P2PError` (`AUTH_FAILED`,
     * `SERVER_FULL`, `TIMEOUT`, `DISCONNECTED`); the first connection is not retried.
     */
    static async connect(options: ClientOptions): Promise<P2PClient> {
        const client = new P2PClient(options);
        await client.establish(0, null);
        return client;
    }

    /** True while the control socket is authenticated. */
    get connected(): boolean {
        return !this.finished && this.conn?.isOpen === true;
    }

    /** This session's own PeerInfo. */
    get self(): PeerInfo {
        const { peerId, sessionId, deviceId, name, meta, role, capabilities, connectedAt } = this;
        return { peerId, sessionId, deviceId, name, meta, role, capabilities, connectedAt };
    }

    /** @internal */
    nextMsgId(): string {
        return `${this.sessionId}:${++this.seq}`;
    }

    /** @internal */
    emitError(err: unknown): void {
        if (this.listenerCount("error") > 0) this.emit("error", err as Error);
    }

    /** @internal */
    eligible(peer: PeerInfo): boolean {
        return linkEligible(this.options.mode, this.role, this.capabilities, peer);
    }

    // presence

    /** Every other peer (one entry per device), including the local user's other devices. */
    getActivePeers(): PeerInfo[] {
        return this.peers.all();
    }

    /** All devices of one user (never this session). `getPeers(p2p.peerId)`: my other devices. */
    getPeers(peerId: string): PeerInfo[] {
        return this.peers.ofUser(peerId);
    }

    /** One device by sessionId. */
    getPeer(sessionId: string): PeerInfo | undefined {
        return this.peers.get(sessionId);
    }

    /** Replaces this device's `meta` (and `name`); fires `peer:updated` on the others. `READ_ONLY` for ro. */
    async updatePresence(
        meta: Record<string, unknown>,
        opts: { name?: string } = {}
    ): Promise<void> {
        requireWriter(this);
        await socketOf(this).request({ type: "presence", meta, name: opts.name });
        this.meta = meta;
        if (opts.name) this.name = opts.name;
    }

    // messaging and state

    /**
     * Sends `data` (any JSON value) to every other peer. `{ ephemeral: true }` for high-frequency
     * updates (cursors): unordered, may be dropped, resolves without an acknowledgement.
     */
    broadcast(data: unknown, opts: { ephemeral?: boolean } = {}): Promise<void> {
        return this.messaging.broadcast(data, opts.ephemeral === true);
    }

    /**
     * Sends `data` to a target: a peerId string or `{ peerId }` (every device of that user) or
     * `{ sessionId }` (one device). Rejects `PEER_NOT_FOUND` when nobody matches.
     */
    send(target: Target, data: unknown, opts: { ephemeral?: boolean } = {}): Promise<void> {
        return this.messaging.send(target, data, opts.ephemeral === true);
    }

    /**
     * Asks one device and resolves with its `event.reply(...)` value. A peerId target goes to that
     * user's most recently connected device; `{ sessionId }` to that device. Rejects `TIMEOUT`
     * (default 10 s), `PEER_LEFT`, `PEER_NOT_FOUND`, `TARGET_READ_ONLY`, `REPLY_ERROR`.
     */
    request(target: Target, data: unknown, opts: { timeoutMs?: number } = {}): Promise<any> {
        const timeout = opts.timeoutMs ?? this.options.requestTimeoutMs ?? 10_000;
        return this.messaging.request(target, data, timeout);
    }

    /** The shared state: every live key, or one key's value (`undefined` when missing). */
    getState(): Record<string, unknown>;
    getState(key: string): unknown;
    getState(key?: string): unknown {
        return key === undefined ? this.state.replica.values() : this.state.replica.get(key);
    }

    /**
     * Writes a key (1-256 characters, any JSON value) for everyone, persisted by the Server.
     * Applies locally first; resolves `{ applied: false }` when a concurrent newer write won.
     * Rejects `READ_ONLY`, `STATE_TOO_LARGE`, `PAYLOAD_TOO_LARGE`, `INVALID_ARGUMENT`, `DISCONNECTED`.
     */
    setState(key: string, value: unknown): Promise<WriteResult> {
        return this.state.set(key, value);
    }

    /** Deletes a key for everyone. Same results as `setState`. */
    deleteState(key: string): Promise<WriteResult> {
        return this.state.delete(key);
    }

    /** Deletes every key for everyone; resolves with how many keys the Server cleared. */
    clearState(): Promise<{ applied: boolean; count: number }> {
        return this.state.clear();
    }

    // media, transports, inspection

    /**
     * Shares a MediaStream with every peer (tracks over links, recorded chunks over the socket for
     * the others). One stream per client: calling it again replaces it. `UNSUPPORTED` outside a
     * browser engine (Node.js, FullStacked CLI); `READ_ONLY` for spectators.
     */
    async shareMedia(stream: MediaStream): Promise<void> {
        if (!this.media) throw new P2PError("UNSUPPORTED", "Media is not available here");
        requireWriter(this);
        this.sharedStream = stream;
        this.links?.refreshTracks();
        this.media.share(stream);
    }

    /** Stops sharing; peers get `peer:media:ended`. */
    async stopMedia(): Promise<void> {
        this.sharedStream = null;
        this.links?.refreshTracks();
        this.media?.share(null);
    }

    /** How frames currently reach that device: `"webrtc"` (direct link) or `"socket"` (relayed). */
    getTransport(sessionId: string): Transport {
        return this.messaging.transportTo(sessionId);
    }

    /** The room seen by the Server: peers, links, state keys, storage, limits, counters. Any role. */
    async getSchema(): Promise<Record<string, any>> {
        const { type, reqId, ...schema } = await socketOf(this).request({ type: "schema" });
        return schema;
    }

    /**
     * One-round-trip reads and writes without a replica: `{ operation: "peers" | "getState" |
     * "setState" | "deleteState" | "clearState" | "broadcast" | "send", ... }`. Writes need rw/admin.
     */
    async query(q: { operation: string; [field: string]: unknown }): Promise<any> {
        const ack = await socketOf(this).request({ ...q, type: "query" });
        return ack.result;
    }

    /** Leaves the room cleanly (peers see `client_close`) and stops reconnecting. */
    async close(): Promise<void> {
        this.closing = true;
        clearTimeout(this.sleepTimer);
        this.links?.closeAll();
        this.media?.reset();
        await this.conn?.close();
        this.finish("client_close");
    }

    // lifecycle

    private async establish(attempt: number, reason: CloseReason | null): Promise<void> {
        const o = { ...this.options, ...(await this.options.beforeConnect?.({ attempt, reason })) };
        const peer = {
            ...this.options.peer,
            id: this.peerId || this.options.peer?.id,
            meta: this.meta,
        };
        if (this.name) peer.name = this.name;
        const auth: Frame = {
            type: "auth",
            version: PROTOCOL_VERSION,
            user: o.user ?? "",
            password: o.password ?? "",
            mode: this.options.mode ?? "peer",
            peer,
            deviceId: this.deviceId,
            capabilities: this.capabilities,
        };
        const timeout = this.options.connectTimeoutMs ?? 10_000;
        const { conn, connected } = await Connection.open(
            o.host,
            o.port ?? 4444,
            auth,
            timeout,
            o.connect
        );
        if (this.closing) {
            await conn.close();
            throw new P2PError("CLOSED", "Client closed");
        }
        this.conn = conn;
        this.apply(connected, attempt > 0);
        conn.attach((frame) => this.onFrame(frame, "socket"));
        conn.once("closed", (r: CloseReason) => this.onClosed(r, conn));
    }

    private apply(c: ConnectedFrame, reconnect: boolean): void {
        const previousRole = this.role;
        Object.assign(this, { sessionId: c.sessionId, peerId: c.peerId, role: c.role });
        this.connectedAt = Date.now();
        if (!this.name) this.name = this.options.peer?.name ?? c.peerId;
        const custom =
            typeof this.options.webrtc === "object" ? this.options.webrtc.iceServers : undefined;
        this.iceServers = custom ?? ((c.iceServers ?? []) as RTCIceServer[]);
        const before = this.peers.all();
        this.peers.load(c.peers ?? []);
        if (reconnect) {
            const now = new Set(c.peers.map((p) => p.sessionId));
            const old = new Set(before.map((p) => p.sessionId));
            for (const p of before)
                if (!now.has(p.sessionId)) this.emit("peer:left", p, "connection_lost");
            for (const p of c.peers) if (!old.has(p.sessionId)) this.emit("peer:joined", p, {});
            if (previousRole !== c.role)
                this.emit("role:changed", { role: c.role, previous: previousRole });
            this.state.reload(c.state, c.clock);
        } else this.state.replica.load(c.state, c.clock);
        if (this.capabilities.webrtc && this.options.mode !== "inspect") {
            const timing = { openTimeoutMs: 15_000, retryDelayMs: 30_000, ...this.options.timing };
            this.links ??= new LinkManager(createLinkHost(this), timing);
            for (const p of this.peers.all())
                if (this.eligible(p)) this.links.consider(p.sessionId);
        }
        this.media?.update(true);
    }

    /** @internal Frames from the Server (transport "socket") or from a link. */
    onFrame(frame: Frame, transport: Transport, linkFrom?: string): void {
        routeFrame(this, frame, transport, linkFrom);
    }

    private onClosed(reason: CloseReason, conn: Connection): void {
        if (conn !== this.conn || this.closing) return;
        this.links?.closeAll();
        this.messaging.rpc.rejectAll("DISCONNECTED");
        this.media?.reset();
        const retryAuth = reason === "auth_failed" && !!this.options.beforeConnect;
        if (this.options.reconnect === false || (!isRetryable(reason) && !retryAuth)) {
            return this.finish(reason);
        }
        this.emit("disconnected", { reason });
        void this.reconnectLoop(reason);
    }

    private async reconnectLoop(reason: CloseReason): Promise<void> {
        const r = typeof this.options.reconnect === "object" ? this.options.reconnect : {};
        const initial = r.initialDelayMs ?? 1000;
        const max = r.maxDelayMs ?? 30_000;
        for (let attempt = 1; !this.closing; attempt++) {
            const cap = Math.min(max, initial * 2 ** (attempt - 1));
            await new Promise(
                (resolve) => (this.sleepTimer = setTimeout(resolve, Math.random() * cap))
            );
            if (this.closing) return;
            try {
                await this.establish(attempt, reason);
                this.emit("reconnected", { sessionId: this.sessionId });
                return;
            } catch (err: any) {
                const r = err?.reason as CloseReason | undefined;
                const retryAuth = r === "auth_failed" && !!this.options.beforeConnect;
                if (r && !isRetryable(r) && !retryAuth) return this.finish(r);
                if (r) reason = r;
            }
        }
    }

    private finish(reason: CloseReason): void {
        if (this.finished) return;
        this.finished = true;
        this.links?.closeAll();
        this.messaging.rpc.rejectAll("CLOSED");
        this.emit("close", { reason });
    }
}
