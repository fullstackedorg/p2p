// Channel lifecycle, subscriptions, channel presence. See docs/3-subsystems/channels.md.
import { P2PError, type CloseReason } from "../protocol/errors.ts";
import { isChannelId, type ChannelInfo, type Entry } from "../protocol/types.ts";
import type { Member, Registry } from "./registry.ts";
import type { StateStore, StoredChannel } from "./state-store.ts";

export type ChannelLimits = { maxChannels: number; maxChannelsPerSession: number };

export type SubscribeResult = {
    channel: string;
    created: boolean;
    subscribers: { sessionId: string; meta: Record<string, unknown> }[];
    state: Record<string, Entry>;
    clock: number;
};

export function channelId(value: unknown): string {
    if (!isChannelId(value)) {
        throw new P2PError("INVALID_CHANNEL", "Channel ids match ^[A-Za-z0-9._:-]{1,128}$");
    }
    return value;
}

export class Channels {
    private registry: Registry;
    private store: StateStore;
    private limits: ChannelLimits;
    private now: () => number;
    /** channel id -> subscribed members */
    private subs = new Map<string, Set<Member>>();

    constructor(registry: Registry, store: StateStore, limits: ChannelLimits, now: () => number) {
        this.registry = registry;
        this.store = store;
        this.limits = limits;
        this.now = now;
    }

    list(): ChannelInfo[] {
        return [...this.store.channels.values()]
            .map((c) => c.info)
            .sort((a, b) => (a.id < b.id ? -1 : 1));
    }

    subscribers(id: string): Member[] {
        return [...(this.subs.get(id) ?? [])];
    }

    /** The stored channel, or CHANNEL_NOT_FOUND. */
    require(id: unknown): StoredChannel {
        const channel = this.store.get(channelId(id));
        if (!channel) throw new P2PError("CHANNEL_NOT_FOUND", `No channel ${id}`);
        return channel;
    }

    /** The stored channel a member publishes in, or NOT_SUBSCRIBED. */
    subscribed(member: Member, id: unknown): StoredChannel {
        const cid = channelId(id);
        if (!member.channels.has(cid))
            throw new P2PError("NOT_SUBSCRIBED", `Not subscribed to ${cid}`);
        return this.store.get(cid)!;
    }

    create(by: Member, id: unknown): { created: boolean; channel: ChannelInfo } {
        const cid = channelId(id);
        const existing = this.store.get(cid);
        if (existing) return { created: false, channel: existing.info };
        if (by.role === "ro") throw new P2PError("FORBIDDEN", "Role ro cannot create channels");
        if (this.store.channels.size >= this.limits.maxChannels) {
            throw new P2PError(
                "CHANNEL_LIMIT",
                `The Server holds ${this.limits.maxChannels} channels`
            );
        }
        const info: ChannelInfo = { id: cid, createdAt: this.now(), createdBy: by.peerId };
        this.store.create(info);
        this.registry.toPeers({ type: "channel:created", channel: info }, new Set());
        return { created: true, channel: info };
    }

    delete(by: Member, id: unknown): void {
        if (by.role === "ro") throw new P2PError("FORBIDDEN", "Role ro cannot delete channels");
        const { info } = this.require(id);
        const former = this.subscribers(info.id);
        this.subs.delete(info.id);
        for (const m of former) m.channels.delete(info.id);
        this.store.delete(info.id);
        this.registry.toPeers(
            { type: "channel:deleted", channel: info.id, by: by.peerId },
            new Set()
        );
        for (const m of former) this.registry.updated(m);
    }

    subscribe(member: Member, frame: Record<string, any>): SubscribeResult {
        const cid = channelId(frame.channel);
        const meta = typeof frame.meta === "object" && frame.meta && !Array.isArray(frame.meta);
        let created = false;
        if (!this.store.get(cid)) {
            if (frame.create !== true) throw new P2PError("CHANNEL_NOT_FOUND", `No channel ${cid}`);
            created = this.create(member, cid).created;
        }
        const again = member.channels.has(cid);
        if (!again && member.channels.size >= this.limits.maxChannelsPerSession) {
            const max = this.limits.maxChannelsPerSession;
            throw new P2PError("CHANNEL_LIMIT", `Subscribed to ${max} channels already`);
        }
        const channelMeta = meta ? frame.meta : again ? member.channels.get(cid)! : {};
        member.channels.set(cid, channelMeta);
        let set = this.subs.get(cid);
        if (!set) this.subs.set(cid, (set = new Set()));
        set.add(member);
        const others = [...set].filter((m) => m !== member);
        const result: SubscribeResult = {
            channel: cid,
            created,
            subscribers: others.map((m) => ({
                sessionId: m.sessionId,
                meta: m.channels.get(cid)!,
            })),
            state: Object.fromEntries(this.store.get(cid)!.entries),
            clock: this.store.clock,
        };
        const sub = { channel: cid, sessionId: member.sessionId, meta: channelMeta };
        if (again) {
            this.registry.deliver(
                others,
                { type: "subscriber:updated", ...sub },
                "reliable",
                false
            );
        } else {
            this.registry.updated(member);
            this.registry.deliver(others, { type: "subscriber:joined", ...sub }, "reliable", false);
        }
        return result;
    }

    presence(member: Member, frame: Record<string, any>): void {
        const { info } = this.subscribed(member, frame.channel);
        if (typeof frame.meta !== "object" || !frame.meta || Array.isArray(frame.meta)) {
            throw new P2PError("INVALID_ARGUMENT", "meta must be an object");
        }
        member.channels.set(info.id, frame.meta);
        const others = this.subscribers(info.id).filter((m) => m !== member);
        const out = {
            type: "subscriber:updated",
            channel: info.id,
            sessionId: member.sessionId,
            meta: frame.meta,
        };
        this.registry.deliver(others, out, "reliable", false);
    }

    unsubscribe(member: Member, id: unknown, reason: "unsubscribed" | CloseReason): void {
        const { info } = this.subscribed(member, id);
        this.drop(member, info.id, reason);
        if (reason === "unsubscribed") this.registry.updated(member);
    }

    /** A closing session leaves every channel (subscriber:left with the close reason). */
    leaveAll(member: Member, reason: CloseReason): void {
        for (const id of [...member.channels.keys()]) this.drop(member, id, reason);
    }

    private drop(member: Member, id: string, reason: string): void {
        member.channels.delete(id);
        const set = this.subs.get(id);
        set?.delete(member);
        if (set && set.size === 0) this.subs.delete(id);
        const out = { type: "subscriber:left", channel: id, sessionId: member.sessionId, reason };
        this.registry.deliver(set ?? [], out, "reliable", false);
    }
}
