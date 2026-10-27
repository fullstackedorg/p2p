// Peer frames after authentication. See docs/1-concepts/protocol-spec.md §4–§6.
import { P2PError } from "../protocol/errors.ts";
import { isVersion, tombstone } from "../protocol/lww.ts";
import {
    LIMITS,
    isId,
    isKey,
    isPlainObject,
    isWireTarget,
    mergeMeta,
    type Entry,
    type Frame,
    type Version,
} from "../protocol/types.ts";
import type { Channels } from "./channels.ts";
import type { Member, Registry } from "./registry.ts";
import type { StateStore, StoredChannel } from "./state-store.ts";

export type HandlerContext = {
    registry: Registry;
    channels: Channels;
    store: StateStore;
    member: Member;
    now: () => number;
    ack(frame: Frame, extra?: Record<string, unknown>): void;
};

type Handler = (ctx: HandlerContext, frame: Frame) => void;

function invalid(message: string): P2PError {
    return new P2PError("INVALID_ARGUMENT", message);
}

function requireMsgId(ctx: HandlerContext, msgId: unknown): string {
    if (typeof msgId !== "string" || !msgId.startsWith(ctx.member.sessionId + ":")) {
        throw invalid("msgId must start with the sender's sessionId");
    }
    return msgId;
}

function peerBySession(ctx: HandlerContext, sessionId: unknown): Member {
    const target = typeof sessionId === "string" ? ctx.registry.peers.get(sessionId) : undefined;
    if (!target || target === ctx.member) throw new P2PError("PEER_NOT_FOUND", "Unknown peer");
    return target;
}

/** Recipients of a send: one session, or every session of a peerId but the sender's. */
export function sendRecipients(ctx: HandlerContext, to: unknown, deliveredTo: unknown): Member[] {
    if (!isWireTarget(to)) throw invalid("to must be { peerId } or { sessionId }");
    if ("sessionId" in to) {
        const target = peerBySession(ctx, to.sessionId);
        const skip = Array.isArray(deliveredTo) && deliveredTo.includes(target.sessionId);
        return skip ? [] : [target];
    }
    const sessions = ctx.registry.sessionsOf(to.peerId).filter((m) => m !== ctx.member);
    if (!sessions.length) throw new P2PError("PEER_NOT_FOUND", "No peer with that peerId");
    const skip = new Set(Array.isArray(deliveredTo) ? deliveredTo : []);
    return sessions.filter((m) => !skip.has(m.sessionId));
}

function relayed(ctx: HandlerContext, frame: Frame): Frame {
    const out: Frame = { ...frame, from: ctx.member.sessionId };
    delete out.reqId;
    delete out.deliveredTo;
    delete out.to;
    if (ctx.member.mode === "inspect")
        out.sender = { peerId: ctx.member.peerId, role: ctx.member.role };
    return out;
}

/** Recipients of a channel frame: the channel's subscribers but the sender and deliveredTo. */
function channelRecipients(
    ctx: HandlerContext,
    channel: StoredChannel,
    deliveredTo: unknown,
    filter?: (m: Member) => boolean
): Member[] {
    const audience = ctx.channels.audience(channel.info.id);
    return ctx.registry.fanOut(audience, ctx.member, deliveredTo, filter);
}

const presence: Handler = (ctx, frame) => {
    if (!isPlainObject(frame.meta)) throw invalid("meta must be an object");
    if (frame.name !== undefined && !isId(frame.name)) throw invalid("name must be 1-128 chars");
    ctx.member.meta = frame.merge === true ? mergeMeta(ctx.member.meta, frame.meta) : frame.meta;
    if (frame.name !== undefined) ctx.member.name = frame.name;
    ctx.ack(frame);
    ctx.registry.updated(ctx.member);
};

const subscribe: Handler = (ctx, frame) =>
    ctx.ack(frame, { ...ctx.channels.subscribe(ctx.member, frame) });

const unsubscribe: Handler = (ctx, frame) => {
    ctx.channels.unsubscribe(ctx.member, frame);
    ctx.ack(frame);
};

const channelPresence: Handler = (ctx, frame) => {
    ctx.channels.presence(ctx.member, frame);
    ctx.ack(frame);
};

