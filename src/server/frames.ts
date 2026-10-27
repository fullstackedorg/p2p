// What frame handlers share: their context and the relay helpers.
import { P2PError } from "../protocol/errors.ts";
import { isVersion } from "../protocol/lww.ts";
import type { Frame, Version } from "../protocol/types.ts";
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

export type Handler = (ctx: HandlerContext, frame: Frame) => void;

export function invalid(message: string): P2PError {
    return new P2PError("INVALID_ARGUMENT", message);
}

export function relayed(ctx: HandlerContext, frame: Frame): Frame {
    const out: Frame = { ...frame, from: ctx.member.sessionId };
    delete out.reqId;
    delete out.deliveredTo;
    delete out.to;
    if (ctx.member.mode === "inspect")
        out.sender = { peerId: ctx.member.peerId, role: ctx.member.role };
    return out;
}

/** Recipients of a channel frame: the channel's subscribers but the sender and deliveredTo. */
export function channelRecipients(
    ctx: HandlerContext,
    channel: StoredChannel,
    deliveredTo: unknown,
    filter?: (m: Member) => boolean
): Member[] {
    const audience = ctx.channels.audience(channel.info.id);
    return ctx.registry.fanOut(audience, ctx.member, deliveredTo, filter);
}

/** A version the member may write: its own session and no absurd clock jump. */
export function requireVersion(ctx: HandlerContext, version: unknown): Version {
    if (!isVersion(version) || !ctx.store.acceptsVersion(version, ctx.member.sessionId)) {
        throw invalid("version must be [clock, own sessionId] without a clock jump");
    }
    return version;
}
