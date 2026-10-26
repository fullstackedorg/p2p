// A subscribed channel: subscribers, channel presence, broadcasts, shared state, media.
// See docs/4-client/client-api.md §4.
import { EventEmitter } from "node:events";
import { P2PError, type CloseReason } from "../protocol/errors.ts";
import type { Entry, Frame, PeerInfo, Transport } from "../protocol/types.ts";
import { socketOf } from "./context.ts";
import type { ChannelEvents, Subscriber } from "./events.ts";
import { MediaFallback } from "./media-fallback.ts";
import type { P2PClient } from "./client.ts";
import { SharedState, type WriteResult } from "./state.ts";

/** What a subscribe acknowledgement carries. */
export type SubscribeAck = {
    subscribers: { sessionId: string; meta: Record<string, unknown> }[];
    state: Record<string, Entry>;
    clock: number;
};

/** Why a Channel ended for this client. */
export type ChannelCloseReason = "unsubscribed" | "channel_deleted";

const STATE_FRAMES = new Set([
    "state:set",
    "state:delete",
    "state:clear",
    "state:changed",
    "state:cleared",
]);

/**
 * A channel this client is subscribed to, from `await p2p.subscribe(id)`. Only its subscribers
 * receive what is published in it: broadcasts, shared state, channel presence and media.
 */
export class Channel extends EventEmitter<ChannelEvents> {
    /** The channel id. */
    readonly id: string;
    /** `true` until `unsubscribe()`, the channel's deletion, or a failed resubscribe. */
    subscribed = true;
    /** @internal This session's channel presence. */
    meta: Record<string, unknown>;
    /** @internal */
    state: SharedState;
    /** @internal The stream shared in this channel. */
    stream: MediaStream | null = null;
    /** @internal */
    ready = false;
    private client: P2PClient;
    private subscribers = new Map<string, Record<string, unknown>>();
    /** @internal */
    media: MediaFallback | null;
    private held: [Frame, string, Transport][] = [];
    private withMedia = new Set<string>();

    /** @internal */
    constructor(client: P2PClient, id: string, meta: Record<string, unknown>) {
        super();
        this.client = client;
        this.id = id;
        this.meta = meta;
        this.state = new SharedState(client, {
            id,
            emit: (event, ...args) => this.emit(event as any, ...(args as any)),
            recipients: () => this.peers(),
        });
        this.media = client.capabilities.media
            ? new MediaFallback({
                  sessionId: () => client.sessionId,
                  peers: () => this.peers(),
                  linked: (sid) => client.links?.isOpen(sid) === true,
                  send: (frame) => client.conn?.send({ ...frame, channel: id }),
                  onStream: (from, stream) => this.mediaFrom(from, stream, "socket"),
                  onEnded: () => {},
              })
            : null;
    }

    /** @internal The PeerInfo of every other subscriber. */
    peers(): PeerInfo[] {
        const out: PeerInfo[] = [];
        for (const sid of this.subscribers.keys()) {
            const peer = this.client.peers.get(sid);
            if (peer) out.push(peer);
        }
        return out;
    }

    /** @internal Whether a session is subscribed to this channel. */
    has(sessionId: string): boolean {
        return this.subscribers.has(sessionId);
    }

    /** Every other subscriber (one per device, own devices included) with its channel presence. */
    getSubscribers(): Subscriber[] {
        return this.peers().map((peer) => ({ peer, meta: this.subscribers.get(peer.sessionId)! }));
    }

    /** Replaces this device's channel presence; only this channel's subscribers see it. */
    async updatePresence(meta: Record<string, unknown>): Promise<void> {
        this.requireSubscribed();
        await socketOf(this.client).request({ type: "channel:presence", channel: this.id, meta });
        this.meta = meta;
    }

    /**
     * Sends `data` (any JSON value) to every other subscriber. `{ ephemeral: true }` for
     * high-frequency updates (cursors): unordered, may be dropped, resolves without an ack.
     */
    async broadcast(data: unknown, opts: { ephemeral?: boolean } = {}): Promise<void> {
        this.requireSubscribed();
        return this.client.messaging.broadcast(
            this.id,
            this.peers(),
            data,
            opts.ephemeral === true
        );
    }

    /** The channel's shared state: every live key, or one key's value (`undefined` when missing). */
    getState(): Record<string, unknown>;
    getState(key: string): unknown;
    getState(key?: string): unknown {
        return key === undefined ? this.state.replica.values() : this.state.replica.get(key);
    }

    /**
     * Writes a key (1-256 characters, any JSON value) for every subscriber, persisted by the
     * Server. Applies locally first; resolves `{ applied: false }` when a concurrent newer write
     * won. Rejects `STATE_TOO_LARGE`, `PAYLOAD_TOO_LARGE`, `INVALID_ARGUMENT`, `NOT_SUBSCRIBED`.
     */
    async setState(key: string, value: unknown): Promise<WriteResult> {
        this.requireSubscribed();
        return this.state.set(key, value);
    }

    /** Deletes a key for every subscriber. Same results as `setState`. */
    async deleteState(key: string): Promise<WriteResult> {
        this.requireSubscribed();
        return this.state.delete(key);
    }

    /** Deletes every key of the channel; resolves with how many keys the Server cleared. */
    async clearState(): Promise<{ applied: boolean; count: number }> {
        this.requireSubscribed();
        return this.state.clear();
    }

