// Named jobs held by one session of a channel at a time, with a queue. In memory only.
// See docs/3-subsystems/channels.md (Leases) and docs/1-concepts/protocol-spec.md §5.4.
import { P2PError } from "../protocol/errors.ts";
import { LIMITS, isId } from "../protocol/types.ts";
import type { Member, Registry } from "./registry.ts";

type Waiter = { member: Member; ttlMs: number };

type Lease = {
    holder: Member | null;
    timer: NodeJS.Timeout | null;
    queue: Waiter[];
};

export type LeaseRequest = { name?: unknown; ttlMs?: unknown; wait?: unknown };

function clampTtl(value: unknown): number {
    const ms = typeof value === "number" && Number.isFinite(value) ? value : 30_000;
    return Math.min(Math.max(ms, LIMITS.leaseMinMs), LIMITS.leaseMaxMs);
}

function leaseName(value: unknown): string {
    if (!isId(value)) throw new P2PError("INVALID_ARGUMENT", "name must be 1-128 characters");
    return value;
}

export class Leases {
    private registry: Registry;
    /** Everyone who hears about a channel's leases (its subscribers and inspectors). */
    private audience: (channel: string) => Member[];
    /** channel id -> name -> lease */
    private byChannel = new Map<string, Map<string, Lease>>();

    constructor(registry: Registry, audience: (channel: string) => Member[]) {
        this.registry = registry;
        this.audience = audience;
    }

    /** The holders of a channel's leases, for the subscribe ack. */
    holders(channel: string): Record<string, string> {
        const out: Record<string, string> = {};
        for (const [name, lease] of this.byChannel.get(channel) ?? [])
            if (lease.holder) out[name] = lease.holder.sessionId;
        return out;
    }

    request(channel: string, member: Member, req: LeaseRequest): Record<string, unknown> {
        const name = leaseName(req.name);
        const ttlMs = clampTtl(req.ttlMs);
        const lease = this.lease(channel, name);
        if (!lease.holder || lease.holder === member) {
            const changed = lease.holder !== member;
            this.grant(channel, name, lease, member, ttlMs);
            if (changed) this.announce(channel, name, member);
            return { granted: true, holder: member.sessionId };
        }
        if (req.wait === true && !lease.queue.some((w) => w.member === member))
            lease.queue.push({ member, ttlMs });
        return { granted: false, holder: lease.holder.sessionId };
    }

    release(channel: string, member: Member, name: unknown): boolean {
        const lease = this.byChannel.get(channel)?.get(leaseName(name));
        if (!lease) return false;
        if (lease.holder === member) {
            this.next(channel, leaseName(name), lease);
            return true;
        }
        const before = lease.queue.length;
        lease.queue = lease.queue.filter((w) => w.member !== member);
        return lease.queue.length < before;
    }

    /** A member left the channel (unsubscribe, switch, close): its leases and places go. */
    left(channel: string, member: Member): void {
        for (const [name, lease] of this.byChannel.get(channel) ?? []) {
            lease.queue = lease.queue.filter((w) => w.member !== member);
            if (lease.holder === member) this.next(channel, name, lease);
        }
    }

    /** The channel was deleted: its leases go without announcements. */
    dropChannel(channel: string): void {
        for (const lease of this.byChannel.get(channel)?.values() ?? [])
            if (lease.timer) clearTimeout(lease.timer);
        this.byChannel.delete(channel);
    }

    private lease(channel: string, name: string): Lease {
        let leases = this.byChannel.get(channel);
        if (!leases) this.byChannel.set(channel, (leases = new Map()));
        let lease = leases.get(name);
        if (!lease) leases.set(name, (lease = { holder: null, timer: null, queue: [] }));
        return lease;
    }

    private grant(channel: string, name: string, lease: Lease, member: Member, ttlMs: number) {
        if (lease.timer) clearTimeout(lease.timer);
        lease.holder = member;
        lease.queue = lease.queue.filter((w) => w.member !== member);
        lease.timer = setTimeout(() => this.next(channel, name, lease), ttlMs);
        lease.timer.unref?.();
    }

    /** The holder let go: the first waiter still in the channel gets it, else nobody. */
    private next(channel: string, name: string, lease: Lease): void {
        if (lease.timer) clearTimeout(lease.timer);
        lease.timer = null;
        lease.holder = null;
        const waiter = lease.queue.shift();
        if (waiter) this.grant(channel, name, lease, waiter.member, waiter.ttlMs);
        else this.byChannel.get(channel)?.delete(name);
        this.announce(channel, name, lease.holder);
    }

    private announce(channel: string, name: string, holder: Member | null): void {
        const out = { type: "lease:changed", channel, name, holder: holder?.sessionId ?? null };
        this.registry.deliver(this.audience(channel), out, "reliable", false);
    }
}
