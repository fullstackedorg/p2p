// schema and query. See docs/3-subsystems/inspection.md.
import { P2PError, readOnlyError } from "../protocol/errors.ts";
import { tombstone, valueType } from "../protocol/lww.ts";
import { isId, isKey, type Entry, type Frame } from "../protocol/types.ts";
import { sendRecipients, type HandlerContext } from "./handlers.ts";

const SCHEMA_KEYS = 1_000;

export type InspectLimits = { maxStateBytes: number; maxConnections: number };

export function schema(ctx: HandlerContext, limits: InspectLimits): Record<string, unknown> {
    const { room } = ctx;
    const peers = [...room.peers.values()];
    const live = [...room.store.entries]
        .filter(([, e]) => !e.deleted)
        .sort(([a], [b]) => (a < b ? -1 : 1));
    return {
        storageBytes: room.store.size,
        maxStateBytes: limits.maxStateBytes,
        connections: room.connections,
        maxConnections: limits.maxConnections,
        userCount: room.byPeerId.size,
        peerCount: peers.length,
        peers: peers.map((m) => ({
            ...room.info(m),
            links: { ...m.links },
            socketWritableBytes: m.writableLength(),
        })),
        inspectorCount: room.inspectors.size,
        stateKeyCount: live.length,
        stateKeys: live.slice(0, SCHEMA_KEYS).map(([key, e]) => ({
            key,
            type: valueType(e.value),
            sizeBytes: Buffer.byteLength(JSON.stringify(e.value)),
            updatedBy: e.updatedBy,
            updatedAt: e.updatedAt,
        })),
        stats: { ...room.stats },
    };
}

type Query = (ctx: HandlerContext, frame: Frame) => unknown;

function writer(ctx: HandlerContext): void {
    if (ctx.member.role === "ro") throw readOnlyError();
}

function key(frame: Frame): string {
    if (!isKey(frame.key)) throw new P2PError("INVALID_ARGUMENT", "key must be 1-256 characters");
    return frame.key;
}

function relayFrame(ctx: HandlerContext, frame: Frame): Frame {
    const out: Frame = { ...frame, from: ctx.member.sessionId };
    if (ctx.member.mode === "inspect")
        out.sender = { peerId: ctx.member.peerId, role: ctx.member.role };
    return out;
}

function stored(ctx: HandlerContext, k: string, entry: Entry): unknown {
    const result = ctx.room.store.set(k, entry);
    const out = relayFrame(ctx, { type: "state:changed", key: k, entry: result.entry });
    ctx.room.deliver(ctx.room.fanOut(ctx.member, []), out, "reliable");
    return result;
}

function getState(ctx: HandlerContext, frame: Frame): unknown {
    const limit = Math.min(Math.max(Number.isInteger(frame.limit) ? frame.limit : 100, 1), 1_000);
    const prefix = typeof frame.prefix === "string" ? frame.prefix : "";
    const after = typeof frame.after === "string" ? frame.after : null;
    let keys = [...ctx.room.store.entries]
        .filter(([k, e]) => !e.deleted && k.startsWith(prefix) && (after === null || k > after))
        .map(([k]) => k)
        .sort();
    if (frame.key !== undefined) keys = keys.filter((k) => k === frame.key);
    const page = keys.slice(0, limit);
    const entries = Object.fromEntries(page.map((k) => [k, ctx.room.store.entries.get(k)]));
    return keys.length > limit ? { entries, next: page[page.length - 1] } : { entries };
}

const QUERIES: Record<string, Query> = {
    peers: (ctx, frame) => {
        const peers = [...ctx.room.peers.values()];
        const subset = isId(frame.peerId) ? peers.filter((m) => m.peerId === frame.peerId) : peers;
        return subset.map((m) => ctx.room.info(m));
    },
    getState,
    setState: (ctx, frame) => {
        writer(ctx);
        const version = ctx.room.store.nextVersion(ctx.member.sessionId);
        const entry: Entry = {
            value: frame.value ?? null,
            deleted: false,
            version,
            updatedBy: ctx.member.peerId,
            updatedAt: ctx.now(),
        };
        return stored(ctx, key(frame), entry);
    },
    deleteState: (ctx, frame) => {
        writer(ctx);
        const version = ctx.room.store.nextVersion(ctx.member.sessionId);
        return stored(ctx, key(frame), tombstone(version, ctx.member.peerId, ctx.now()));
    },
    clearState: (ctx, frame) => {
        writer(ctx);
        const version = ctx.room.store.nextVersion(ctx.member.sessionId);
        const prefix = typeof frame.prefix === "string" && frame.prefix ? frame.prefix : undefined;
        const cleared = ctx.room.store.clear(version, ctx.member.peerId, prefix);
        // peers apply clears per key so a prefix clear stays exact
        for (const k of cleared) {
            const entry = ctx.room.store.entries.get(k)!;
            const out = relayFrame(ctx, { type: "state:changed", key: k, entry });
            ctx.room.deliver(ctx.room.fanOut(ctx.member, []), out, "reliable");
        }
        return { applied: true, count: cleared.length };
    },
    broadcast: (ctx, frame) => {
        writer(ctx);
        const out = relayFrame(ctx, {
            type: "broadcast",
            msgId: queryMsgId(ctx),
            data: frame.data,
        });
        out.ephemeral = false;
        return { recipients: ctx.room.deliver(ctx.room.fanOut(ctx.member, []), out, "reliable") };
    },
    send: (ctx, frame) => {
        writer(ctx);
        const recipients = sendRecipients(ctx, frame.to, []);
        const out = relayFrame(ctx, { type: "send", msgId: queryMsgId(ctx), data: frame.data });
        out.ephemeral = false;
        return { recipients: ctx.room.deliver(recipients, out, "reliable") };
    },
};

let querySeq = 0;
function queryMsgId(ctx: HandlerContext): string {
    return `${ctx.member.sessionId}:q${++querySeq}`;
}

export function query(ctx: HandlerContext, frame: Frame): unknown {
    const run = typeof frame.operation === "string" ? QUERIES[frame.operation] : undefined;
    if (!run) throw new P2PError("INVALID_ARGUMENT", "Unknown query operation");
    return run(ctx, frame);
}
