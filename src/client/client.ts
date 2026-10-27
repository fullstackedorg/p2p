// P2PClient: public API, connection lifecycle, frame routing. See docs/4-client/client-api.md.
export type {
    ChannelStats,
    ClientOptions,
    ConnectionOverrides,
    PeekOptions,
    PeekResult,
} from "./options.ts";
import { EventEmitter } from "node:events";
import { isRetryable, P2PError, type CloseReason } from "../protocol/errors.ts";
import {
    LIMITS,
    PROTOCOL_VERSION,
    mergeMeta,
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
import { ChannelSet, type SubscribeOptions } from "./channels.ts";
import { Connection } from "./connection.ts";
import { socketOf, type ClientContext } from "./context.ts";
import { Messaging } from "./messaging.ts";
import { PeerTable } from "./peers.ts";
import { reportReconnect, routeFrame } from "./router.ts";
import type { P2PClientEvents } from "./events.ts";
import type { ChannelStats, ClientOptions, PeekOptions, PeekResult } from "./options.ts";
import type { LinkManager } from "./webrtc.ts";
import type { Watch } from "./watch.ts";
import {
    createLinks,
    detectCapabilities,
    detectDeviceLabel,
    linkEligible,
    randomId,
} from "./wiring.ts";

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
    /** This device for people (`"MacBook"`); `""` when unknown. */
    deviceLabel: string;
    /** `"peer"` or `"inspect"`. */
    readonly mode: Mode;
    /** @internal */
    readonly liveTtlMs: number;
    private requestedLabel: string;
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
        this.deviceLabel = options.deviceLabel ?? detectDeviceLabel();
        this.requestedLabel = this.deviceLabel;
        this.liveTtlMs = options.timing?.liveTtlMs ?? LIMITS.liveTtlMs;
        this.mode = options.mode ?? "peer";
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
        const { peerId, sessionId, deviceId, deviceLabel, name, meta, role } = this;
        const { capabilities, connectedAt } = this;
        const channels = [...this.channelSet.subscribed.keys()].sort();
        return {
            peerId,
            sessionId,
            deviceId,
            deviceLabel,
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
     * Replaces this device's global `meta` (and `name`), or patches it with `merge` (`null`
     * removes a key); fires `peer:updated` on every peer. Keep it small: per-channel information
     * belongs in `channel.updatePresence`.
     */
    async updatePresence(
        meta: Record<string, unknown>,
        opts: { name?: string; merge?: boolean } = {}
    ): Promise<void> {
        const frame: Frame = { type: "presence", meta, name: opts.name };
        if (opts.merge) frame.merge = true;
        await socketOf(this).request(frame);
        this.meta = opts.merge ? mergeMeta(this.meta, meta) : meta;
        if (opts.name) this.name = opts.name;
    }

    // channels

    /** Every channel on the Server, subscribed or not, with its `meta`. */
    getChannels(): ChannelInfo[] {
        return [...this.channelSet.list.values()];
    }

    /**
     * The devices subscribed to a channel, from global presence: no subscription needed. Leaves
     * out this device unless `includeSelf` (and this device is subscribed).
     */
    getSubscribers(channel: string, opts: { includeSelf?: boolean } = {}): PeerInfo[] {
        return this.channelSet.subscribersOf(channel, opts.includeSelf === true);
    }

    /**
     * One page of a channel's live entries without subscribing, with its stats (`keyCount`,
     * `lastWriteAt`, ...). Does not count toward the channel limit. Rejects `CHANNEL_NOT_FOUND`.
     */
    peek(channel: string, opts?: PeekOptions): Promise<PeekResult>;
    peek(channels: string[], opts?: PeekOptions): Promise<Record<string, PeekResult>>;
    peek(target: string | string[], opts: PeekOptions = {}): Promise<any> {
        return this.channelSet.peek(target, opts);
    }

    /** Stats of many channels in one round trip: `{ ids }`, `{ prefix }`, or every channel. */
    getChannelStats(filter: { ids?: string[]; prefix?: string } = {}) {
        return this.channelSet.stats(filter);
    }

    /** Pushes `channel:stats` after writes in the channels starting with prefix (≤ 1/s each). */
    followStats(prefix: string): Promise<Record<string, ChannelStats>> {
        return this.channelSet.followStats(prefix);
    }

    /** Stops `followStats(prefix)`. */
    unfollowStats(prefix: string): Promise<void> {
        return this.channelSet.unfollowStats(prefix);
    }

    /** Whether the Server would allow this session to create, change or delete (a) channel. */
    can(action: "createChannel" | "updateChannel" | "deleteChannel", channel?: string): boolean {
        return this.channelSet.can(action, channel);
    }

    /** The subscribed Channel with this id, if any. */
    channel(id: string): Channel | undefined {
        return this.channelSet.subscribed.get(id);
    }

    /**
     * Subscribes to a channel and resolves once its subscribers and state are loaded. `create`
     * makes a missing channel (`rw` / `admin`); `meta` is this device's channel presence;
     * `replace` leaves a subscribed channel in the same step. Rejects `CHANNEL_NOT_FOUND`,
     * `FORBIDDEN`, `CHANNEL_LIMIT`, `INVALID_CHANNEL`, `NOT_SUBSCRIBED`, `DISCONNECTED`.
     * Inspector sessions subscribe invisibly, without limit, and cannot write.
     */
    subscribe(id: string, opts: SubscribeOptions = {}): Promise<Channel> {
        return this.channelSet.subscribe(id, opts);
    }

    /**
     * Inspector sessions only: every channel whose id starts with `prefix`, now and later. Emits
     * `activity`; no state (read it with `peek`). Rejects `FORBIDDEN` on a peer session.
     */
    watch(prefix: string): Promise<Watch> {
        return this.channelSet.watch(prefix);
    }

    /**
     * Creates a channel without subscribing (`rw` / `admin`), with its `meta` (up to 4 KiB of
     * JSON); `created: false` when it existed.
     */
    createChannel(
        id: string,
        opts: { meta?: Record<string, unknown> } = {}
    ): Promise<{ created: boolean; channel: ChannelInfo }> {
        return this.channelSet.create(id, opts.meta);
    }

    /** Patches a channel's `meta` (`null` removes a key); everyone gets `channel:updated`. */
    updateChannelMeta(id: string, patch: Record<string, unknown>): Promise<ChannelInfo> {
        return this.channelSet.updateMeta(id, patch);
    }

    /** Deletes a channel, its state and its `meta` for everyone: its creator or an `admin`. */
    deleteChannel(id: string): Promise<void> {
        return this.channelSet.remove(id);
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
        const peer = { ...o.peer, id: this.peerId || o.peer?.id, meta: this.meta };
        if (this.name) peer.name = this.name;
        const { mode, deviceId, requestedLabel: deviceLabel, capabilities } = this;
        const credentials = { user: o.user ?? "", password: o.password ?? "" };
        const auth: Frame = { type: "auth", version: PROTOCOL_VERSION, ...credentials, mode };
        Object.assign(auth, { peer, deviceId, deviceLabel, capabilities });
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
        if (typeof c.deviceLabel === "string") this.deviceLabel = c.deviceLabel;
        this.connectedAt = Date.now();
        if (!this.name) this.name = this.options.peer?.name ?? c.peerId;
        const custom =
            typeof this.options.webrtc === "object" ? this.options.webrtc.iceServers : undefined;
        this.iceServers = custom ?? ((c.iceServers ?? []) as RTCIceServer[]);
        const before = this.peers.all();
        this.peers.load(c.peers ?? []);
        const channels = c.channels ?? [];
        const known = this.channelSet.load(channels, c.limits?.maxChannelsPerSession);
        if (reconnect) reportReconnect(this, c, before, known, previousRole);
        if (this.capabilities.webrtc && this.mode !== "inspect")
            this.links ??= createLinks(this, this.options.timing);
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
