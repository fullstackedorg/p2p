// schema and query. See docs/3-subsystems/inspection.md.
import { P2PError } from "../protocol/errors.ts";
import { tombstone, valueType } from "../protocol/lww.ts";
import { isId, isKey, type Entry, type Frame } from "../protocol/types.ts";
import { channelId } from "./channels.ts";
import { sendRecipients, type HandlerContext } from "./handlers.ts";
import type { StoredChannel } from "./state-store.ts";

const SCHEMA_KEYS = 1_000;

export type InspectLimits = { maxStateBytes: number; maxConnections: number; maxChannels: number };

function liveKeys(channel: StoredChannel): [string, Entry][] {
    return [...channel.entries].filter(([, e]) => !e.deleted).sort(([a], [b]) => (a < b ? -1 : 1));
}

function channelSchema(ctx: HandlerContext, id: unknown): Record<string, unknown> {
    const channel = ctx.channels.require(id);
    const live = liveKeys(channel);
    return {
        ...channel.info,
        sizeBytes: channel.bytes,
        subscribers: ctx.channels.subscribers(channel.info.id).map((m) => ({
            sessionId: m.sessionId,
            peerId: m.peerId,
            meta: m.channels.get(channel.info.id),
        })),
        keyCount: live.length,
        keys: live.slice(0, SCHEMA_KEYS).map(([key, e]) => ({
            key,
            type: valueType(e.value),
            sizeBytes: Buffer.byteLength(JSON.stringify(e.value)),
            updatedBy: e.updatedBy,
            updatedAt: e.updatedAt,
        })),
    };
}

export function schema(ctx: HandlerContext, frame: Frame, limits: InspectLimits): unknown {
    if (frame.channel !== undefined) return channelSchema(ctx, frame.channel);
    const { registry, store } = ctx;
    const peers = [...registry.peers.values()];
    return {
        storageBytes: store.size,
        maxStateBytes: limits.maxStateBytes,
        connections: registry.connections,
        maxConnections: limits.maxConnections,
        userCount: registry.byPeerId.size,
        peerCount: peers.length,
        peers: peers.map((m) => ({
            ...registry.info(m),
            links: { ...m.links },
            socketWritableBytes: m.writableLength(),
        })),
        inspectorCount: registry.inspectors.size,
        channelCount: store.channels.size,
        maxChannels: limits.maxChannels,
        channels: ctx.channels.list().map((info) => {
            const channel = store.get(info.id)!;
            return {
                ...info,
                subscriberCount: ctx.channels.subscribers(info.id).length,
                keyCount: liveKeys(channel).length,
                sizeBytes: channel.bytes,
            };
        }),
        stats: { ...registry.stats },
    };
}

type Query = (ctx: HandlerContext, frame: Frame) => unknown;

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

/** Relays a frame to every subscriber of the channel but the caller. */
function toSubscribers(ctx: HandlerContext, channel: StoredChannel, frame: Frame): number {
    const subscribers = ctx.channels.subscribers(channel.info.id);
    const recipients = ctx.registry.fanOut(subscribers, ctx.member, []);
    return ctx.registry.deliver(recipients, relayFrame(ctx, frame), "reliable");
}

function stored(ctx: HandlerContext, channel: StoredChannel, k: string, entry: Entry): unknown {
    const result = ctx.store.set(channel, k, entry);
    const id = channel.info.id;
    toSubscribers(ctx, channel, {
        type: "state:changed",
        channel: id,
        key: k,
        entry: result.entry,
    });
    return result;
}

function getState(ctx: HandlerContext, frame: Frame): unknown {
    const channel = ctx.channels.require(frame.channel);
    const limit = Math.min(Math.max(Number.isInteger(frame.limit) ? frame.limit : 100, 1), 1_000);
    const prefix = typeof frame.prefix === "string" ? frame.prefix : "";
    const after = typeof frame.after === "string" ? frame.after : null;
    let keys = liveKeys(channel)
        .map(([k]) => k)
        .filter((k) => k.startsWith(prefix) && (after === null || k > after));
    if (frame.key !== undefined) keys = keys.filter((k) => k === frame.key);
    const page = keys.slice(0, limit);
    const entries = Object.fromEntries(page.map((k) => [k, channel.entries.get(k)]));
    return keys.length > limit ? { entries, next: page[page.length - 1] } : { entries };
}

const QUERIES: Record<string, Query> = {
    peers: (ctx, frame) => {
        let peers = [...ctx.registry.peers.values()];
        if (isId(frame.peerId)) peers = peers.filter((m) => m.peerId === frame.peerId);
        if (frame.channel !== undefined) {
            const id = channelId(frame.channel);
            peers = peers.filter((m) => m.channels.has(id));
        }
        return peers.map((m) => ctx.registry.info(m));
    },
    channels: (ctx, frame) => {
        const prefix = typeof frame.prefix === "string" ? frame.prefix : "";
        return ctx.channels.list().filter((c) => c.id.startsWith(prefix));
    },
    createChannel: (ctx, frame) => ctx.channels.create(ctx.member, frame.channel),
    deleteChannel: (ctx, frame) => {
        ctx.channels.delete(ctx.member, frame.channel);
        return { deleted: true };
    },
    getState,
    setState: (ctx, frame) => {
        const channel = ctx.channels.require(frame.channel);
        const entry: Entry = {
            value: frame.value ?? null,
            deleted: false,
            version: ctx.store.nextVersion(ctx.member.sessionId),
            updatedBy: ctx.member.peerId,
            updatedAt: ctx.now(),
        };
        return stored(ctx, channel, key(frame), entry);
    },
    deleteState: (ctx, frame) => {
        const channel = ctx.channels.require(frame.channel);
        const version = ctx.store.nextVersion(ctx.member.sessionId);
        return stored(ctx, channel, key(frame), tombstone(version, ctx.member.peerId, ctx.now()));
    },
    clearState: (ctx, frame) => {
        const channel = ctx.channels.require(frame.channel);
        const version = ctx.store.nextVersion(ctx.member.sessionId);
        const prefix = typeof frame.prefix === "string" && frame.prefix ? frame.prefix : undefined;
        const cleared = ctx.store.clear(channel, version, ctx.member.peerId, prefix);
        // subscribers apply clears per key so a prefix clear stays exact
        for (const k of cleared) {
            const entry = channel.entries.get(k)!;
            toSubscribers(ctx, channel, {
                type: "state:changed",
                channel: channel.info.id,
                key: k,
                entry,
            });
        }
        return { applied: true, count: cleared.length };
    },
    broadcast: (ctx, frame) => {
        const channel = ctx.channels.require(frame.channel);
        const out = {
            type: "broadcast",
            channel: channel.info.id,
            msgId: queryMsgId(ctx),
            data: frame.data,
            ephemeral: false,
        };
        return { recipients: toSubscribers(ctx, channel, out) };
    },
    send: (ctx, frame) => {
        const recipients = sendRecipients(ctx, frame.to, []);
        const out = relayFrame(ctx, { type: "send", msgId: queryMsgId(ctx), data: frame.data });
        out.ephemeral = false;
        return { recipients: ctx.registry.deliver(recipients, out, "reliable") };
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
