// P2PClient: public API, connection lifecycle, frame routing. See docs/4-client/client-api.md.
import { EventEmitter } from "node:events";
import { isRetryable, P2PError, type CloseReason } from "../protocol/errors.ts";
import {
    PROTOCOL_VERSION,
    type Capabilities,
    type ChannelInfo,
    type ConnectedFrame,
    type Frame,
    type Mode,
    type PeerInfo,
    type Role,
    type Target,
    type Transport,
} from "../protocol/types.ts";
import type { Channel } from "./channel.ts";
import { ChannelSet, requireChannelId, type SubscribeOptions } from "./channels.ts";
import { Connection, type Dialer } from "./connection.ts";
import { socketOf, type ClientContext } from "./context.ts";
import { Messaging } from "./messaging.ts";
import { PeerTable } from "./peers.ts";
import { routeFrame } from "./router.ts";
import type { P2PClientEvents } from "./events.ts";
import { LinkManager, type LinkTiming } from "./webrtc.ts";
import { createLinkHost, detectCapabilities, linkEligible, randomId } from "./wiring.ts";

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
     * Username: decides the role (`admin`, `rw`, or `ro` which cannot create or delete channels).
     * Optional against a Server in open mode (no password configured), which accepts everyone as `rw`.
     */
    user?: string;
    /** Password of `user`. Optional in open mode. */
    password?: string;
    /** `"peer"` (default) takes part; `"inspect"` is an invisible session for `getSchema` / `query` only. */
    mode?: Mode;
    /**
     * Who this peer is. `id` is the user's identity (e.g. the authenticated user id) and is shared by
     * all of that user's devices; it defaults to the sessionId. `meta` is this device's global presence.
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
    /** Link deadlines: 15 s open deadline, 30 s retry delay, 10 s idle close. Tests only. */
    timing?: Partial<LinkTiming>;
};

/**
 * The client driver: one control socket to the Server, WebRTC links to the peers it shares a
 * channel with when the environment has them. Create it with `await P2PClient.connect(options)`.
 *
 * - Presence: `getActivePeers`, `getPeers`, `getPeer`, `updatePresence`, `peer:*` events.
 * - Channels: `getChannels`, `getSubscribers`, `subscribe` (a `Channel`: broadcasts, shared
 *   state, channel presence, media), `createChannel`, `deleteChannel`, `channel:*` events.
 * - Direct messages: `send`, `request`, and the `message` event (with `event.reply`).
 *
 * A peer is one device of one user: the same `peerId` can appear several times. Errors are
 * `P2PError` with a `code` such as `CHANNEL_NOT_FOUND`, `PEER_NOT_FOUND` or `TIMEOUT`.
 */
