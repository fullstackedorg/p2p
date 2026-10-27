// Channel stats: computed on demand, pushed to the sessions that follow a prefix, at most once
// per second per channel. See docs/3-subsystems/channels.md (Channel Stats).
import { P2PError } from "../protocol/errors.ts";
import { LIMITS } from "../protocol/types.ts";
import type { Member, Registry } from "./registry.ts";
import type { StateStore, StoredChannel } from "./state-store.ts";

export type ChannelStats = {
    keyCount: number;
    stateBytes: number;
    subscriberCount: number;
    lastWriteAt: number | null;
    lastWriteBy: string | null;
};

export class Stats {
    private registry: Registry;
    private store: StateStore;
    private subscriberCount: (id: string) => number;
    private now: () => number;
    /** channel id -> when its last channel:stats went out */
    private sentAt = new Map<string, number>();
    private timers = new Map<string, NodeJS.Timeout>();

    constructor(
        registry: Registry,
        store: StateStore,
        subscriberCount: (id: string) => number,
        now: () => number
    ) {
        this.registry = registry;
        this.store = store;
        this.subscriberCount = subscriberCount;
        this.now = now;
    }

    of(channel: StoredChannel): ChannelStats {
        let keyCount = 0;
        for (const entry of channel.entries.values()) if (!entry.deleted) keyCount++;
        return {
            keyCount,
            stateBytes: channel.bytes,
            subscriberCount: this.subscriberCount(channel.info.id),
            lastWriteAt: channel.lastWrite?.at ?? null,
            lastWriteBy: channel.lastWrite?.by ?? null,
        };
    }

    /** Stats of the channels whose id starts with prefix. */
    matching(prefix: string): Record<string, ChannelStats> {
        const out: Record<string, ChannelStats> = {};
        for (const [id, channel] of this.store.channels)
            if (id.startsWith(prefix)) out[id] = this.of(channel);
        return out;
    }

    follow(
        member: Member,
        prefix: unknown
    ): { prefix: string; channels: Record<string, ChannelStats> } {
        if (typeof prefix !== "string" || prefix.length > LIMITS.idLength)
            throw new P2PError("INVALID_ARGUMENT", "prefix must be a string of 0-128 characters");
        member.statsFollows.add(prefix);
        return { prefix, channels: this.matching(prefix) };
    }

    unfollow(member: Member, prefix: unknown): void {
        if (typeof prefix !== "string" || !member.statsFollows.delete(prefix))
            throw new P2PError("NOT_SUBSCRIBED", `Not following ${String(prefix)}`);
    }

    /** A stored write or clear happened in the channel. */
    touched(channel: StoredChannel): void {
        const id = channel.info.id;
        if (this.timers.has(id) || this.followers(id).length === 0) return;
        const wait = (this.sentAt.get(id) ?? -Infinity) + LIMITS.statsIntervalMs - this.now();
        if (wait <= 0) return this.send(id);
        const timer = setTimeout(() => {
            this.timers.delete(id);
            this.send(id);
        }, wait);
        timer.unref?.();
        this.timers.set(id, timer);
    }

    /** The channel was deleted. */
    forget(id: string): void {
        clearTimeout(this.timers.get(id));
        this.timers.delete(id);
        this.sentAt.delete(id);
    }

    private followers(id: string): Member[] {
        const out: Member[] = [];
        for (const m of [...this.registry.peers.values(), ...this.registry.inspectors]) {
            for (const prefix of m.statsFollows) {
                if (!id.startsWith(prefix)) continue;
                out.push(m);
                break;
            }
        }
        return out;
    }

    private send(id: string): void {
        const channel = this.store.get(id);
        if (!channel) return;
        this.sentAt.set(id, this.now());
        const out = { type: "channel:stats", channel: id, stats: this.of(channel) };
        this.registry.deliver(this.followers(id), out, "reliable", false);
    }
}
