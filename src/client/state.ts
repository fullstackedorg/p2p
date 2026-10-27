// One channel's shared state: operations and incoming state frames. See docs/3-subsystems/state-store.md §7.
import { encodedSize } from "../protocol/codec.ts";
import { P2PError } from "../protocol/errors.ts";
import { tombstone } from "../protocol/lww.ts";
import {
    LIMITS,
    isKey,
    type Entry,
    type Frame,
    type Transport,
    type Version,
} from "../protocol/types.ts";
import { overLinks, socketOf, type ClientContext } from "./context.ts";
import { LiveValues, type LiveValue } from "./live.ts";
import { Replica } from "./replica.ts";
import { handleStateFrame } from "./state-incoming.ts";
import {
    changeOf,
    requireTag,
    type StateCleared,
    type StateScope,
    type WriteOptions,
    type WriteResult,
} from "./state-types.ts";

export type { StateChange, StateCleared, WriteOptions, WriteResult } from "./state-types.ts";
export { changeOf } from "./state-types.ts";

type BatchOp = { key: string; value?: unknown; deleted?: true };

export class SharedState {
    replica = new Replica();
    live: LiveValues;
    private ctx: ClientContext;
    private scope: StateScope;

    constructor(ctx: ClientContext, scope: StateScope) {
        this.ctx = ctx;
        this.scope = scope;
        this.live = new LiveValues(ctx.liveTtlMs, (key) => this.reverted(key));
    }

    /** Every visible value: stored live keys, with live values on top. */
    values(): Record<string, unknown> {
        const out = this.replica.values();
        for (const key of this.live.keys()) out[key] = this.live.get(key)!.value;
        return out;
    }

    get(key: string): unknown {
        const live = this.live.get(key);
        return live ? live.value : this.replica.get(key);
    }

    private visible(key: string): boolean {
        return this.live.get(key) !== undefined || this.replica.get(key) !== undefined;
    }

    /** Applies a stored entry; it ends any live value of the key. */
    /** @internal */
    commit(key: string, entry: Entry, local: boolean, t: Transport | null): boolean {
        const before = this.visible(key);
        if (!this.replica.apply(key, entry)) return false;
        this.live.drop(key);
        this.changed(key, entry, !before && !entry.deleted, local, t);
        return true;
    }

    private changed(
        key: string,
        entry: Entry,
        created: boolean,
        local: boolean,
        t: Transport | null
    ) {
        this.scope.emit(
            "state:changed",
            changeOf(key, entry, { created, live: false, local, transport: t })
        );
    }

    /** A live value ended without a stored write: show the stored value again. */
    private reverted(key: string): void {
        const entry = this.replica.entries.get(key) ?? tombstone([1, ""], "", "", Date.now());
        const src = { created: false, live: false, local: false, transport: null };
        this.scope.emit("state:changed", changeOf(key, entry, src));
    }

    private entry(version: Version, value: unknown, deleted: boolean, tag?: string): Entry {
        const { peerId, deviceId } = this.ctx;
        if (deleted) return tombstone(version, peerId, deviceId, Date.now(), tag);
        const entry: Entry = {
            value,
            deleted: false,
            version,
            updatedBy: peerId,
            deviceId,
            updatedAt: Date.now(),
        };
        if (tag !== undefined) entry.tag = tag;
        return entry;
    }

    private checkSize(frame: Frame): void {
        const worst = { ...frame, reqId: 2 ** 31, deliveredTo: this.ctx.links?.openIds() ?? [] };
        if (encodedSize(worst) > socketOf(this.ctx).maxPayloadBytes) {
            throw new P2PError("PAYLOAD_TOO_LARGE", "State value too large");
        }
    }

    private body(type: string, key: unknown, extra: Record<string, unknown>): Frame {
        if (!isKey(key)) throw new P2PError("INVALID_ARGUMENT", "key must be 1-256 characters");
        const frame: Frame = { type, channel: this.scope.id, key, ...extra };
        if (frame.tag === undefined) delete frame.tag;
        this.checkSize({ ...frame, version: [2 ** 52, this.ctx.sessionId] });
        return frame;
    }

    private async write(key: string, entry: Entry, body: Frame): Promise<WriteResult> {
        const previous = this.replica.entries.get(key);
        this.commit(key, entry, true, null);
        const reached = overLinks(this.ctx, this.scope.recipients(), body, false);
        let ack: Frame;
        try {
            ack = await socketOf(this.ctx).request({ ...body, deliveredTo: reached });
        } catch (err) {
            if (reached.length && (err as P2PError).code !== "DISCONNECTED") {
                this.compensate(key, entry, previous);
            } else if (this.replica.entries.get(key) === entry) this.restore(key, previous);
            throw err;
        }
        if (ack.applied === false && ack.entry) {
            this.commit(key, ack.entry, false, "socket");
            return { applied: false };
        }
        return { applied: true };
    }

    /** Puts the previous entry back locally (nobody else saw the rejected write). */
    private restore(key: string, previous: Entry | undefined): void {
        if (previous) this.replica.entries.set(key, previous);
        else this.replica.entries.delete(key);
        const shown = previous ?? this.entry([1, this.ctx.sessionId], null, true);
        this.changed(key, shown, false, true, null);
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
        this.commit(key, this.entry(version, previous?.value, deleted), true, null);
        const reached = overLinks(this.ctx, this.scope.recipients(), body, false);
        socketOf(this.ctx)
            .request({ ...body, deliveredTo: reached })
            .catch(() => {});
    }

