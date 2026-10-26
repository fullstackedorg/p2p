// send, request/reply, channel broadcasts, and incoming messages. See docs/4-client/client-api.md §3.
import { encodedSize } from "../protocol/codec.ts";
import { P2PError } from "../protocol/errors.ts";
import {
    LIMITS,
    type Frame,
    type PeerInfo,
    type Target,
    type Transport,
} from "../protocol/types.ts";
import { overLinks, socketOf, transportTo, type ClientContext } from "./context.ts";
import { targetOf, type SenderPeer } from "./peers.ts";
import { Rpc } from "./rpc.ts";

/** Payload of the `message` event. */
export type MessageEvent = {
    /** The sending device (`from.peerId` is the user). Inspector senders have `inspector: true`. */
    from: SenderPeer;
    /** The JSON value that was sent. */
    data: unknown;
    /** `"<sessionId>:<seq>"`, unique per message. */
    msgId: string;
    /** Broadcasts: the channel they were sent in. */
    channel?: string;
    /** `true` for `send` and `request`, `false` for `broadcast`. */
    direct: boolean;
    /** Sent with `{ ephemeral: true }`. */
    ephemeral: boolean;
    /** How it arrived: `"webrtc"` (direct link) or `"socket"` (relayed by the Server). */
    transport: Transport;
    /**
     * Present on requests only. Call once with the answer; pass an `Error` (or throw from the
     * listener) to reject the requester with `REPLY_ERROR`.
     */
    reply?: (data: unknown) => Promise<void>;
};

type Emitter = { emit(event: string, ...args: any[]): unknown };

class Dedup {
    private seen = new Map<string, { set: Set<string>; order: string[] }>();

    /** True when msgId from sender was already delivered. */
    check(sender: string, msgId: string): boolean {
        let window = this.seen.get(sender);
        if (!window) this.seen.set(sender, (window = { set: new Set(), order: [] }));
        if (window.set.has(msgId)) return true;
        window.set.add(msgId);
        window.order.push(msgId);
        if (window.order.length > LIMITS.dedupWindow) window.set.delete(window.order.shift()!);
        return false;
    }

    forget(sender: string): void {
        this.seen.delete(sender);
    }
}

export class Messaging {
    rpc = new Rpc();
    private dedup = new Dedup();
    private ctx: ClientContext;

    constructor(ctx: ClientContext) {
        this.ctx = ctx;
    }

    /** Throws PAYLOAD_TOO_LARGE before anything is sent when the socket form would not fit. */
    private checkSize(frame: Frame): void {
        const max = socketOf(this.ctx).maxPayloadBytes;
        const worst = { ...frame, reqId: 2 ** 31, deliveredTo: this.ctx.links?.openIds() ?? [] };
        if (encodedSize(worst) > max) throw new P2PError("PAYLOAD_TOO_LARGE", "Message too large");
    }

    /** A broadcast to a channel's subscribers (`peers`). */
    async broadcast(
        channel: string,
        peers: PeerInfo[],
        data: unknown,
        ephemeral: boolean
    ): Promise<void> {
        const msgId = this.ctx.nextMsgId();
        const frame: Frame = { type: "broadcast", channel, msgId, data, ephemeral };
        this.checkSize(frame);
        const reached = overLinks(this.ctx, peers, frame, ephemeral);
        if (reached.length > 0 && reached.length === peers.length) return;
        await this.toSocket({ ...frame, deliveredTo: reached }, ephemeral);
    }

    async send(target: Target, data: unknown, ephemeral: boolean): Promise<void> {
        const peers = this.ctx.peers.resolve(target);
        const frame: Frame = { type: "send", msgId: this.ctx.nextMsgId(), data, ephemeral };
        this.checkSize(frame);
        const reached = overLinks(this.ctx, peers, frame, ephemeral);
        if (reached.length === peers.length) return;
        await this.toSocket({ ...frame, to: targetOf(target), deliveredTo: reached }, ephemeral);
    }

    async request(target: Target, data: unknown, timeoutMs: number): Promise<unknown> {
        const peer = this.ctx.peers.pickOne(target);
        const timeout = Math.min(Math.max(1, timeoutMs), LIMITS.maxRequestTimeoutMs);
        const msgId = this.ctx.nextMsgId();
        const frame: Frame = { type: "request", msgId, data, timeoutMs: timeout };
        this.checkSize(frame);
        const reply = this.rpc.wait(msgId, peer.sessionId, timeout);
        reply.catch(() => {});
        if (!this.ctx.links?.send(peer.sessionId, frame, false)) {
            try {
                await socketOf(this.ctx).request({ ...frame, to: { sessionId: peer.sessionId } });
            } catch (err) {
                this.rpc.fail(msgId, err as P2PError);
            }
        }
        return reply;
    }

    private async toSocket(frame: Frame, ephemeral: boolean): Promise<void> {
        const conn = socketOf(this.ctx);
        if (ephemeral) conn.send(frame);
        else await conn.request(frame);
    }

    private sendReply(to: string, replyTo: string, body: { data?: unknown; error?: unknown }) {
        const frame: Frame = { type: "reply", msgId: this.ctx.nextMsgId(), replyTo, ...body };
        if (this.ctx.links?.send(to, frame, false)) return;
        socketOf(this.ctx).send({ ...frame, to: { sessionId: to } });
    }

    private replier(from: string, msgId: string): (data: unknown) => Promise<void> {
        let used = false;
        return async (data: unknown) => {
            if (used) throw new P2PError("INVALID_ARGUMENT", "reply already sent");
            used = true;
            if (data instanceof Error)
                this.sendReply(from, msgId, { error: { message: data.message } });
            else this.sendReply(from, msgId, { data });
        };
    }

    /**
     * A send / broadcast / request / reply frame from `from`. Broadcasts are emitted on their
     * channel (`target`), the rest on the client. Returns false when dropped.
     */
    handle(frame: Frame, from: string, transport: Transport, target?: Emitter): boolean {
        const sender = this.ctx.peers.sender(from, frame.sender);
        if (!sender) return false;
        if (frame.type === "reply") {
            this.rpc.reply(frame, from);
            return true;
        }
        if (typeof frame.msgId !== "string" || this.dedup.check(from, frame.msgId)) return false;
        const event: MessageEvent = {
            from: sender,
            data: frame.data,
            msgId: frame.msgId,
            direct: frame.type !== "broadcast",
            ephemeral: frame.ephemeral === true,
            transport,
        };
        if (frame.type === "broadcast") event.channel = frame.channel;
        if (frame.type === "request") {
            const reply = this.replier(from, frame.msgId);
            event.reply = reply;
            this.dispatchRequest(event, reply);
        } else (target ?? this.ctx).emit("message", event);
        return true;
    }

    private dispatchRequest(event: MessageEvent, reply: (data: unknown) => Promise<void>): void {
        for (const listener of this.ctx.listeners("message")) {
            Promise.resolve()
                .then(() => listener(event))
                .catch((err: unknown) => {
                    const message = err instanceof Error ? err.message : String(err);
                    reply(new Error(message)).catch(() => {});
                });
        }
    }

    peerLeft(peer: PeerInfo): void {
        this.rpc.peerLeft(peer.sessionId);
        this.dedup.forget(peer.sessionId);
    }

    transportTo(sessionId: string): Transport {
        return transportTo(this.ctx, sessionId);
    }
}
