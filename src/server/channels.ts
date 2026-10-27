// Channel lifecycle, subscriptions, channel presence, inspector subscriptions.
// See docs/3-subsystems/channels.md.
import { P2PError, type CloseReason } from "../protocol/errors.ts";
import {
    LIMITS,
    isChannelId,
    isPlainObject,
    mergeMeta,
    type ChannelInfo,
    type Entry,
} from "../protocol/types.ts";
import { Observers } from "./observers.ts";
import type { Member, Registry } from "./registry.ts";
import type { StateStore, StoredChannel } from "./state-store.ts";

export type ChannelLimits = { maxChannels: number; maxChannelsPerSession: number };

type SubscriberMeta = { sessionId: string; meta: Record<string, unknown> };

export type SubscribeResult = {
    channel: string;
    created: boolean;
    subscribers: SubscriberMeta[];
    state: Record<string, Entry>;
    clock: number;
    observed: boolean;
};

export type WatchResult = {
    prefix: string;
    channels: { id: string; subscribers: SubscriberMeta[] }[];
};

export function channelId(value: unknown): string {
    if (!isChannelId(value)) {
        throw new P2PError("INVALID_CHANNEL", "Channel ids match ^[A-Za-z0-9._:-]{1,128}$");
    }
    return value;
}

function channelMeta(value: unknown): Record<string, unknown> {
    if (!isPlainObject(value)) throw new P2PError("INVALID_ARGUMENT", "meta must be an object");
    if (Buffer.byteLength(JSON.stringify(value)) > LIMITS.channelMetaBytes) {
        throw new P2PError("INVALID_ARGUMENT", "Channel meta is limited to 4 KiB of JSON");
    }
    return value;
}

function forbidden(message: string): P2PError {
    return new P2PError("FORBIDDEN", message);
}

export class Channels {
    private registry: Registry;
    private store: StateStore;
    private limits: ChannelLimits;
    private now: () => number;
    /** channel id -> visible subscribers */
    private subs = new Map<string, Set<Member>>();
    private observers: Observers;

    constructor(registry: Registry, store: StateStore, limits: ChannelLimits, now: () => number) {
        this.registry = registry;
        this.observers = new Observers(registry);
        this.store = store;
        this.limits = limits;
        this.now = now;
    }

    list(): ChannelInfo[] {
        return [...this.store.channels.values()]
            .map((c) => c.info)
            .sort((a, b) => (a.id < b.id ? -1 : 1));
    }

    /** Visible subscribers only. */
    subscribers(id: string): Member[] {
        return [...(this.subs.get(id) ?? [])];
    }

