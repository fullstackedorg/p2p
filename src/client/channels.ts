// The channel list, this client's subscriptions, and which peers get a link.
// See docs/4-client/client-api.md §4 and docs/4-client/transports.md §2.
import { P2PError } from "../protocol/errors.ts";
import {
    isChannelId,
    type ChannelInfo,
    type Frame,
    type PeerInfo,
    type Transport,
} from "../protocol/types.ts";
import { Channel } from "./channel.ts";
import type { SubscribeAck } from "./channel-types.ts";
import type { P2PClient } from "./client.ts";
import { socketOf } from "./context.ts";
import { Watch } from "./watch.ts";
import type { ChannelStats, PeekOptions } from "./options.ts";
import type { SharedStream } from "./webrtc.ts";

/** Options of `p2p.subscribe`. */
export type SubscribeOptions = {
    /**
     * Create the channel when it does not exist (`rw` / `admin` only): `true`, or `{ meta }` to
     * give it its channel meta (a title, a description).
     */
    create?: boolean | { meta?: Record<string, unknown> };
    /** This device's channel presence, seen by the channel's subscribers only. */
    meta?: Record<string, unknown>;
    /** A subscribed channel to leave in the same step: one presence update, never "nowhere". */
    replace?: string;
    /** `false`: load no state; the replica fills from later changes (read the rest with peek). */
    state?: boolean;
};

export function requireChannelId(id: unknown): string {
    if (!isChannelId(id))
        throw new P2PError("INVALID_CHANNEL", "Channel ids match ^[A-Za-z0-9._:-]{1,128}$");
    return id;
}

export class ChannelSet {
    /** Every channel on the Server. */
    list = new Map<string, ChannelInfo>();
    /** The channels this client is subscribed to. */
    subscribed = new Map<string, Channel>();
    /** Inspector sessions: their prefix watches. */
    watches = new Set<Watch>();
    /** The prefixes whose stats this client follows. */
    statsFollows = new Set<string>();
    maxPerSession = 16;
    private client: P2PClient;
    /** "<sessionId>:<MediaStream.id>" -> channel (media:announce) and -> stream (ontrack). */
    private announced = new Map<string, string>();
    private tracks = new Map<string, MediaStream>();

    constructor(client: P2PClient) {
        this.client = client;
    }

    load(channels: ChannelInfo[], limit: number | undefined): string[] {
        const before = [...this.list.keys()];
        this.list = new Map(channels.map((c) => [c.id, c]));
        if (limit) this.maxPerSession = limit;
        return before;
    }

    async subscribe(id: string, opts: SubscribeOptions): Promise<Channel> {
        requireChannelId(id);
        const inspector = this.client.mode === "inspect";
        const previous = opts.replace === undefined ? null : this.subscribed.get(opts.replace);
        if (opts.replace !== undefined) {
            requireChannelId(opts.replace);
            if (opts.replace === id)
                throw new P2PError("INVALID_ARGUMENT", "replace names the channel");
            if (!previous)
                throw new P2PError("NOT_SUBSCRIBED", `Not subscribed to ${opts.replace}`);
            if (inspector) throw new P2PError("FORBIDDEN", "Inspector sessions do not switch");
        }
        const existing = this.subscribed.get(id);
        if (existing) {
            await previous?.unsubscribe();
            if (opts.meta) await existing.updatePresence(opts.meta);
            return existing;
        }
        if (opts.create && !inspector && this.client.role === "ro" && !this.list.has(id))
            throw new P2PError("FORBIDDEN", "Role ro cannot create channels");
        const count = this.subscribed.size - (previous ? 1 : 0);
        if (!inspector && count >= this.maxPerSession)
            throw new P2PError(
                "CHANNEL_LIMIT",
                `Subscribed to ${this.maxPerSession} channels already`
            );
        const conn = socketOf(this.client);
        const channel = new Channel(this.client, id, inspector ? {} : (opts.meta ?? {}));
        this.subscribed.set(id, channel);
        try {
            const frame: Frame = { type: "subscribe", channel: id };
            if (!inspector)
                Object.assign(frame, { meta: channel.meta, create: opts.create ?? false });
            if (previous) frame.replace = previous.id;
            if (opts.state === false) frame.state = false;
            channel.load((await conn.request(frame)) as unknown as SubscribeAck, false);
        } catch (err) {
            if (this.subscribed.get(id) === channel) this.subscribed.delete(id);
            throw err;
        }
        previous?.end("unsubscribed");
        this.syncLinks();
        return channel;
    }