    /**
     * Shares a MediaStream with the channel's media-capable subscribers (tracks over links,
     * recorded chunks over the socket for the others). One stream per channel: calling it again
     * replaces it. `UNSUPPORTED` outside a browser engine (Node.js, FullStacked CLI).
     */
    async shareMedia(stream: MediaStream): Promise<void> {
        if (!this.media) throw new P2PError("UNSUPPORTED", "Media is not available here");
        this.requireSubscribed();
        this.stream = stream;
        this.client.links?.refreshTracks();
        this.media.share(stream);
    }

    /** Stops sharing; subscribers get `media:ended`. */
    async stopMedia(): Promise<void> {
        this.stream = null;
        this.client.links?.refreshTracks();
        this.media?.share(null);
    }

    /** Leaves the channel: its state is dropped and nothing more arrives from it. */
    async unsubscribe(): Promise<void> {
        if (!this.subscribed) return;
        this.end("unsubscribed");
        try {
            await socketOf(this.client).request({ type: "unsubscribe", channel: this.id });
        } catch (err) {
            if ((err as P2PError).code !== "DISCONNECTED") throw err;
        }
    }

    /** @internal Applies a subscribe ack: first load, or a resubscribe after a reconnect. */
    load(ack: SubscribeAck, resubscribe: boolean): void {
        const before = new Map(this.subscribers);
        this.subscribers = new Map(ack.subscribers.map((s) => [s.sessionId, s.meta]));
        if (resubscribe) {
            for (const [sid, meta] of before)
                if (!this.subscribers.has(sid)) this.left(sid, meta, "connection_lost");
            for (const [sid] of this.subscribers) if (!before.has(sid)) this.joined(sid);
            this.state.reload(ack.state, ack.clock);
        } else this.state.replica.load(ack.state, ack.clock);
        this.ready = true;
        for (const [frame, from, transport] of this.held.splice(0))
            this.handle(frame, from, transport);
        this.media?.update(true);
    }

    /** @internal A frame for this channel, from the Server or a link. */
    handle(frame: Frame, from: string, transport: Transport): void {
        if (!this.subscribed) return;
        if (!this.ready) return void this.held.push([frame, from, transport]);
        if (frame.type === "broadcast")
            return void this.client.messaging.handle(frame, from, transport, this);
        if (STATE_FRAMES.has(frame.type)) return this.state.handle(frame, from, transport);
        switch (frame.type) {
            case "subscriber:joined":
                this.subscribers.set(frame.sessionId, frame.meta ?? {});
                return this.joined(frame.sessionId);
            case "subscriber:updated": {
                this.subscribers.set(frame.sessionId, frame.meta ?? {});
                const peer = this.client.peers.get(frame.sessionId);
                if (peer) this.emit("subscriber:updated", { peer, meta: frame.meta ?? {} });
                return;
            }
            case "subscriber:left": {
                const meta = this.subscribers.get(frame.sessionId);
                if (!meta) return;
                this.subscribers.delete(frame.sessionId);
                return this.left(frame.sessionId, meta, frame.reason);
            }
            case "media:chunk":
                return this.media?.onChunk(from, frame);
            case "media:end":
                this.media?.onEnd(from, frame.streamId);
                return this.mediaEnded(from);
            case "media:resync":
                return this.media?.onResync(frame.streamId);
        }
    }

    /** @internal A remote stream for this channel (tracks on a link, or rebuilt from chunks). */
    mediaFrom(from: string, stream: MediaStream, transport: Transport): void {
        const peer = this.client.peers.get(from);
        if (!peer || !this.subscribed) return;
        this.withMedia.add(from);
        this.emit("media", { peer, stream, transport });
    }

    /** @internal The control socket dropped: fallback media stops until the resubscribe. */
    pause(): void {
        this.ready = false;
        this.media?.reset();
    }

    /** @internal Ends the channel for this client. */
    end(reason: ChannelCloseReason, by?: string): void {
        if (!this.subscribed) return;
        this.subscribed = false;
        this.stream = null;
        this.media?.share(null);
        this.media?.reset();
        this.client.channelSet.forget(this);
        this.emit("closed", by === undefined ? { reason } : { reason, by });
    }

    private joined(sessionId: string): void {
        const peer = this.client.peers.get(sessionId);
        if (peer) this.emit("subscriber:joined", { peer, meta: this.subscribers.get(sessionId)! });
        this.client.links?.refreshTracks();
        this.media?.update(peer?.capabilities.media === true);
    }

    private left(sessionId: string, meta: Record<string, unknown>, reason: string): void {
        this.media?.peerLeft(sessionId);
        this.mediaEnded(sessionId);
        const peer = this.client.peers.get(sessionId);
        if (peer)
            this.emit("subscriber:left", { peer, meta }, reason as CloseReason | "unsubscribed");
        this.client.links?.refreshTracks();
        this.media?.update(false);
    }

    private mediaEnded(from: string): void {
        if (!this.withMedia.delete(from)) return;
        const peer = this.client.peers.get(from);
        if (peer) this.emit("media:ended", { peer });
    }

    private requireSubscribed(): void {
        if (!this.subscribed) throw new P2PError("NOT_SUBSCRIBED", `Not subscribed to ${this.id}`);
    }
}
