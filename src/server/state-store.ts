// Channels and their LWW entries, with a debounced atomic snapshot. See docs/3-subsystems/state-store.md.
import fs from "node:fs/promises";
import path from "node:path";
import { P2PError } from "../protocol/errors.ts";
import { applyEntry, compareVersion, tombstone } from "../protocol/lww.ts";
import {
    LIMITS,
    isPlainObject,
    type ChannelInfo,
    type Entry,
    type Version,
} from "../protocol/types.ts";
import type { Logger } from "./log.ts";

const FORMAT = 2;
const ENVELOPE_BYTES = 64;
/** The channel a format 1 snapshot (one shared state) migrates to. */
export const LEGACY_CHANNEL = "default";

export type StateStoreOptions = {
    dataDir: string;
    maxStateBytes: number;
    debounceMs: number;
    maxDelayMs: number;
    now: () => number;
    log: Logger;
};

export type StoredChannel = {
    info: ChannelInfo;
    entries: Map<string, Entry>;
    bytes: number;
    /** The newest entry's time and writer (not persisted: computed on load). */
    lastWrite: { at: number; by: string } | null;
};

/** What a write did: applied or not, the winning entry, and whether the key became live. */
export type WriteOutcome = { applied: boolean; entry: Entry; created: boolean };

function created(current: Entry | undefined, entry: Entry): boolean {
    return !entry.deleted && (!current || current.deleted);
}

/** One op of a batch: its key and the entry it would store. */
export type BatchOp = { key: string; entry: Entry };

function entryBytes(key: string, entry: Entry): number {
    return Buffer.byteLength(JSON.stringify(key)) + Buffer.byteLength(JSON.stringify(entry)) + 2;
}

function envelopeBytes(info: ChannelInfo): number {
    return Buffer.byteLength(JSON.stringify(info)) + 16;
}