    async create(
        id: string,
        meta: Record<string, unknown> | undefined
    ): Promise<{ created: boolean; channel: ChannelInfo }> {
        requireChannelId(id);
        if (this.client.role === "ro")
            throw new P2PError("FORBIDDEN", "Role ro cannot create channels");
        return this.client.query({ operation: "createChannel", channel: id, meta });
    }

    async updateMeta(id: string, patch: Record<string, unknown>): Promise<ChannelInfo> {
        requireChannelId(id);
        if (this.client.role === "ro")
            throw new P2PError("FORBIDDEN", "Role ro cannot change channels");
        return (await this.client.query({ operation: "updateChannel", channel: id, meta: patch }))
            .channel;
    }

    /** Deletes a channel: its creator (any device of that user, not ro) or an admin. */
    async remove(id: string): Promise<void> {
        requireChannelId(id);
        const { role, peerId } = this.client;
        const info = this.list.get(id);
        const creator = role === "rw" && (!info || info.createdBy === peerId);
        if (role !== "admin" && !creator)
            throw new P2PError("FORBIDDEN", "Only the channel's creator or an admin can delete it");
        await this.client.query({ operation: "deleteChannel", channel: id });
    }

    async peek(target: string | string[], opts: PeekOptions): Promise<any> {
        if (Array.isArray(target)) {
            target.forEach(requireChannelId);
            return this.client.query({ ...opts, operation: "getStates", channels: target });
        }
        requireChannelId(target);
        return this.client.query({ ...opts, operation: "getState", channel: target });
    }

    stats(filter: { ids?: string[]; prefix?: string }): Promise<Record<string, ChannelStats>> {
        const q = filter.ids ? { channels: filter.ids } : { prefix: filter.prefix ?? "" };
        return this.client.query({ operation: "stats", ...q });
    }

    async followStats(prefix: string): Promise<Record<string, ChannelStats>> {
        const ack = await socketOf(this.client).request({ type: "stats:follow", prefix });
        this.statsFollows.add(prefix);
        return ack.channels;
    }

    async unfollowStats(prefix: string): Promise<void> {
        this.statsFollows.delete(prefix);
        await socketOf(this.client).request({ type: "stats:unfollow", prefix });
    }

    can(action: "createChannel" | "updateChannel" | "deleteChannel", id?: string): boolean {
        const { role, peerId } = this.client;
        if (action === "createChannel") return role !== "ro";
        const info = id === undefined ? undefined : this.list.get(id);
        if (!info) return false;
        if (action === "updateChannel") return role !== "ro";
        return role === "admin" || (role === "rw" && info.createdBy === peerId);
    }

    /** Inspector sessions: watches every channel whose id starts with prefix. */
    async watch(prefix: string): Promise<Watch> {
        if (this.client.mode !== "inspect")
            throw new P2PError("FORBIDDEN", "Only inspector sessions watch");
        const watch = new Watch(this.client, prefix);
        await watch.open();
        this.watches.add(watch);
        return watch;
    }

    /** After a reconnect: subscribes again to every channel; deleted ones close. */
    async resubscribe(): Promise<void> {
        const inspector = this.client.mode === "inspect";
        await Promise.all([
            ...[...this.watches].map((w) => w.open().catch((err) => this.client.emitError(err))),
            ...[...this.statsFollows].map((prefix) =>
                socketOf(this.client)
                    .request({ type: "stats:follow", prefix })
                    .catch((err) => this.client.emitError(err))
            ),
            ...[...this.subscribed.values()].map(async (channel) => {
                try {
                    const frame: Frame = { type: "subscribe", channel: channel.id };
                    if (!inspector) frame.meta = channel.meta;
                    const ack = await socketOf(this.client).request(frame);
                    channel.load(ack as unknown as SubscribeAck, true);
                } catch (err) {
                    if ((err as P2PError).code === "CHANNEL_NOT_FOUND")
                        channel.end("channel_deleted");
                    else this.client.emitError(err);
                }
            }),
        ]);
        this.syncLinks();
    }