const send: Handler = (ctx, frame) => {
    requireMsgId(ctx, frame.msgId);
    const recipients = sendRecipients(ctx, frame.to, frame.deliveredTo);
    const out = relayed(ctx, { type: "send", msgId: frame.msgId, data: frame.data });
    out.ephemeral = frame.ephemeral === true;
    const n = ctx.registry.deliver(recipients, out, out.ephemeral ? "ephemeral" : "reliable");
    ctx.ack(frame, { recipients: n });
};

const broadcast: Handler = (ctx, frame) => {
    const channel = ctx.channels.subscribed(ctx.member, frame.channel);
    requireMsgId(ctx, frame.msgId);
    const out = relayed(ctx, {
        type: "broadcast",
        channel: channel.info.id,
        msgId: frame.msgId,
        data: frame.data,
    });
    out.ephemeral = frame.ephemeral === true;
    const recipients = channelRecipients(ctx, channel, frame.deliveredTo);
    const n = ctx.registry.deliver(recipients, out, out.ephemeral ? "ephemeral" : "reliable");
    ctx.ack(frame, { recipients: n });
};

const request: Handler = (ctx, frame) => {
    requireMsgId(ctx, frame.msgId);
    if (!isWireTarget(frame.to) || !("sessionId" in frame.to))
        throw invalid("to must be { sessionId }");
    const target = peerBySession(ctx, frame.to.sessionId);
    const timeoutMs = Math.min(
        Number.isFinite(frame.timeoutMs) && frame.timeoutMs > 0 ? frame.timeoutMs : 10_000,
        LIMITS.maxRequestTimeoutMs
    );
    target.requests.set(frame.msgId, {
        from: ctx.member.sessionId,
        expires: ctx.now() + timeoutMs,
    });
    const out = relayed(ctx, { type: "request", msgId: frame.msgId, data: frame.data, timeoutMs });
    ctx.registry.deliver([target], out, "reliable");
    ctx.ack(frame);
};

const reply: Handler = (ctx, frame) => {
    if (!isWireTarget(frame.to) || !("sessionId" in frame.to))
        throw invalid("to must be { sessionId }");
    const pending = ctx.member.requests.get(frame.replyTo);
    if (!pending || pending.from !== frame.to.sessionId || pending.expires < ctx.now()) {
        throw invalid("reply does not answer a request this session received");
    }
    ctx.member.requests.delete(frame.replyTo);
    const target = peerBySession(ctx, frame.to.sessionId);
    const out = relayed(ctx, { type: "reply", msgId: frame.msgId, replyTo: frame.replyTo });
    if (frame.error !== undefined) out.error = { message: String(frame.error?.message ?? "") };
    else out.data = frame.data;
    ctx.registry.deliver([target], out, "reliable");
    ctx.ack(frame);
};

function requireVersion(ctx: HandlerContext, version: unknown): Version {
    if (!isVersion(version) || !ctx.store.acceptsVersion(version, ctx.member.sessionId)) {
        throw invalid("version must be [clock, own sessionId] without a clock jump");
    }
    return version;
}

/** The entry a member writes: a value, or a tombstone. */
export function memberEntry(
    ctx: HandlerContext,
    version: Version,
    value: unknown,
    deleted: boolean
): Entry {
    const { peerId, deviceId } = ctx.member;
    if (deleted) return tombstone(version, peerId, deviceId, ctx.now());
    return {
        value: value ?? null,
        deleted: false,
        version,
        updatedBy: peerId,
        deviceId,
        updatedAt: ctx.now(),
    };
}

function writeEntry(ctx: HandlerContext, frame: Frame, deleted: boolean): void {
    const channel = ctx.channels.subscribed(ctx.member, frame.channel);
    if (!isKey(frame.key)) throw invalid("key must be a string of 1-256 characters");
    const version = requireVersion(ctx, frame.version);
    const entry = memberEntry(ctx, version, frame.value, deleted);
    const result = ctx.store.set(channel, frame.key, entry);
    if (!result.applied) return ctx.ack(frame, { applied: false, entry: result.entry });
    ctx.ack(frame, { applied: true, entry: result.entry });
    const out = relayed(ctx, {
        type: "state:changed",
        channel: channel.info.id,
        key: frame.key,
        entry: result.entry,
    });
    ctx.registry.deliver(channelRecipients(ctx, channel, frame.deliveredTo), out, "reliable");
}

