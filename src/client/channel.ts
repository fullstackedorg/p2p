// A subscribed channel: subscribers, channel presence, broadcasts, shared state, media.
// See docs/4-client/client-api.md §4.
import { EventEmitter } from "node:events";
import { P2PError, type CloseReason } from "../protocol/errors.ts";
import type { Frame, PeerInfo, Transport } from "../protocol/types.ts";
import { socketOf } from "./context.ts";
import type { ChannelEvents, JoinInfo, Subscriber } from "./events.ts";
import { ChannelLeases, type LeaseOptions, type LeaseState } from "./leases.ts";
import { MediaFallback } from "./media-fallback.ts";
import { ChannelPacing, isPaced } from "./pacer.ts";
import {
    STATE_FRAMES,
    type BroadcastOptions,
    type ChannelCloseReason,
    type PresenceOptions,
    type SubscribeAck,
} from "./channel-types.ts";

import type { P2PClient } from "./client.ts";
import { SharedState, type WriteOptions, type WriteResult } from "./state.ts";

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
    /** @internal An inspector watches this channel: broadcasts also go through the Server. */
    observed = false;
    private client: P2PClient;
    private subscribers = new Map<string, Record<string, unknown>>();
    /** @internal */
    media: MediaFallback | null;
    private held: [Frame, string, Transport][] = [];
    private withMedia = new Set<string>();
    private leases: ChannelLeases;
    private pacing: ChannelPacing;

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
            observed: () => this.observed,
        });
        this.leases = new ChannelLeases(client, id, (event, info) => this.emit(event, info));
        const onError = (err: unknown) => client.emitError(err);
        this.pacing = new ChannelPacing(
            {
                id,
                meta: () => this.meta,
                setMeta: (meta) => (this.meta = meta),
                send: (frame, acked) => {
                    if (!this.subscribed) return;
                    if (acked) return socketOf(client).request(frame);
                    socketOf(client).send({ ...frame, ephemeral: true });
                },
            },
            (data, settled) =>
                client.messaging.broadcast(id, this.peers(), data, !settled, this.observed),
            onError
        );
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

    /**
     * Every other subscriber (one per device, own devices included) with its channel presence;
     * this device too with `includeSelf`.
     */
    getSubscribers(opts: { includeSelf?: boolean } = {}): Subscriber[] {
        const out = this.peers().map((peer) => ({
            peer,
            meta: this.subscribers.get(peer.sessionId)!,
        }));
        if (opts.includeSelf && this.subscribed && this.client.mode !== "inspect")
            out.push({ peer: this.client.self, meta: this.meta });
        return out;
    }

    /**
     * Replaces this device's channel presence (or patches it with `merge`); only this channel's
     * subscribers see it. `ephemeral` resolves at once, for values that change constantly (a
     * cursor): send one regular update when the value settles.
     */
    async updatePresence(meta: Record<string, unknown>, opts: PresenceOptions = {}): Promise<void> {
        this.requireWritable();
        return this.pacing.updatePresence(meta, opts);
    }

    /**
     * Sends `data` (any JSON value) to every other subscriber. `{ ephemeral: true }` for
     * high-frequency updates (cursors): unordered, may be dropped, resolves without an ack.
     */
    async broadcast(data: unknown, opts: BroadcastOptions = {}): Promise<void> {
        this.requireWritable();
        if (isPaced(opts)) return this.pacing.broadcast(opts.stream ?? "default", data, opts);
        return this.client.messaging.broadcast(
            this.id,
            this.peers(),
            data,
            opts.ephemeral === true,
            this.observed
        );
    }

    /** The channel's shared state: every live key, or one key's value (`undefined` when missing). */
    getState(): Record<string, unknown>;
    getState(key: string): unknown;
    getState(key?: string): unknown {
        return key === undefined ? this.state.values() : this.state.get(key);
    }

    /**
     * Writes a key (1-256 characters, any JSON value) for every subscriber, persisted by the
     * Server. Applies locally first; resolves `{ applied: false }` when a concurrent newer write
     * won. Rejects `STATE_TOO_LARGE`, `PAYLOAD_TOO_LARGE`, `INVALID_ARGUMENT`, `NOT_SUBSCRIBED`.
     */
    async setState(
        key: string,
        value: unknown,
        opts: WriteOptions & { ephemeral?: boolean } = {}
    ): Promise<WriteResult> {
        this.requireWritable();
        if (opts.ephemeral) return this.state.setLive(key, value, opts);
        return this.state.set(key, value, opts);
    }

    /** Deletes a key for every subscriber. Same results as `setState`. */
    async deleteState(key: string, opts: WriteOptions = {}): Promise<WriteResult> {
        this.requireWritable();
        return this.state.delete(key, opts);
    }

    /**
     * Writes up to 1 000 keys in one frame. The Server applies the batch whole or not at all,
     * then each key by last-write-wins; resolves with `{ [key]: { applied } }`.
     */
    async setStates(
        entries: Record<string, unknown>,
        opts: WriteOptions = {}
    ): Promise<Record<string, WriteResult>> {
        this.requireWritable();
        const ops = Object.entries(entries).map(([key, value]) => ({ key, value }));
        return this.state.batch(ops, opts);
    }

    /** Deletes up to 1 000 keys in one frame. Same results as `setStates`. */
    async deleteStates(
        keys: string[],
        opts: WriteOptions = {}
    ): Promise<Record<string, WriteResult>> {
        this.requireWritable();
        return this.state.batch(
            keys.map((key) => ({ key, deleted: true as const })),
            opts
        );
    }

    /**
     * Deletes every key of the channel, or every key starting with `prefix`; resolves with how
     * many keys the Server cleared.
     */
    async clearState(
        opts: { prefix?: string } & WriteOptions = {}
    ): Promise<{ applied: boolean; count: number }> {
        this.requireWritable();
        return this.state.clear(opts);
    }

    /**
     * Asks for a named job in this channel; resolves `true` when this device holds it, and keeps
     * renewing it while it does. With `wait` (default) it queues and gets `lease:changed` with
     * `mine: true` when its turn comes.
     */
    async lease(name: string, opts: LeaseOptions = {}): Promise<boolean> {
        this.requireWritable();
        return this.leases.request(name, opts);
    }

    /** Gives a lease up, or stops waiting for it. */
    async releaseLease(name: string): Promise<void> {
        this.requireWritable();
        return this.leases.release(name);
    }

    /** Who holds a lease (`null`: nobody) and whether it is this device. */
    getLease(name: string): LeaseState {
        return this.leases.get(name);
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
            for (const [sid] of this.subscribers) if (!before.has(sid)) this.joined(sid, {});
            this.state.reload(ack.state, ack.clock);
        } else this.state.replica.load(ack.state, ack.clock);
        this.leases.load(ack.leases, resubscribe);
        this.observed = ack.observed === true;
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
                return this.joined(
                    frame.sessionId,
                    typeof frame.replaces === "string" ? { replaces: frame.replaces } : {}
                );
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
            case "lease:changed":
                return this.leases.changed(String(frame.name), frame.holder ?? null);
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
        this.leases.pause();
    }

    /** @internal Ends the channel for this client. */
    end(reason: ChannelCloseReason, by?: string): void {
        if (!this.subscribed) return;
        this.subscribed = false;
        this.pacing.cancel();
        this.leases.stop();
        this.state.stop();
        this.stream = null;
        this.media?.share(null);
        this.media?.reset();
        this.client.channelSet.forget(this);
        this.emit("closed", by === undefined ? { reason } : { reason, by });
    }

    /** @internal */
    setObserved(observed: boolean): void {
        this.observed = observed;
    }

    private joined(sessionId: string, info: JoinInfo): void {
        const peer = this.client.peers.get(sessionId);
        if (peer)
            this.emit("subscriber:joined", { peer, meta: this.subscribers.get(sessionId)! }, info);
        this.client.links?.refreshTracks();
        this.media?.update(peer?.capabilities.media === true);
    }

    /** Nothing but `closed` is emitted once the channel ended for this client. */
    override emit(event: any, ...args: any[]): boolean {
        if (!this.subscribed && event !== "closed") return false;
        return super.emit(event, ...(args as any));
    }

    private left(sessionId: string, meta: Record<string, unknown>, reason: string): void {
        this.state.dropLive(sessionId);
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

    /** Subscribed, and not an inspector session (inspectors write through query). */
    private requireWritable(): void {
        this.requireSubscribed();
        if (this.client.mode === "inspect")
            throw new P2PError("FORBIDDEN", "Inspector sessions write through query");
    }
}
