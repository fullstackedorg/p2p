// Inspector subscriptions and prefix watches: who observes which channel, invisibly.
// See docs/3-subsystems/channels.md §4 (Inspector Subscriptions).
import type { Member, Registry } from "./registry.ts";

export class Observers {
    private registry: Registry;
    /** channel id -> inspector sessions subscribed to it */
    private exact = new Map<string, Set<Member>>();
    /** Channels whose subscribers were last told they are observed. */
    private announced = new Set<string>();

    constructor(registry: Registry) {
        this.registry = registry;
    }

    /** Every inspector a frame of this channel goes to: exact subscriptions and matching watches. */
    of(id: string): Member[] {
        const out = new Set(this.exact.get(id) ?? []);
        for (const m of this.registry.inspectors) {
            for (const prefix of m.watches) if (id.startsWith(prefix)) out.add(m);
        }
        return [...out];
    }

    isObserved(id: string): boolean {
        if (this.exact.get(id)?.size) return true;
        for (const m of this.registry.inspectors) {
            for (const prefix of m.watches) if (id.startsWith(prefix)) return true;
        }
        return false;
    }

    add(member: Member, id: string): void {
        let set = this.exact.get(id);
        if (!set) this.exact.set(id, (set = new Set()));
        set.add(member);
    }

    remove(member: Member, id: string): void {
        this.exact.get(id)?.delete(member);
    }

    /** A new channel: remember whether it starts observed (it has no subscribers to tell yet). */
    created(id: string): void {
        if (this.isObserved(id)) this.announced.add(id);
    }

    /** A deleted channel: forgets it; returns the inspectors that were subscribed to it. */
    deleted(id: string): Member[] {
        const former = [...(this.exact.get(id) ?? [])];
        this.exact.delete(id);
        this.announced.delete(id);
        return former;
    }

    /** Sends channel:observed to the subscribers of every channel whose flag changed. */
    refresh(ids: Iterable<string>, subscribers: (id: string) => Member[]): void {
        for (const id of ids) {
            const observed = this.isObserved(id);
            if (observed === this.announced.has(id)) continue;
            if (observed) this.announced.add(id);
            else this.announced.delete(id);
            const out = { type: "channel:observed", channel: id, observed };
            this.registry.deliver(subscribers(id), out, "reliable", false);
        }
    }
}
