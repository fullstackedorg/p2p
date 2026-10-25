// The Client's copy of the shared state. See docs/3-subsystems/state-store.md §7.
import { applyEntry, compareVersion, tombstone } from "../protocol/lww.ts";
import type { Entry, Version } from "../protocol/types.ts";

export class Replica {
    clock = 0;
    entries = new Map<string, Entry>();

    load(state: Record<string, Entry>, clock: number): void {
        this.entries = new Map(Object.entries(state ?? {}));
        this.clock = 0;
        this.observe(clock);
        for (const entry of this.entries.values()) this.observe(entry.version[0]);
    }

    observe(clock: number): void {
        if (Number.isSafeInteger(clock) && clock > this.clock) this.clock = clock;
    }

    nextVersion(sessionId: string): Version {
        this.clock += 1;
        return [this.clock, sessionId];
    }

    apply(key: string, entry: Entry): boolean {
        this.observe(entry.version[0]);
        return applyEntry(this.entries, key, entry);
    }

    /** Tombstones every live entry older than version; returns the keys it changed. */
    clear(version: Version, updatedBy: string, now: number): string[] {
        this.observe(version[0]);
        const cleared: string[] = [];
        for (const [key, entry] of this.entries) {
            if (entry.deleted || compareVersion(version, entry.version) <= 0) continue;
            this.entries.set(key, tombstone(version, updatedBy, now));
            cleared.push(key);
        }
        return cleared;
    }

    get(key: string): unknown {
        const entry = this.entries.get(key);
        return entry && !entry.deleted ? entry.value : undefined;
    }

    values(): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of this.entries) if (!entry.deleted) out[key] = entry.value;
        return out;
    }
}
