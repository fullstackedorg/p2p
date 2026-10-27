// Peer frames after authentication. See docs/1-concepts/protocol-spec.md §4–§6.
import { P2PError } from "../protocol/errors.ts";
import { LIMITS, isId, isPlainObject, isWireTarget, mergeMeta } from "../protocol/types.ts";
import {
    channelRecipients,
    invalid,
    relayed,
    type Handler,
    type HandlerContext,
} from "./frames.ts";
import type { Member } from "./registry.ts";
import { STATE_HANDLERS } from "./state-handlers.ts";

export type { HandlerContext } from "./frames.ts";

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
    ...STATE_HANDLERS,
    "stats:follow": (ctx, frame) =>
        ctx.ack(frame, ctx.channels.stats.follow(ctx.member, frame.prefix)),
    "stats:unfollow": (ctx, frame) => {
        ctx.channels.stats.unfollow(ctx.member, frame.prefix);
        ctx.ack(frame);
    },
    signal,
    link,
    "media:chunk": mediaChunk,
    "media:end": mediaEnd,
};
