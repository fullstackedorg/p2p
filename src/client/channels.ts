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
import { Channel, type SubscribeAck } from "./channel.ts";
import type { P2PClient } from "./client.ts";
import { socketOf } from "./context.ts";
import type { SharedStream } from "./webrtc.ts";

/** Options of `p2p.subscribe`. */
export type SubscribeOptions = {
    /** Create the channel when it does not exist (`rw` / `admin` only). */
    create?: boolean;
    /** This device's channel presence, seen by the channel's subscribers only. */
    meta?: Record<string, unknown>;
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
        const existing = this.subscribed.get(id);
        if (existing) {
            if (opts.meta) await existing.updatePresence(opts.meta);
            return existing;
        }
        if (opts.create && this.client.role === "ro" && !this.list.has(id))
            throw new P2PError("FORBIDDEN", "Role ro cannot create channels");
        if (this.subscribed.size >= this.maxPerSession)
            throw new P2PError(
                "CHANNEL_LIMIT",
                `Subscribed to ${this.maxPerSession} channels already`
            );
        const conn = socketOf(this.client);
        const channel = new Channel(this.client, id, opts.meta ?? {});
        this.subscribed.set(id, channel);
        try {
            const ack = await conn.request({
                type: "subscribe",
                channel: id,
                meta: channel.meta,
                create: opts.create === true,
            });
            channel.load(ack as unknown as SubscribeAck, false);
        } catch (err) {
            if (this.subscribed.get(id) === channel) this.subscribed.delete(id);
            throw err;
        }
        this.syncLinks();
        return channel;
    }

    /** After a reconnect: subscribes again to every channel; deleted ones close. */
    async resubscribe(): Promise<void> {
        await Promise.all(
            [...this.subscribed.values()].map(async (channel) => {
                try {
                    const frame = { type: "subscribe", channel: channel.id, meta: channel.meta };
                    const ack = await socketOf(this.client).request(frame);
                    channel.load(ack as unknown as SubscribeAck, true);
                } catch (err) {
                    if ((err as P2PError).code === "CHANNEL_NOT_FOUND")
                        channel.end("channel_deleted");
                    else this.client.emitError(err);
                }
            })
        );
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

    /** Devices subscribed to a channel, from global presence. */
    subscribersOf(id: string): PeerInfo[] {
        return this.client.peers.all().filter((p) => p.channels.includes(id));
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
        if (frame.type === "channel:deleted") {
            this.list.delete(frame.channel);
            this.subscribed.get(frame.channel)?.end("channel_deleted", frame.by);
            this.client.emit("channel:deleted", { channel: frame.channel, by: frame.by });
            return true;
        }
        return false;
    }

    /** A frame scoped to a channel (`frame.channel`); dropped when not subscribed. */
    route(frame: Frame, from: string, transport: Transport): void {
        if (frame.type === "media:announce") return this.announce(from, frame);
        this.subscribed.get(frame.channel)?.handle(frame, from, transport);
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