    async set(key: string, value: unknown, opts: WriteOptions = {}): Promise<WriteResult> {
        const tag = requireTag(opts.tag);
        const body = this.body("state:set", key, { value, tag });
        const version = this.replica.nextVersion(this.ctx.sessionId);
        return this.write(key, this.entry(version, value, false, tag), { ...body, version });
    }

    async delete(key: string, opts: WriteOptions = {}): Promise<WriteResult> {
        const tag = requireTag(opts.tag);
        const body = this.body("state:delete", key, { tag });
        const version = this.replica.nextVersion(this.ctx.sessionId);
        return this.write(key, this.entry(version, null, true, tag), { ...body, version });
    }

    /** A live value: shown here and sent as an ephemeral frame, never stored. */
    setLive(key: string, value: unknown, opts: WriteOptions = {}): WriteResult {
        const tag = requireTag(opts.tag);
        const body = this.body("state:live", key, { value, tag });
        // the next stored write of this client gets the same version, so it ends this value
        const version: Version = [this.replica.clock + 1, this.ctx.sessionId];
        const { peerId, deviceId } = this.ctx;
        this.showLive(
            key,
            { value, version, updatedBy: peerId, deviceId, tag, at: Date.now() },
            true,
            null
        );
        const recipients = this.scope.recipients();
        const frame = { ...body, version };
        const reached = overLinks(this.ctx, recipients, frame, true);
        if (reached.length < recipients.length || this.scope.observed())
            socketOf(this.ctx).send({ ...frame, deliveredTo: reached });
        return { applied: true };
    }

    /** @internal */
    showLive(key: string, live: LiveValue, local: boolean, t: Transport | null): void {
        if (live.tag === undefined) delete live.tag;
        const created = !this.visible(key);
        this.live.set(key, live);
        this.scope.emit(
            "state:changed",
            changeOf(key, live, { created, live: true, local, transport: t })
        );
    }

    /** Live values of a session that left the channel end. */
    dropLive(sessionId: string): void {
        for (const key of this.live.dropFrom(sessionId)) this.reverted(key);
    }

    /** Several writes in one frame, through the Server only; restored together on rejection. */
    async batch(ops: BatchOp[], opts: WriteOptions = {}): Promise<Record<string, WriteResult>> {
        if (ops.length === 0) return {};
        const tag = requireTag(opts.tag);
        const keys = new Set(ops.map((op) => op.key));
        if (ops.length > LIMITS.batchOps || keys.size !== ops.length || ![...keys].every(isKey)) {
            throw new P2PError("INVALID_ARGUMENT", "1-1000 distinct keys of 1-256 characters");
        }
        const conn = socketOf(this.ctx);
        const probe: Frame = { type: "state:batch", channel: this.scope.id, ops };
        if (tag) probe.tag = tag;
        this.checkSize({ ...probe, version: [2 ** 52, this.ctx.sessionId] });
        const version = this.replica.nextVersion(this.ctx.sessionId);
        const applied = ops.map((op) => {
            const entry = this.entry(version, op.value, op.deleted === true, tag);
            const previous = this.replica.entries.get(op.key);
            this.commit(op.key, entry, true, null);
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
            if (result.applied === false && result.entry)
                this.commit(key, result.entry, false, "socket");
            out[key] = { applied: result.applied !== false };
        });
        return out;
    }

    async clear(
        opts: { prefix?: string; tag?: string } = {}
    ): Promise<{ applied: boolean; count: number }> {
        const tag = requireTag(opts.tag);
        const conn = socketOf(this.ctx);
        const version = this.replica.nextVersion(this.ctx.sessionId);
        const { peerId, sessionId, deviceId } = this.ctx;
        const who = { updatedBy: peerId, sessionId, deviceId, prefix: opts.prefix, tag };
        this.applyClear(version, who, true, null);
        const body: Frame = { type: "state:clear", channel: this.scope.id, version };
        if (opts.prefix) body.prefix = opts.prefix;
        if (tag) body.tag = tag;
        const reached = overLinks(this.ctx, this.scope.recipients(), body, false);
        const ack = await conn.request({ ...body, deliveredTo: reached });
        return { applied: true, count: typeof ack.count === "number" ? ack.count : 0 };
    }

    /** @internal */
    applyClear(
        version: Version,
        who: Omit<StateCleared, "local">,
        local: boolean,
        t: Transport | null
    ) {
        const now = Date.now();
        const keys = this.replica.clear(version, who.updatedBy, who.deviceId, now, who.prefix);
        for (const key of keys) {
            this.live.drop(key);
            const stone = {
                ...this.replica.entries.get(key)!,
                ...(who.tag ? { tag: who.tag } : {}),
            };
            this.changed(key, stone, false, local, t);
        }
        const info: StateCleared = { ...who, local };
        if (!who.prefix) delete info.prefix;
        if (!who.tag) delete info.tag;
        this.scope.emit("state:cleared", info);
    }

    /** Relayed state frames, or state frames over a link. */
    handle(frame: Frame, from: string, transport: Transport): void {
        handleStateFrame(this, this.ctx, frame, from, transport);
    }

    /** Rebuilds from a subscribe ack and reports every key whose visible value changed. */
    reload(state: Record<string, Entry>, clock: number): void {
        const before = this.values();
        this.live.clear();
        this.replica.load(state, clock);
        const after = this.values();
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
            const entry = this.replica.entries.get(key);
            if (entry)
                this.changed(key, entry, !(key in before) && !entry.deleted, false, "socket");
            else this.reverted(key);
        }
    }

    /** The channel ended: live values and their timer go. */
    stop(): void {
        this.live.clear();
    }
}