export class StateStore {
    clock = 0;
    channels = new Map<string, StoredChannel>();
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
        let channels: Record<string, any>;
        if (snapshot?.format === 1 && typeof snapshot.entries === "object") {
            const info = { createdAt: snapshot.savedAt ?? 0, createdBy: "" };
            channels = { [LEGACY_CHANNEL]: { ...info, entries: snapshot.entries } };
        } else if (snapshot?.format === FORMAT && typeof snapshot.channels === "object") {
            channels = snapshot.channels;
        } else {
            throw new Error(`${this.file} has an unsupported format (expected ${FORMAT})`);
        }
        this.clock = Number.isSafeInteger(snapshot.clock) ? snapshot.clock : 0;
        for (const [id, c] of Object.entries(channels)) {
            const channel = this.add({
                id,
                createdAt: c.createdAt ?? 0,
                createdBy: c.createdBy ?? "",
                meta: isPlainObject(c.meta) ? c.meta : {},
            });
            for (const [key, stored] of Object.entries(c.entries as Record<string, Entry>)) {
                const entry = { ...stored, deviceId: stored.deviceId ?? "" };
                channel.entries.set(key, entry);
                this.resize(channel, entryBytes(key, entry));
                this.noteWrite(channel, entry);
            }
        }
        if (snapshot.format === 1) this.markDirty();
    }

    get(id: string): StoredChannel | undefined {
        return this.channels.get(id);
    }

    /** Creates a channel; false when it already exists. */
    create(info: ChannelInfo): boolean {
        if (this.channels.has(info.id)) return false;
        if (this.bytes + envelopeBytes(info) > this.opts.maxStateBytes) {
            throw new P2PError("STATE_TOO_LARGE", `State would exceed ${this.opts.maxStateBytes}`);
        }
        this.add(info);
        this.markDirty();
        return true;
    }

    /** Replaces a channel's meta; STATE_TOO_LARGE when the larger envelope does not fit. */
    updateMeta(channel: StoredChannel, meta: Record<string, unknown>): ChannelInfo {
        const info = { ...channel.info, meta };
        const delta = envelopeBytes(info) - envelopeBytes(channel.info);
        if (delta > 0 && this.bytes + delta > this.opts.maxStateBytes) {
            throw new P2PError("STATE_TOO_LARGE", `State would exceed ${this.opts.maxStateBytes}`);
        }
        channel.info = info;
        this.resize(channel, delta);
        this.markDirty();
        return info;
    }

    delete(id: string): boolean {
        const channel = this.channels.get(id);
        if (!channel) return false;
        this.channels.delete(id);
        this.bytes -= channel.bytes;
        this.markDirty();
        return true;
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

    set(channel: StoredChannel, key: string, entry: Entry): WriteOutcome {
        this.observe(entry.version[0]);
        const current = channel.entries.get(key);
        if (current && compareVersion(entry.version, current.version) <= 0) {
            return { applied: false, entry: current, created: false };
        }
        const delta = entryBytes(key, entry) - (current ? entryBytes(key, current) : 0);
        if (!entry.deleted && delta > 0 && this.bytes + delta > this.opts.maxStateBytes) {
            throw new P2PError("STATE_TOO_LARGE", `State would exceed ${this.opts.maxStateBytes}`);
        }
        applyEntry(channel.entries, key, entry);
        this.resize(channel, delta);
        this.noteWrite(channel, entry);
        this.markDirty();
        return { applied: true, entry, created: created(current, entry) };
    }

    /** Applies a batch whole or not at all: sizes are checked before any op, then LWW per key. */
    setBatch(channel: StoredChannel, ops: BatchOp[]): WriteOutcome[] {
        for (const op of ops) this.observe(op.entry.version[0]);
        let delta = 0;
        const wins = ops.map(({ key, entry }) => {
            const current = channel.entries.get(key);
            if (current && compareVersion(entry.version, current.version) <= 0) return false;
            delta += entryBytes(key, entry) - (current ? entryBytes(key, current) : 0);
            return true;
        });
        if (delta > 0 && this.bytes + delta > this.opts.maxStateBytes) {
            throw new P2PError("STATE_TOO_LARGE", `State would exceed ${this.opts.maxStateBytes}`);
        }
        const results = ops.map(({ key, entry }, i) => {
            const current = channel.entries.get(key);
            if (!wins[i]) return { applied: false, entry: current!, created: false };
            applyEntry(channel.entries, key, entry);
            this.noteWrite(channel, entry);
            return { applied: true, entry, created: created(current, entry) };
        });
        this.resize(channel, delta);
        if (wins.some(Boolean)) this.markDirty();
        return results;
    }

    /** Tombstones every live entry of the channel older than version (optionally under prefix). */
    clear(
        channel: StoredChannel,
        version: Version,
        updatedBy: string,
        deviceId: string,
        prefix?: string,
        tag?: string
    ): string[] {
        this.observe(version[0]);
        const cleared: string[] = [];
        const stone = tombstone(version, updatedBy, deviceId, this.opts.now(), tag);
        for (const [key, entry] of channel.entries) {
            if (entry.deleted || (prefix && !key.startsWith(prefix))) continue;
            if (compareVersion(version, entry.version) <= 0) continue;
            this.resize(channel, entryBytes(key, stone) - entryBytes(key, entry));
            channel.entries.set(key, stone);
            cleared.push(key);
        }
        if (cleared.length) {
            this.noteWrite(channel, stone);
            this.markDirty();
        }
        return cleared;
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

    private noteWrite(channel: StoredChannel, entry: Entry): void {
        if (!channel.lastWrite || entry.updatedAt >= channel.lastWrite.at) {
            channel.lastWrite = { at: entry.updatedAt, by: entry.updatedBy };
        }
    }

    private add(info: ChannelInfo): StoredChannel {
        const channel: StoredChannel = { info, entries: new Map(), bytes: 0, lastWrite: null };
        this.channels.set(info.id, channel);
        this.resize(channel, envelopeBytes(info));
        return channel;
    }

    private resize(channel: StoredChannel, delta: number): void {
        channel.bytes += delta;
        this.bytes += delta;
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
        for (const channel of this.channels.values()) {
            for (const [key, entry] of channel.entries) {
                if (entry.deleted && entry.updatedAt < cutoff) {
                    channel.entries.delete(key);
                    this.resize(channel, -entryBytes(key, entry));
                }
            }
        }
    }

    private serialize(): string {
        const channels: Record<string, unknown> = {};
        for (const { info, entries } of this.channels.values()) {
            const { createdAt, createdBy, meta } = info;
            channels[info.id] = {
                createdAt,
                createdBy,
                meta,
                entries: Object.fromEntries(entries),
            };
        }
        const savedAt = this.opts.now();
        return JSON.stringify({ format: FORMAT, savedAt, clock: this.clock, channels });
    }

    private async write(): Promise<void> {
        if (!this.dirty) return;
        this.dirty = false;
        this.purgeTombstones();
        const body = this.serialize();
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