    pause(): void {
        for (const channel of this.subscribed.values()) channel.pause();
        this.announced.clear();
        this.tracks.clear();
    }

    forget(channel: Channel): void {
        if (this.subscribed.get(channel.id) === channel) this.subscribed.delete(channel.id);
        this.client.links?.refreshTracks();
        this.syncLinks();
    }

    /** Devices subscribed to a channel, from global presence; this one too with includeSelf. */
    subscribersOf(id: string, includeSelf = false): PeerInfo[] {
        const peers = this.client.peers.all().filter((p) => p.channels.includes(id));
        if (includeSelf && this.client.mode !== "inspect" && this.subscribed.has(id))
            peers.push(this.client.self);
        return peers;
    }

    /** A peer shares at least one channel with this client. */
    shares(peer: PeerInfo): boolean {
        return peer.channels.some((id) => this.subscribed.has(id));
    }

    /** Opens links to peers that share a channel; releases the others after the idle delay. */
    syncLinks(): void {
        const links = this.client.links;
        if (!links) return;
        for (const peer of this.client.peers.all()) {
            if (this.client.eligible(peer)) links.consider(peer.sessionId);
            else links.release(peer.sessionId);
        }
    }

    /** The streams to send as tracks to one linked peer: those of the channels it shares. */
    streamsFor(sessionId: string): SharedStream[] {
        const out: SharedStream[] = [];
        for (const channel of this.subscribed.values())
            if (channel.stream && channel.has(sessionId))
                out.push({ channel: channel.id, stream: channel.stream });
        return out;
    }

    /** Server frames about channels; false when the frame is not one. */
    handleServer(frame: Frame): boolean {
        if (frame.type === "channel:created") {
            this.list.set(frame.channel.id, frame.channel);
            this.client.emit("channel:created", frame.channel);
            return true;
        }
        if (frame.type === "channel:updated") {
            this.list.set(frame.channel.id, frame.channel);
            const { channel, by, sessionId, deviceId } = frame;
            this.client.emit("channel:updated", { channel, by, sessionId, deviceId });
            return true;
        }
        if (frame.type === "channel:deleted") {
            const { channel, by, sessionId, deviceId } = frame;
            this.list.delete(channel);
            this.subscribed.get(channel)?.end("channel_deleted", by);
            for (const watch of this.watches) watch.forget(channel);
            this.client.emit("channel:deleted", { channel, by, sessionId, deviceId });
            return true;
        }
        if (frame.type === "channel:stats") {
            this.client.emit("channel:stats", { channel: frame.channel, stats: frame.stats });
            return true;
        }
        if (frame.type === "channel:observed") {
            this.subscribed.get(frame.channel)?.setObserved(frame.observed === true);
            return true;
        }
        return false;
    }

    /** A frame scoped to a channel (`frame.channel`); dropped when not subscribed or watched. */
    route(frame: Frame, from: string, transport: Transport): void {
        if (frame.type === "media:announce") return this.announce(from, frame);
        this.subscribed.get(frame.channel)?.handle(frame, from, transport);
        if (transport === "socket")
            for (const watch of this.watches)
                if (watch.matches(frame.channel)) watch.handle(frame, from);
    }

    /** Tracks from a link: matched with their media:announce, whichever arrives first. */
    onTrack(from: string, stream: MediaStream): void {
        const key = `${from}:${stream.id}`;
        const channel = this.announced.get(key);
        if (channel) this.subscribed.get(channel)?.mediaFrom(from, stream, "webrtc");
        else this.tracks.set(key, stream);
    }

    peerLeft(sessionId: string): void {
        for (const map of [this.announced, this.tracks])
            for (const key of [...map.keys()]) if (key.startsWith(sessionId + ":")) map.delete(key);
    }

    private announce(from: string, frame: Frame): void {
        if (typeof frame.streamId !== "string" || typeof frame.channel !== "string") return;
        const key = `${from}:${frame.streamId}`;
        this.announced.set(key, frame.channel);
        const stream = this.tracks.get(key);
        if (!stream) return;
        this.tracks.delete(key);
        this.subscribed.get(frame.channel)?.mediaFrom(from, stream, "webrtc");
    }
}
