// One channel's shared state: operations and incoming state frames. See docs/3-subsystems/state-store.md §7.
import { encodedSize } from "../protocol/codec.ts";
import { P2PError } from "../protocol/errors.ts";
import { isVersion, tombstone } from "../protocol/lww.ts";
import {
    LIMITS,
    isKey,
    type Entry,
    type Frame,
    type PeerInfo,
    type Transport,
    type Version,
} from "../protocol/types.ts";
import { overLinks, socketOf, type ClientContext } from "./context.ts";
import { Replica } from "./replica.ts";

/** Payload of `state:changed`. */
export type StateChange = {
    key: string;
    /** The new value; `undefined` when `deleted`. */
    value: unknown;
    deleted: boolean;
    /** peerId of the writer. */
    updatedBy: string;
    /** sessionId of the writer. */
    sessionId: string;
    /** deviceId of the writer; `""` for entries written before protocol 3. */
    deviceId: string;
    /** `true` for this client's own writes (fired before the Server acknowledges them). */
    local: boolean;
    /** How a remote change arrived; `null` for local writes. */
    transport: Transport | null;
};

/** Payload of `state:cleared`. */
export type StateCleared = {
    updatedBy: string;
    sessionId: string;
    deviceId: string;
    /** Set when only the keys starting with it were cleared. */
    prefix?: string;
    local: boolean;
};

/** Result of `setState` / `deleteState`: `applied: false` when a concurrent newer write won. */
export type WriteResult = { applied: boolean };

/** The channel a SharedState belongs to: its id, its events, its other subscribers. */
export type StateScope = {
    id: string;
    emit(event: string, ...args: any[]): unknown;
    recipients(): PeerInfo[];
};

/** The `state:changed` payload for an entry. */
export function changeOf(
    key: string,
    entry: Entry,
    local: boolean,
    transport: Transport | null
): StateChange {
    return {
        key,
        value: entry.deleted ? undefined : entry.value,
        deleted: entry.deleted,
        updatedBy: entry.updatedBy,
        sessionId: entry.version[1],
        deviceId: entry.deviceId ?? "",
        local,
        transport,
    };
}

type BatchOp = { key: string; value?: unknown; deleted?: true };

export class SharedState {
    replica = new Replica();
    private ctx: ClientContext;
    private scope: StateScope;

    constructor(ctx: ClientContext, scope: StateScope) {
        this.ctx = ctx;
        this.scope = scope;
    }

    private changed(key: string, entry: Entry, local: boolean, transport: Transport | null): void {
        this.scope.emit("state:changed", changeOf(key, entry, local, transport));
    }

    private entry(version: Version, value: unknown, deleted: boolean): Entry {
        const { peerId, deviceId } = this.ctx;
        if (deleted) return tombstone(version, peerId, deviceId, Date.now());
        return {
            value,
            deleted: false,
            version,
            updatedBy: peerId,
            deviceId,
            updatedAt: Date.now(),
        };
    }

    private checkSize(frame: Frame): void {
        const worst = { ...frame, reqId: 2 ** 31, deliveredTo: this.ctx.links?.openIds() ?? [] };
        if (encodedSize(worst) > socketOf(this.ctx).maxPayloadBytes) {
            throw new P2PError("PAYLOAD_TOO_LARGE", "State value too large");
        }
    }

    private prepare(key: unknown, extra: Record<string, unknown>): void {
        if (!isKey(key)) throw new P2PError("INVALID_ARGUMENT", "key must be 1-256 characters");
        const version = [2 ** 52, this.ctx.sessionId];
        this.checkSize({ type: "state:set", channel: this.scope.id, key, ...extra, version });
    }

