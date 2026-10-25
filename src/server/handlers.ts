// Peer frames after authentication. See docs/1-concepts/protocol-spec.md §4–§5.
import { P2PError, readOnlyError } from "../protocol/errors.ts";
import { isVersion, tombstone } from "../protocol/lww.ts";
import {
    LIMITS,
    isId,
    isKey,
    isPlainObject,
    isWireTarget,
    type Entry,
    type Frame,
    type Version,
} from "../protocol/types.ts";
import type { Member, Room } from "./room.ts";

export type HandlerContext = {
    room: Room;
    member: Member;
    now: () => number;
    ack(frame: Frame, extra?: Record<string, unknown>): void;
};

type Handler = (ctx: HandlerContext, frame: Frame) => void;

function invalid(message: string): P2PError {
    return new P2PError("INVALID_ARGUMENT", message);
}

function requireWriter(ctx: HandlerContext): void {
    if (ctx.member.role === "ro") throw readOnlyError();
}

function requireMsgId(ctx: HandlerContext, msgId: unknown): string {
    if (typeof msgId !== "string" || !msgId.startsWith(ctx.member.sessionId + ":")) {
        throw invalid("msgId must start with the sender's sessionId");
    }
    return msgId;
}

function peerBySession(ctx: HandlerContext, sessionId: unknown): Member {
    const target = typeof sessionId === "string" ? ctx.room.peers.get(sessionId) : undefined;
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
    const sessions = ctx.room.sessionsOf(to.peerId).filter((m) => m !== ctx.member);
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

const presence: Handler = (ctx, frame) => {
    requireWriter(ctx);
    if (!isPlainObject(frame.meta)) throw invalid("meta must be an object");
    if (frame.name !== undefined && !isId(frame.name)) throw invalid("name must be 1-128 chars");
    ctx.member.meta = frame.meta;
    if (frame.name !== undefined) ctx.member.name = frame.name;
    ctx.ack(frame);
    const update = { type: "peer:updated", peer: ctx.room.info(ctx.member) };
    ctx.room.toPeers(update, new Set([ctx.member.sessionId]));
};

const send: Handler = (ctx, frame) => {
    requireWriter(ctx);
    requireMsgId(ctx, frame.msgId);
    const recipients = sendRecipients(ctx, frame.to, frame.deliveredTo);
    const out = relayed(ctx, { type: "send", msgId: frame.msgId, data: frame.data });
    out.ephemeral = frame.ephemeral === true;
    const n = ctx.room.deliver(recipients, out, out.ephemeral ? "ephemeral" : "reliable");
    ctx.ack(frame, { recipients: n });
};

const broadcast: Handler = (ctx, frame) => {
    requireWriter(ctx);
    requireMsgId(ctx, frame.msgId);
    const out = relayed(ctx, { type: "broadcast", msgId: frame.msgId, data: frame.data });
    out.ephemeral = frame.ephemeral === true;
    const recipients = ctx.room.fanOut(ctx.member, frame.deliveredTo);
    const n = ctx.room.deliver(recipients, out, out.ephemeral ? "ephemeral" : "reliable");
    ctx.ack(frame, { recipients: n });
};

const request: Handler = (ctx, frame) => {
    requireWriter(ctx);
    requireMsgId(ctx, frame.msgId);
    if (!isWireTarget(frame.to) || !("sessionId" in frame.to))
        throw invalid("to must be { sessionId }");
    const target = peerBySession(ctx, frame.to.sessionId);
    if (target.role === "ro") throw new P2PError("TARGET_READ_ONLY", "Spectators cannot reply");
    const timeoutMs = Math.min(
        Number.isFinite(frame.timeoutMs) && frame.timeoutMs > 0 ? frame.timeoutMs : 10_000,
        LIMITS.maxRequestTimeoutMs
    );
    target.requests.set(frame.msgId, {
        from: ctx.member.sessionId,
        expires: ctx.now() + timeoutMs,
    });
    const out = relayed(ctx, { type: "request", msgId: frame.msgId, data: frame.data, timeoutMs });
    ctx.room.deliver([target], out, "reliable");
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
    ctx.room.deliver([target], out, "reliable");
    ctx.ack(frame);
};

function writeEntry(ctx: HandlerContext, frame: Frame, deleted: boolean): void {
    requireWriter(ctx);
    if (!isKey(frame.key)) throw invalid("key must be a string of 1-256 characters");
    if (
        !isVersion(frame.version) ||
        !ctx.room.store.acceptsVersion(frame.version, ctx.member.sessionId)
    ) {
        throw invalid("version must be [clock, own sessionId] without a clock jump");
    }
    const version = frame.version as Version;
    const entry: Entry = deleted
        ? tombstone(version, ctx.member.peerId, ctx.now())
        : {
              value: frame.value ?? null,
              deleted,
              version,
              updatedBy: ctx.member.peerId,
              updatedAt: ctx.now(),
          };
    const result = ctx.room.store.set(frame.key, entry);
    if (!result.applied) return ctx.ack(frame, { applied: false, entry: result.entry });
    ctx.ack(frame, { applied: true, entry: result.entry });
    const out = relayed(ctx, { type: "state:changed", key: frame.key, entry: result.entry });
    ctx.room.deliver(ctx.room.fanOut(ctx.member, frame.deliveredTo), out, "reliable");
}

const stateClear: Handler = (ctx, frame) => {
    requireWriter(ctx);
    if (
        !isVersion(frame.version) ||
        !ctx.room.store.acceptsVersion(frame.version, ctx.member.sessionId)
    ) {
        throw invalid("version must be [clock, own sessionId] without a clock jump");
    }
    const cleared = ctx.room.store.clear(frame.version, ctx.member.peerId);
    ctx.ack(frame, { applied: true, count: cleared.length });
    const out = relayed(ctx, {
        type: "state:cleared",
        version: frame.version,
        updatedBy: ctx.member.peerId,
    });
    ctx.room.deliver(ctx.room.fanOut(ctx.member, frame.deliveredTo), out, "reliable");
};

const signal: Handler = (ctx, frame) => {
    const target = peerBySession(ctx, frame.to);
    const ok =
        ctx.member.capabilities.webrtc &&
        target.capabilities.webrtc &&
        !(ctx.member.role === "ro" && target.role === "ro") &&
        isPlainObject(frame.signal);
    if (!ok) throw invalid("signal not allowed between these peers");
    ctx.room.deliver(
        [target],
        relayed(ctx, { type: "signal", signal: frame.signal }),
        "reliable",
        false
    );
};

const link: Handler = (ctx, frame) => {
    if (typeof frame.to !== "string" || !ctx.room.peers.has(frame.to)) return;
    if (frame.mode === "webrtc" || frame.mode === "socket") ctx.member.links[frame.to] = frame.mode;
};

const mediaChunk: Handler = (ctx, frame) => {
    requireWriter(ctx);
    if (!isId(frame.streamId) || typeof frame.data !== "string") throw invalid("bad media chunk");
    const out = relayed(ctx, {
        type: "media:chunk",
        streamId: frame.streamId,
        gen: frame.gen,
        seq: frame.seq,
        mime: frame.mime,
        init: frame.init === true,
        data: frame.data,
    });
    const recipients = ctx.room.fanOut(ctx.member, frame.deliveredTo, (m) => m.capabilities.media);
    ctx.room.deliver(recipients, out, out.init ? "media-init" : "media");
};

const mediaEnd: Handler = (ctx, frame) => {
    requireWriter(ctx);
    if (!isId(frame.streamId)) throw invalid("bad streamId");
    const key = `${ctx.member.sessionId}:${frame.streamId}`;
    const recipients = ctx.room.fanOut(ctx.member, [], (m) => m.capabilities.media);
    for (const m of recipients) m.outOfSync.delete(key);
    ctx.room.deliver(
        recipients,
        relayed(ctx, { type: "media:end", streamId: frame.streamId }),
        "reliable"
    );
};

export const PEER_HANDLERS: Record<string, Handler> = {
    presence,
    send,
    broadcast,
    request,
    reply,
    "state:set": (ctx, frame) => writeEntry(ctx, frame, false),
    "state:delete": (ctx, frame) => writeEntry(ctx, frame, true),
    "state:clear": stateClear,
    signal,
    link,
    "media:chunk": mediaChunk,
    "media:end": mediaEnd,
};
