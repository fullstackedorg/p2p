// One channel's shared state: operations and incoming state frames. See docs/3-subsystems/state-store.md §7.
import { encodedSize } from "../protocol/codec.ts";
import { P2PError } from "../protocol/errors.ts";
import { isVersion, tombstone } from "../protocol/lww.ts";
import {
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
    /** `true` for this client's own writes (fired before the Server acknowledges them). */
    local: boolean;
    /** How a remote change arrived; `null` for local writes. */
    transport: Transport | null;
};

/** Result of `setState` / `deleteState`: `applied: false` when a concurrent newer write won. */
export type WriteResult = { applied: boolean };

/** The channel a SharedState belongs to: its id, its events, its other subscribers. */
export type StateScope = {
    id: string;
    emit(event: string, ...args: any[]): unknown;
    recipients(): PeerInfo[];
};

export class SharedState {
    replica = new Replica();
    private ctx: ClientContext;
    private scope: StateScope;

    constructor(ctx: ClientContext, scope: StateScope) {
        this.ctx = ctx;
        this.scope = scope;
    }

    private changed(key: string, entry: Entry, local: boolean, transport: Transport | null): void {
        this.scope.emit("state:changed", {
            key,
            value: entry.deleted ? undefined : entry.value,
            deleted: entry.deleted,
            updatedBy: entry.updatedBy,
            local,
            transport,
        } satisfies StateChange);
    }

    private prepare(key: unknown, extra: Record<string, unknown>): Frame {
        if (!isKey(key)) throw new P2PError("INVALID_ARGUMENT", "key must be 1-256 characters");
        const conn = socketOf(this.ctx);
        const version = [2 ** 52, this.ctx.sessionId];
        const probe = { type: "state:set", channel: this.scope.id, key, ...extra, version };
        const worst = { ...probe, reqId: 2 ** 31, deliveredTo: this.ctx.links?.openIds() ?? [] };
        if (encodedSize(worst) > conn.maxPayloadBytes) {
            throw new P2PError("PAYLOAD_TOO_LARGE", "State value too large");
        }
        return probe;
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
        const shown = previous ?? tombstone([1, this.ctx.sessionId], this.ctx.peerId, Date.now());
        this.changed(key, shown, true, null);
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
        const entry: Entry = deleted
            ? tombstone(version, this.ctx.peerId, Date.now())
            : { ...previous!, version, updatedBy: this.ctx.peerId, updatedAt: Date.now() };
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
        const entry: Entry = {
            value,
            deleted: false,
            version,
            updatedBy: this.ctx.peerId,
            updatedAt: Date.now(),
        };
        const body = { type: "state:set", channel: this.scope.id, key, value, version };
        return this.write("state:set", key, entry, body);
    }

    async delete(key: string): Promise<WriteResult> {
        this.prepare(key, {});
        const version = this.replica.nextVersion(this.ctx.sessionId);
        const entry = tombstone(version, this.ctx.peerId, Date.now());
        const body = { type: "state:delete", channel: this.scope.id, key, version };
        return this.write("state:delete", key, entry, body);
    }

    async clear(): Promise<{ applied: boolean; count: number }> {
        const conn = socketOf(this.ctx);
        const version = this.replica.nextVersion(this.ctx.sessionId);
        this.applyClear(version, this.ctx.peerId, true, null);
        const body = { type: "state:clear", channel: this.scope.id, version };
        const reached = overLinks(this.ctx, this.scope.recipients(), body, false);
        const ack = await conn.request({ ...body, deliveredTo: reached });
        return { applied: true, count: typeof ack.count === "number" ? ack.count : 0 };
    }

    private applyClear(version: Version, updatedBy: string, local: boolean, t: Transport | null) {
        const keys = this.replica.clear(version, updatedBy, Date.now());
        for (const key of keys) this.changed(key, this.replica.entries.get(key)!, local, t);
        this.scope.emit("state:cleared", { updatedBy, local });
    }

    /** state:set / state:delete / state:clear over a link, state:changed / state:cleared relayed. */
    handle(frame: Frame, from: string, transport: Transport): void {
        if (frame.type === "state:changed") {
            const entry = frame.entry as Entry;
            if (!isKey(frame.key) || !entry || !isVersion(entry.version)) return;
            if (this.replica.apply(frame.key, entry))
                this.changed(frame.key, entry, false, transport);
            return;
        }
        if (frame.type === "state:cleared") {
            if (isVersion(frame.version))
                this.applyClear(frame.version, String(frame.updatedBy), false, transport);
            return;
        }
        // link frames: the version must be the sender's own
        const sender = this.ctx.peers.get(from);
        if (!sender || !isVersion(frame.version) || frame.version[1] !== from) return;
        if (frame.type === "state:clear") {
            return this.applyClear(frame.version, sender.peerId, false, transport);
        }
        if (!isKey(frame.key)) return;
        const entry: Entry =
            frame.type === "state:delete"
                ? tombstone(frame.version, sender.peerId, Date.now())
                : {
                      value: frame.value ?? null,
                      deleted: false,
                      version: frame.version,
                      updatedBy: sender.peerId,
                      updatedAt: Date.now(),
                  };
        if (this.replica.apply(frame.key, entry)) this.changed(frame.key, entry, false, transport);
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
                    local: false,
                    transport: "socket",
                });
        }
    }
}