    private async write(
        type: string,
        key: string,
        entry: Entry,
        body: Frame
    ): Promise<WriteResult> {
        const previous = this.replica.entries.get(key);
        this.replica.apply(key, entry);
        this.changed(key, entry, true, null);
        const reached = overLinks(this.ctx, this.scope.recipients(), body, false);
        let ack: Frame;
        try {
            ack = await socketOf(this.ctx).request({ ...body, type, deliveredTo: reached });
        } catch (err) {
            if (reached.length && (err as P2PError).code !== "DISCONNECTED") {
                this.compensate(key, entry, previous);
            } else if (this.replica.entries.get(key) === entry) this.restore(key, previous);
            throw err;
        }
        if (ack.applied === false && ack.entry) {
            if (this.replica.apply(key, ack.entry)) this.changed(key, ack.entry, false, "socket");
            return { applied: false };
        }
        return { applied: true };
    }

    /** Puts the previous entry back locally (nobody else saw the rejected write). */
    private restore(key: string, previous: Entry | undefined): void {
        if (previous) this.replica.entries.set(key, previous);
        else this.replica.entries.delete(key);
        this.changed(key, previous ?? this.entry([1, this.ctx.sessionId], null, true), true, null);
    }

    /** Linked peers applied a write the Server refused: supersede it with the previous value. */
    private compensate(key: string, rejected: Entry, previous: Entry | undefined): void {
        if (this.replica.entries.get(key) !== rejected) return;
        const version = this.replica.nextVersion(this.ctx.sessionId);
        const deleted = !previous || previous.deleted;
        const channel = this.scope.id;
        const body: Frame = deleted
            ? { type: "state:delete", channel, key, version }
            : { type: "state:set", channel, key, value: previous!.value, version };
        const entry = this.entry(version, previous?.value, deleted);
        this.replica.apply(key, entry);
        this.changed(key, entry, true, null);
        const reached = overLinks(this.ctx, this.scope.recipients(), body, false);
        socketOf(this.ctx)
            .request({ ...body, deliveredTo: reached })
            .catch(() => {});
    }

    async set(key: string, value: unknown): Promise<WriteResult> {
        this.prepare(key, { value });
        const version = this.replica.nextVersion(this.ctx.sessionId);
        const body = { type: "state:set", channel: this.scope.id, key, value, version };
        return this.write("state:set", key, this.entry(version, value, false), body);
    }

    async delete(key: string): Promise<WriteResult> {
        this.prepare(key, {});
        const version = this.replica.nextVersion(this.ctx.sessionId);
        const body = { type: "state:delete", channel: this.scope.id, key, version };
        return this.write("state:delete", key, this.entry(version, null, true), body);
    }

    /** Several writes in one frame, through the Server only; restored together on rejection. */
    async batch(ops: BatchOp[]): Promise<Record<string, WriteResult>> {
        if (ops.length === 0) return {};
        const keys = new Set(ops.map((op) => op.key));
        if (ops.length > LIMITS.batchOps || keys.size !== ops.length || ![...keys].every(isKey)) {
            throw new P2PError("INVALID_ARGUMENT", "1-1000 distinct keys of 1-256 characters");
        }
        const conn = socketOf(this.ctx);
        const probe = { type: "state:batch", channel: this.scope.id, version: [2 ** 52, "x"], ops };
        this.checkSize({ ...probe, version: [2 ** 52, this.ctx.sessionId] });
        const version = this.replica.nextVersion(this.ctx.sessionId);
        const applied = ops.map((op) => {
            const entry = this.entry(version, op.value, op.deleted === true);
            const previous = this.replica.entries.get(op.key);
            this.replica.apply(op.key, entry);
            this.changed(op.key, entry, true, null);
            return { key: op.key, entry, previous };
        });
        let ack: Frame;
        try {
            ack = await conn.request({ ...probe, version });
        } catch (err) {
            for (const { key, entry, previous } of applied)
                if (this.replica.entries.get(key) === entry) this.restore(key, previous);
            throw err;
        }
        const out: Record<string, WriteResult> = {};
        applied.forEach(({ key }, i) => {
            const result = ack.results?.[i] ?? { applied: true };
            if (result.applied === false && result.entry && this.replica.apply(key, result.entry))
                this.changed(key, result.entry, false, "socket");
            out[key] = { applied: result.applied !== false };
        });
        return out;
    }