const stateClear: Handler = (ctx, frame) => {
    const channel = ctx.channels.subscribed(ctx.member, frame.channel);
    const version = requireVersion(ctx, frame.version);
    if (frame.prefix !== undefined && typeof frame.prefix !== "string")
        throw invalid("prefix must be a string");
    const prefix = frame.prefix || undefined;
    const { peerId, deviceId } = ctx.member;
    const cleared = ctx.store.clear(channel, version, peerId, deviceId, prefix);
    ctx.ack(frame, { applied: true, count: cleared.length });
    const out = relayed(ctx, {
        type: "state:cleared",
        channel: channel.info.id,
        version,
        updatedBy: peerId,
        deviceId,
    });
    if (prefix) out.prefix = prefix;
    ctx.registry.deliver(channelRecipients(ctx, channel, frame.deliveredTo), out, "reliable");
};

const stateBatch: Handler = (ctx, frame) => {
    const channel = ctx.channels.subscribed(ctx.member, frame.channel);
    const version = requireVersion(ctx, frame.version);
    const ops = frame.ops;
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > LIMITS.batchOps)
        throw invalid("ops must hold 1-1000 operations");
    const keys = new Set<string>();
    const batch = ops.map((op: any) => {
        if (!isPlainObject(op) || !isKey(op.key) || keys.has(op.key))
            throw invalid("each op needs a distinct key of 1-256 characters");
        keys.add(op.key);
        return { key: op.key, entry: memberEntry(ctx, version, op.value, op.deleted === true) };
    });
    const results = ctx.store.setBatch(channel, batch);
    ctx.ack(frame, {
        results: results.map((r) => (r.applied ? { applied: true } : r)),
    });
    const changes = batch.filter((_, i) => results[i].applied);
    if (!changes.length) return;
    const out = relayed(ctx, { type: "state:changes", channel: channel.info.id, changes });
    ctx.registry.deliver(channelRecipients(ctx, channel, []), out, "reliable");
};

const signal: Handler = (ctx, frame) => {
    const target = peerBySession(ctx, frame.to);
    const ok =
        ctx.member.capabilities.webrtc && target.capabilities.webrtc && isPlainObject(frame.signal);
    if (!ok) throw invalid("signal not allowed between these peers");
    ctx.registry.deliver(
        [target],
        relayed(ctx, { type: "signal", signal: frame.signal }),
        "reliable",
        false
    );
};

const link: Handler = (ctx, frame) => {
    if (typeof frame.to !== "string" || !ctx.registry.peers.has(frame.to)) return;
    if (frame.mode === "webrtc" || frame.mode === "socket") ctx.member.links[frame.to] = frame.mode;
};

const mediaChunk: Handler = (ctx, frame) => {
    const channel = ctx.channels.subscribed(ctx.member, frame.channel);
    if (!isId(frame.streamId) || typeof frame.data !== "string") throw invalid("bad media chunk");
    const out = relayed(ctx, {
        type: "media:chunk",
        channel: channel.info.id,
        streamId: frame.streamId,
        gen: frame.gen,
        seq: frame.seq,
        mime: frame.mime,
        init: frame.init === true,
        data: frame.data,
    });
    const media = (m: Member) => m.capabilities.media;
    const recipients = channelRecipients(ctx, channel, frame.deliveredTo, media);
    ctx.registry.deliver(recipients, out, out.init ? "media-init" : "media");
};

const mediaEnd: Handler = (ctx, frame) => {
    const channel = ctx.channels.subscribed(ctx.member, frame.channel);
    if (!isId(frame.streamId)) throw invalid("bad streamId");
    const key = `${ctx.member.sessionId}:${frame.streamId}`;
    const recipients = channelRecipients(ctx, channel, [], (m) => m.capabilities.media);
    for (const m of recipients) m.outOfSync.delete(key);
    const out = relayed(ctx, {
        type: "media:end",
        channel: channel.info.id,
        streamId: frame.streamId,
    });
    ctx.registry.deliver(recipients, out, "reliable");
};

export const PEER_HANDLERS: Record<string, Handler> = {
    presence,
    subscribe,
    unsubscribe,
    "channel:presence": channelPresence,
    send,
    broadcast,
    request,
    reply,
    "state:set": (ctx, frame) => writeEntry(ctx, frame, false),
    "state:delete": (ctx, frame) => writeEntry(ctx, frame, true),
    "state:clear": stateClear,
    "state:batch": stateBatch,
    signal,
    link,
    "media:chunk": mediaChunk,
    "media:end": mediaEnd,
};