    /** Everyone a channel frame goes to: subscribers, inspector subscriptions, matching watches. */
    audience(id: string): Member[] {
        return [...this.subscribers(id), ...this.observers.of(id)];
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

    create(by: Member, id: unknown, meta?: unknown): { created: boolean; channel: ChannelInfo } {
        const cid = channelId(id);
        const existing = this.store.get(cid);
        if (existing) return { created: false, channel: existing.info };
        if (by.role === "ro") throw forbidden("Role ro cannot create channels");
        const initial = channelMeta(meta ?? {});
        if (this.store.channels.size >= this.limits.maxChannels) {
            throw new P2PError(
                "CHANNEL_LIMIT",
                `The Server holds ${this.limits.maxChannels} channels`
            );
        }
        const info: ChannelInfo = {
            id: cid,
            createdAt: this.now(),
            createdBy: by.peerId,
            meta: initial,
        };
        this.store.create(info);
        this.observers.created(cid);
        this.registry.toEveryone({ type: "channel:created", channel: info }, new Set());
        return { created: true, channel: info };
    }

    updateMeta(by: Member, id: unknown, patch: unknown): ChannelInfo {
        if (by.role === "ro") throw forbidden("Role ro cannot change channels");
        const channel = this.require(id);
        if (!isPlainObject(patch)) throw new P2PError("INVALID_ARGUMENT", "meta must be an object");
        const info = this.store.updateMeta(
            channel,
            channelMeta(mergeMeta(channel.info.meta, patch))
        );
        const out = { type: "channel:updated", channel: info, ...this.attribution(by) };
        this.registry.toEveryone(out, new Set());
        return info;
    }

    delete(by: Member, id: unknown): void {
        if (by.role === "ro") throw forbidden("Role ro cannot delete channels");
        const { info } = this.require(id);
        if (by.role !== "admin" && by.peerId !== info.createdBy) {
            throw forbidden("Only the channel's creator or an admin can delete it");
        }
        const former = this.subscribers(info.id);
        const watching = this.observers.deleted(info.id);
        this.subs.delete(info.id);
        for (const m of [...former, ...watching]) m.channels.delete(info.id);
        this.store.delete(info.id);
        const out = { type: "channel:deleted", channel: info.id, ...this.attribution(by) };
        this.registry.toEveryone(out, new Set());
        for (const m of former) this.registry.updated(m);
    }

    subscribe(member: Member, frame: Record<string, any>): SubscribeResult | WatchResult {
        if (frame.prefix !== undefined) return this.watch(member, frame.prefix);
        if (member.mode === "inspect") return this.observe(member, frame.channel);
        const cid = channelId(frame.channel);
        const replace = frame.replace === undefined ? null : channelId(frame.replace);
        if (replace === cid) throw new P2PError("INVALID_ARGUMENT", "replace names the channel");
        if (replace && !member.channels.has(replace)) {
            throw new P2PError("NOT_SUBSCRIBED", `Not subscribed to ${replace}`);
        }
        const again = member.channels.has(cid);
        const count = member.channels.size - (replace ? 1 : 0);
        if (!again && count >= this.limits.maxChannelsPerSession) {
            const max = this.limits.maxChannelsPerSession;
            throw new P2PError("CHANNEL_LIMIT", `Subscribed to ${max} channels already`);
        }
        let created = false;
        if (!this.store.get(cid)) {
            if (!frame.create) throw new P2PError("CHANNEL_NOT_FOUND", `No channel ${cid}`);
            const meta = isPlainObject(frame.create) ? frame.create.meta : undefined;
            created = this.create(member, cid, meta).created;
        }
        if (replace) this.drop(member, replace, "unsubscribed");
        const channelMetaOf = isPlainObject(frame.meta)
            ? frame.meta
            : again
              ? member.channels.get(cid)!
              : {};
        member.channels.set(cid, channelMetaOf);
        let set = this.subs.get(cid);
        if (!set) this.subs.set(cid, (set = new Set()));
        set.add(member);
        const result: SubscribeResult = {
            channel: cid,
            created,
            subscribers: this.metas(cid, member),
            state: Object.fromEntries(this.store.get(cid)!.entries),
            clock: this.store.clock,
            observed: this.observers.isObserved(cid),
        };
        const sub: Record<string, unknown> = {
            channel: cid,
            sessionId: member.sessionId,
            meta: channelMetaOf,
        };
        const others = this.audience(cid).filter((m) => m !== member);
        if (replace || !again) this.registry.updated(member);
        if (again) {
            this.registry.deliver(
                others,
                { type: "subscriber:updated", ...sub },
                "reliable",
                false
            );
        } else {
            if (member.previous?.channels.delete(cid)) sub.replaces = member.previous.sessionId;
            this.registry.deliver(others, { type: "subscriber:joined", ...sub }, "reliable", false);
        }
        return result;
    }

    presence(member: Member, frame: Record<string, any>): void {
        const { info } = this.subscribed(member, frame.channel);
        if (!isPlainObject(frame.meta)) {
            throw new P2PError("INVALID_ARGUMENT", "meta must be an object");
        }
        const meta =
            frame.merge === true
                ? mergeMeta(member.channels.get(info.id)!, frame.meta)
                : frame.meta;
        member.channels.set(info.id, meta);
        const others = this.audience(info.id).filter((m) => m !== member);
        const out = {
            type: "subscriber:updated",
            channel: info.id,
            sessionId: member.sessionId,
            meta,
        };
        this.registry.deliver(
            others,
            out,
            frame.ephemeral === true ? "ephemeral" : "reliable",
            false
        );
    }

    unsubscribe(member: Member, frame: Record<string, any>): void {
        if (frame.prefix !== undefined) {
            if (member.mode !== "inspect") throw forbidden("Only inspector sessions watch");
            if (!member.watches.delete(frame.prefix)) {
                throw new P2PError("NOT_SUBSCRIBED", `No watch on ${frame.prefix}`);
            }
            return this.refreshObserved();
        }
        const { info } = this.subscribed(member, frame.channel);
        if (member.mode === "inspect") {
            member.channels.delete(info.id);
            this.observers.remove(member, info.id);
            return this.refreshObserved();
        }
        this.drop(member, info.id, "unsubscribed");
        this.registry.updated(member);
    }

    /** A closing session leaves every channel (subscriber:left with the close reason). */
    leaveAll(member: Member, reason: CloseReason): void {
        if (member.mode === "inspect") {
            for (const id of member.channels.keys()) this.observers.remove(member, id);
            member.channels.clear();
            member.watches.clear();
            return this.refreshObserved();
        }
        for (const id of [...member.channels.keys()]) this.drop(member, id, reason);
    }

    private observe(member: Member, id: unknown): SubscribeResult {
        const channel = this.require(id);
        const cid = channel.info.id;
        member.channels.set(cid, {});
        this.observers.add(member, cid);
        this.refreshObserved();
        return {
            channel: cid,
            created: false,
            subscribers: this.metas(cid, member),
            state: Object.fromEntries(channel.entries),
            clock: this.store.clock,
            observed: true,
        };
    }

    private watch(member: Member, prefix: unknown): WatchResult {
        if (member.mode !== "inspect") throw forbidden("Only inspector sessions watch");
        if (typeof prefix !== "string" || prefix.length > LIMITS.idLength) {
            throw new P2PError("INVALID_ARGUMENT", "prefix must be a string of 0-128 characters");
        }
        member.watches.add(prefix);
        this.refreshObserved();
        const channels = this.list().filter((c) => c.id.startsWith(prefix));
        return {
            prefix,
            channels: channels.map((c) => ({ id: c.id, subscribers: this.metas(c.id) })),
        };
    }

    private metas(id: string, except?: Member): SubscriberMeta[] {
        return this.subscribers(id)
            .filter((m) => m !== except)
            .map((m) => ({ sessionId: m.sessionId, meta: m.channels.get(id)! }));
    }

    /** Tells subscribers of every channel whose observed flag changed. */
    private refreshObserved(): void {
        this.observers.refresh(this.store.channels.keys(), (id) => this.subscribers(id));
    }

    private attribution(by: Member): Record<string, string> {
        return { by: by.peerId, sessionId: by.sessionId, deviceId: by.deviceId };
    }

    private drop(member: Member, id: string, reason: string): void {
        member.channels.delete(id);
        const set = this.subs.get(id);
        set?.delete(member);
        if (set && set.size === 0) this.subs.delete(id);
        const out = { type: "subscriber:left", channel: id, sessionId: member.sessionId, reason };
        this.registry.deliver(this.audience(id), out, "reliable", false);
    }
}