    async clear(prefix?: string): Promise<{ applied: boolean; count: number }> {
        const conn = socketOf(this.ctx);
        const version = this.replica.nextVersion(this.ctx.sessionId);
        const { peerId, sessionId, deviceId } = this.ctx;
        this.applyClear(version, { updatedBy: peerId, sessionId, deviceId, prefix }, true, null);
        const body: Frame = { type: "state:clear", channel: this.scope.id, version };
        if (prefix) body.prefix = prefix;
        const reached = overLinks(this.ctx, this.scope.recipients(), body, false);
        const ack = await conn.request({ ...body, deliveredTo: reached });
        return { applied: true, count: typeof ack.count === "number" ? ack.count : 0 };
    }

    private applyClear(
        version: Version,
        who: Omit<StateCleared, "local">,
        local: boolean,
        t: Transport | null
    ) {
        const now = Date.now();
        const keys = this.replica.clear(version, who.updatedBy, who.deviceId, now, who.prefix);
        for (const key of keys) this.changed(key, this.replica.entries.get(key)!, local, t);
        const info: StateCleared = { ...who, local };
        if (!who.prefix) delete info.prefix;
        this.scope.emit("state:cleared", info);
    }

    /** Relayed state:changed / state:changes / state:cleared, or state frames over a link. */
    handle(frame: Frame, from: string, transport: Transport): void {
        if (frame.type === "state:changed") return this.remote(frame.key, frame.entry, transport);
        if (frame.type === "state:changes") {
            if (Array.isArray(frame.changes))
                for (const c of frame.changes) this.remote(c?.key, c?.entry, transport);
            return;
        }
        const prefix = typeof frame.prefix === "string" ? frame.prefix : undefined;
        if (frame.type === "state:cleared") {
            if (!isVersion(frame.version)) return;
            const who = {
                updatedBy: String(frame.updatedBy),
                sessionId: from,
                deviceId: String(frame.deviceId ?? ""),
                prefix,
            };
            return this.applyClear(frame.version, who, false, transport);
        }
        // link frames: the version must be the sender's own
        const sender = this.ctx.peers.get(from);
        if (!sender || !isVersion(frame.version) || frame.version[1] !== from) return;
        const { peerId: updatedBy, deviceId } = sender;
        if (frame.type === "state:clear") {
            const who = { updatedBy, sessionId: from, deviceId, prefix };
            return this.applyClear(frame.version, who, false, transport);
        }
        if (!isKey(frame.key)) return;
        const deleted = frame.type === "state:delete";
        const entry: Entry = deleted
            ? tombstone(frame.version, updatedBy, deviceId, Date.now())
            : {
                  value: frame.value ?? null,
                  deleted: false,
                  version: frame.version,
                  updatedBy,
                  deviceId,
                  updatedAt: Date.now(),
              };
        if (this.replica.apply(frame.key, entry)) this.changed(frame.key, entry, false, transport);
    }

    private remote(key: unknown, entry: Entry | undefined, transport: Transport): void {
        if (!isKey(key) || !entry || !isVersion(entry.version)) return;
        if (this.replica.apply(key, entry)) this.changed(key, entry, false, transport);
    }

    /** Rebuilds from a subscribe ack and reports every key whose live value changed. */
    reload(state: Record<string, Entry>, clock: number): void {
        const before = this.replica.values();
        this.replica.load(state, clock);
        const after = this.replica.values();
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
            const entry = this.replica.entries.get(key);
            if (entry) this.changed(key, entry, false, "socket");
            else
                this.scope.emit("state:changed", {
                    key,
                    value: undefined,
                    deleted: true,
                    updatedBy: "",
                    sessionId: "",
                    deviceId: "",
                    local: false,
                    transport: "socket",
                } satisfies StateChange);
        }
    }
}
