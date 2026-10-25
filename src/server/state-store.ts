// LWW key-value store with a debounced atomic snapshot. See docs/3-subsystems/state-store.md.
import fs from "node:fs/promises";
import path from "node:path";
import { P2PError } from "../protocol/errors.ts";
import { applyEntry, compareVersion, tombstone } from "../protocol/lww.ts";
import { LIMITS, type Entry, type Version } from "../protocol/types.ts";
import type { Logger } from "./log.ts";

const FORMAT = 1;
const ENVELOPE_BYTES = 64;

export type StateStoreOptions = {
    dataDir: string;
    maxStateBytes: number;
    debounceMs: number;
    maxDelayMs: number;
    now: () => number;
    log: Logger;
};

function entryBytes(key: string, entry: Entry): number {
    return Buffer.byteLength(JSON.stringify(key)) + Buffer.byteLength(JSON.stringify(entry)) + 2;
}

export class StateStore {
    clock = 0;
    private map = new Map<string, Entry>();
    private bytes = ENVELOPE_BYTES;
    private opts: StateStoreOptions;
    private file: string;
    private dirty = false;
    private timer: NodeJS.Timeout | null = null;
    private firstDirtyAt = 0;
    private writing: Promise<void> = Promise.resolve();

    constructor(opts: StateStoreOptions) {
        this.opts = opts;
        this.file = path.join(opts.dataDir, "state.json");
    }

    get size(): number {
        return this.bytes;
    }

    get entries(): ReadonlyMap<string, Entry> {
        return this.map;
    }

    async load(): Promise<void> {
        await fs.mkdir(this.opts.dataDir, { recursive: true });
        await fs.rm(this.file + ".tmp", { force: true });
        let raw: string;
        try {
            raw = await fs.readFile(this.file, "utf-8");
        } catch (err: any) {
            if (err?.code === "ENOENT") return;
            throw err;
        }
        let snapshot: any;
        try {
            snapshot = JSON.parse(raw);
        } catch {
            throw new Error(`${this.file} is not valid JSON; move it aside to start fresh`);
        }
        if (snapshot?.format !== FORMAT || typeof snapshot.entries !== "object") {
            throw new Error(`${this.file} has an unsupported format (expected ${FORMAT})`);
        }
        this.clock = Number.isSafeInteger(snapshot.clock) ? snapshot.clock : 0;
        for (const [key, entry] of Object.entries(snapshot.entries as Record<string, Entry>)) {
            this.map.set(key, entry);
            this.bytes += entryBytes(key, entry);
        }
    }

    observe(clock: number): void {
        if (clock > this.clock) this.clock = clock;
    }

    /** A version a Client may write: its own session and no absurd clock jump. */
    acceptsVersion(version: Version, sessionId: string): boolean {
        return version[1] === sessionId && version[0] <= this.clock + LIMITS.maxClockJump;
    }

    nextVersion(sessionId: string): Version {
        this.clock += 1;
        return [this.clock, sessionId];
    }

    set(key: string, entry: Entry): { applied: boolean; entry: Entry } {
        this.observe(entry.version[0]);
        const current = this.map.get(key);
        if (current && compareVersion(entry.version, current.version) <= 0) {
            return { applied: false, entry: current };
        }
        const delta = entryBytes(key, entry) - (current ? entryBytes(key, current) : 0);
        if (!entry.deleted && delta > 0 && this.bytes + delta > this.opts.maxStateBytes) {
            throw new P2PError("STATE_TOO_LARGE", `State would exceed ${this.opts.maxStateBytes}`);
        }
        applyEntry(this.map, key, entry);
        this.bytes += delta;
        this.markDirty();
        return { applied: true, entry };
    }

    /** Tombstones every live entry older than version (optionally under prefix). */
    clear(version: Version, updatedBy: string, prefix?: string): string[] {
        this.observe(version[0]);
        const cleared: string[] = [];
        for (const [key, entry] of this.map) {
            if (entry.deleted || (prefix && !key.startsWith(prefix))) continue;
            if (compareVersion(version, entry.version) <= 0) continue;
            const stone = tombstone(version, updatedBy, this.opts.now());
            this.bytes += entryBytes(key, stone) - entryBytes(key, entry);
            this.map.set(key, stone);
            cleared.push(key);
        }
        if (cleared.length) this.markDirty();
        return cleared;
    }

    toObject(): Record<string, Entry> {
        return Object.fromEntries(this.map);
    }

    flush(): Promise<void> {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.writing = this.writing.then(() => this.write());
        return this.writing;
    }

    async close(): Promise<void> {
        await this.flush();
    }

    private markDirty(): void {
        const now = this.opts.now();
        if (!this.dirty) this.firstDirtyAt = now;
        this.dirty = true;
        if (this.timer) clearTimeout(this.timer);
        const wait = Math.min(this.opts.debounceMs, this.firstDirtyAt + this.opts.maxDelayMs - now);
        this.timer = setTimeout(() => void this.flush(), Math.max(0, wait));
        this.timer.unref?.();
    }

    private purgeTombstones(): void {
        const cutoff = this.opts.now() - LIMITS.tombstoneTtlMs;
        for (const [key, entry] of this.map) {
            if (entry.deleted && entry.updatedAt < cutoff) {
                this.map.delete(key);
                this.bytes -= entryBytes(key, entry);
            }
        }
    }

    private async write(): Promise<void> {
        if (!this.dirty) return;
        this.dirty = false;
        this.purgeTombstones();
        const body = JSON.stringify({
            format: FORMAT,
            savedAt: this.opts.now(),
            clock: this.clock,
            entries: this.toObject(),
        });
        const tmp = this.file + ".tmp";
        try {
            const handle = await fs.open(tmp, "w");
            try {
                await handle.writeFile(body, "utf-8");
                await handle.sync();
            } finally {
                await handle.close();
            }
            await fs.rename(tmp, this.file);
            this.opts.log.debug("snapshot written", { bytes: body.length });
        } catch (err: any) {
            this.dirty = true;
            this.opts.log.error("snapshot write failed", { error: err?.message });
            this.timer = setTimeout(() => void this.flush(), 1000); // retry; writes keep it dirty
            this.timer.unref?.();
        }
    }
}