export class P2PClient extends EventEmitter<P2PClientEvents> implements ClientContext {
    /** This connection; changes on every reconnect. */
    sessionId = "";
    /** The user's identity (from `peer.id`, else the first sessionId); kept across reconnects. */
    peerId = "";
    /** This Client instance; kept across reconnects. */
    deviceId: string;
    /** `"admin"`, `"rw"` or `"ro"` (cannot create channels). May change on reconnect (`role:changed`). */
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
    messaging: Messaging;
    /** @internal */
    channelSet: ChannelSet;
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
        this.channelSet = new ChannelSet(this);
    }

    /**
     * Connects. Resolves once peers and channels are loaded, so `getActivePeers()` and
     * `getChannels()` are usable immediately. Rejects with `P2PError` (`AUTH_FAILED`,
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
        const channels = [...this.channelSet.subscribed.keys()].sort();
        return {
            peerId,
            sessionId,
            deviceId,
            name,
            meta,
            role,
            capabilities,
            channels,
            connectedAt,
        };
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
        return linkEligible(
            this.options.mode,
            this.capabilities,
            peer,
            this.channelSet.shares(peer)
        );
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

    /**
     * Replaces this device's global `meta` (and `name`); fires `peer:updated` on every peer. Keep
     * it small: per-channel information belongs in `channel.updatePresence`.
     */
    async updatePresence(
        meta: Record<string, unknown>,
        opts: { name?: string } = {}
    ): Promise<void> {
        await socketOf(this).request({ type: "presence", meta, name: opts.name });
        this.meta = meta;
        if (opts.name) this.name = opts.name;
    }

    // channels

    /** Every channel on the Server, subscribed or not. */
    getChannels(): ChannelInfo[] {
        return [...this.channelSet.list.values()];
    }

    /** The devices subscribed to a channel (from global presence; no subscription needed). */
    getSubscribers(channel: string): PeerInfo[] {
        return this.channelSet.subscribersOf(channel);
    }

    /** The subscribed Channel with this id, if any. */
    channel(id: string): Channel | undefined {
        return this.channelSet.subscribed.get(id);
    }

    /**
     * Subscribes to a channel and resolves once its subscribers and state are loaded. `create`
     * makes a missing channel (`rw` / `admin`); `meta` is this device's channel presence. Rejects
     * `CHANNEL_NOT_FOUND`, `FORBIDDEN`, `CHANNEL_LIMIT`, `INVALID_CHANNEL`, `DISCONNECTED`.
     */
    subscribe(id: string, opts: SubscribeOptions = {}): Promise<Channel> {
        return this.channelSet.subscribe(id, opts);
    }

    /** Creates a channel without subscribing (`rw` / `admin`); `created: false` when it existed. */
    async createChannel(id: string): Promise<{ created: boolean; channel: ChannelInfo }> {
        requireChannelId(id);
        if (this.role === "ro") throw new P2PError("FORBIDDEN", "Role ro cannot create channels");
        return this.query({ operation: "createChannel", channel: id });
    }

    /** Deletes a channel and its state for everyone (`rw` / `admin`). */
    async deleteChannel(id: string): Promise<void> {
        requireChannelId(id);
        if (this.role === "ro") throw new P2PError("FORBIDDEN", "Role ro cannot delete channels");
        await this.query({ operation: "deleteChannel", channel: id });
    }

    // direct messages

    /**
     * Sends `data` to a target: a peerId string or `{ peerId }` (every device of that user) or
     * `{ sessionId }` (one device), whatever its channels. Rejects `PEER_NOT_FOUND` when nobody
     * matches. `{ ephemeral: true }`: unordered, may be dropped, no acknowledgement.
     */
    send(target: Target, data: unknown, opts: { ephemeral?: boolean } = {}): Promise<void> {
        return this.messaging.send(target, data, opts.ephemeral === true);
    }

    /**
     * Asks one device and resolves with its `event.reply(...)` value. A peerId target goes to that
     * user's most recently connected device; `{ sessionId }` to that device. Rejects `TIMEOUT`
     * (default 10 s), `PEER_LEFT`, `PEER_NOT_FOUND`, `REPLY_ERROR`.
     */
    request(target: Target, data: unknown, opts: { timeoutMs?: number } = {}): Promise<any> {
        const timeout = opts.timeoutMs ?? this.options.requestTimeoutMs ?? 10_000;
        return this.messaging.request(target, data, timeout);
    }

    // transports, inspection

    /** How frames currently reach that device: `"webrtc"` (direct link) or `"socket"` (relayed). */
    getTransport(sessionId: string): Transport {
        return this.messaging.transportTo(sessionId);
    }

    /**
     * What the Server holds: peers, links, channels, storage, limits, counters. With a channel id:
     * that channel's subscribers and keys. Any role, no subscription needed.
     */
    async getSchema(channel?: string): Promise<Record<string, any>> {
        const frame = channel === undefined ? { type: "schema" } : { type: "schema", channel };
        const { type, reqId, ...schema } = await socketOf(this).request(frame);
        return schema;
    }

    /**
     * One-round-trip reads and writes without subscribing: `{ operation: "peers" | "channels" |
     * "createChannel" | "deleteChannel" | "getState" | "setState" | "deleteState" | "clearState" |
     * "broadcast" | "send", channel?, ... }`. Creating and deleting channels need rw/admin.
     */
    async query(q: { operation: string; [field: string]: unknown }): Promise<any> {
        const ack = await socketOf(this).request({ ...q, type: "query" });
        return ack.result;
    }

    /** Disconnects cleanly (peers see `client_close`) and stops reconnecting. */
    async close(): Promise<void> {
        this.closing = true;
        clearTimeout(this.sleepTimer);
        this.links?.closeAll();
        this.channelSet.pause();
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
        const channels = c.channels ?? [];
        const known = this.channelSet.load(channels, c.limits?.maxChannelsPerSession);
        if (reconnect) {
            const now = new Set(c.peers.map((p) => p.sessionId));
            const old = new Set(before.map((p) => p.sessionId));
            for (const p of before)
                if (!now.has(p.sessionId)) this.emit("peer:left", p, "connection_lost");
            for (const p of c.peers) if (!old.has(p.sessionId)) this.emit("peer:joined", p, {});
            const ids = new Set(channels.map((ch) => ch.id));
            for (const id of known)
                if (!ids.has(id)) this.emit("channel:deleted", { channel: id, by: "" });
            for (const ch of channels) if (!known.includes(ch.id)) this.emit("channel:created", ch);
            if (previousRole !== c.role)
                this.emit("role:changed", { role: c.role, previous: previousRole });
        }
        if (this.capabilities.webrtc && this.options.mode !== "inspect") {
            const timing = {
                openTimeoutMs: 15_000,
                retryDelayMs: 30_000,
                idleCloseMs: 10_000,
                ...this.options.timing,
            };
            this.links ??= new LinkManager(createLinkHost(this), timing);
        }
    }

    /** @internal Frames from the Server (transport "socket") or from a link. */
    onFrame(frame: Frame, transport: Transport, linkFrom?: string): void {
        routeFrame(this, frame, transport, linkFrom);
    }

    private onClosed(reason: CloseReason, conn: Connection): void {
        if (conn !== this.conn || this.closing) return;
        this.links?.closeAll();
        this.messaging.rpc.rejectAll("DISCONNECTED");
        this.channelSet.pause();
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
                await this.channelSet.resubscribe();
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
