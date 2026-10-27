// Channel frames about state and leases. See docs/1-concepts/protocol-spec.md §5.3–§5.4.
import { tombstone } from "../protocol/lww.ts";
import {
    LIMITS,
    isKey,
    isPlainObject,
    isTag,
    type Entry,
    type Frame,
    type Version,
} from "../protocol/types.ts";
import {
    channelRecipients,
    invalid,
    relayed,
    requireVersion,
    type Handler,
    type HandlerContext,
} from "./frames.ts";

/** The entry a member writes: a value, or a tombstone. */
export function memberEntry(
    ctx: HandlerContext,
    version: Version,
    value: unknown,
    deleted: boolean,
    tag?: string
): Entry {
    const { peerId, deviceId } = ctx.member;
    if (deleted) return tombstone(version, peerId, deviceId, ctx.now(), tag);
    const entry: Entry = {
        value: value ?? null,
        deleted: false,
        version,
        updatedBy: peerId,
        deviceId,
        updatedAt: ctx.now(),
    };
    if (tag !== undefined) entry.tag = tag;
    return entry;
}

export function requireTag(tag: unknown): string | undefined {
    if (!isTag(tag)) throw invalid("tag must be a string of 1-128 characters");
    return tag;
}

function writeEntry(ctx: HandlerContext, frame: Frame, deleted: boolean): void {
    const channel = ctx.channels.subscribed(ctx.member, frame.channel);
    if (!isKey(frame.key)) throw invalid("key must be a string of 1-256 characters");
    const version = requireVersion(ctx, frame.version);
    const entry = memberEntry(ctx, version, frame.value, deleted, requireTag(frame.tag));
    const result = ctx.store.set(channel, frame.key, entry);
    if (!result.applied) return ctx.ack(frame, { applied: false, entry: result.entry });
    ctx.ack(frame, { applied: true, entry: result.entry });
    const out = relayed(ctx, {
        type: "state:changed",
        channel: channel.info.id,
        key: frame.key,
        entry: result.entry,
        created: result.created,
    });
    ctx.registry.deliver(channelRecipients(ctx, channel, frame.deliveredTo), out, "reliable");
    ctx.channels.stats.touched(channel);
}

const stateClear: Handler = (ctx, frame) => {
    const channel = ctx.channels.subscribed(ctx.member, frame.channel);
    const version = requireVersion(ctx, frame.version);
    if (frame.prefix !== undefined && typeof frame.prefix !== "string")
        throw invalid("prefix must be a string");
    const prefix = frame.prefix || undefined;
    const tag = requireTag(frame.tag);
    const { peerId, deviceId } = ctx.member;
    const cleared = ctx.store.clear(channel, version, peerId, deviceId, prefix, tag);
    ctx.ack(frame, { applied: true, count: cleared.length });
    const out = relayed(ctx, {
        type: "state:cleared",
        channel: channel.info.id,
        version,
        updatedBy: peerId,
        deviceId,
    });
    if (prefix) out.prefix = prefix;
    if (tag) out.tag = tag;
    ctx.registry.deliver(channelRecipients(ctx, channel, frame.deliveredTo), out, "reliable");
    if (cleared.length) ctx.channels.stats.touched(channel);
};

const stateBatch: Handler = (ctx, frame) => {
    const channel = ctx.channels.subscribed(ctx.member, frame.channel);
    const version = requireVersion(ctx, frame.version);
    const tag = requireTag(frame.tag);
    const ops = frame.ops;
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > LIMITS.batchOps)
        throw invalid("ops must hold 1-1000 operations");
    const keys = new Set<string>();
    const batch = ops.map((op: any) => {
        if (!isPlainObject(op) || !isKey(op.key) || keys.has(op.key))
            throw invalid("each op needs a distinct key of 1-256 characters");
        keys.add(op.key);
        const entry = memberEntry(ctx, version, op.value, op.deleted === true, tag);
        return { key: op.key, entry };
    });
    const results = ctx.store.setBatch(channel, batch);
    ctx.ack(frame, {
        results: results.map((r) =>
            r.applied ? { applied: true } : { applied: false, entry: r.entry }
        ),
    });
    const changes = batch
        .map((op, i) => ({ ...op, created: results[i].created, applied: results[i].applied }))
        .filter((c) => c.applied)
        .map(({ key, entry, created }) => ({ key, entry, created }));
    if (!changes.length) return;
    const out = relayed(ctx, { type: "state:changes", channel: channel.info.id, changes });
    ctx.registry.deliver(channelRecipients(ctx, channel, []), out, "reliable");
    ctx.channels.stats.touched(channel);
};

/** A live value: checked and relayed as an ephemeral frame, never stored. */
const stateLive: Handler = (ctx, frame) => {
    const channel = ctx.channels.subscribed(ctx.member, frame.channel);
    if (!isKey(frame.key)) throw invalid("key must be a string of 1-256 characters");
    const version = requireVersion(ctx, frame.version);
    const out = relayed(ctx, {
        type: "state:live",
        channel: channel.info.id,
        key: frame.key,
        value: frame.value ?? null,
        version,
    });
    const tag = requireTag(frame.tag);
    if (tag) out.tag = tag;
    ctx.registry.deliver(channelRecipients(ctx, channel, frame.deliveredTo), out, "ephemeral");
};

const lease: Handler = (ctx, frame) => {
    const { info } = ctx.channels.subscribed(ctx.member, frame.channel);
    const { name, ttlMs, wait } = frame;
    ctx.ack(frame, ctx.channels.leases.request(info.id, ctx.member, { name, ttlMs, wait }));
};

const leaseRelease: Handler = (ctx, frame) => {
    const { info } = ctx.channels.subscribed(ctx.member, frame.channel);
    ctx.ack(frame, { released: ctx.channels.leases.release(info.id, ctx.member, frame.name) });
};

export const STATE_HANDLERS: Record<string, Handler> = {
    "state:set": (ctx, frame) => writeEntry(ctx, frame, false),
    "state:delete": (ctx, frame) => writeEntry(ctx, frame, true),
    "state:clear": stateClear,
    "state:batch": stateBatch,
    "state:live": stateLive,
    lease,
    "lease:release": leaseRelease,
};
