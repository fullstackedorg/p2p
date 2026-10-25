// Pending requests awaiting a reply. See docs/4-client/client-api.md §3.
import { P2PError } from "../protocol/errors.ts";
import type { Frame } from "../protocol/types.ts";

type Waiting = {
    target: string;
    resolve: (data: unknown) => void;
    reject: (err: P2PError) => void;
    timer: any;
};

export class Rpc {
    private waiting = new Map<string, Waiting>();

    wait(msgId: string, target: string, timeoutMs: number): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiting.delete(msgId);
                reject(new P2PError("TIMEOUT", "No reply"));
            }, timeoutMs);
            this.waiting.set(msgId, { target, resolve, reject, timer });
        });
    }

    fail(msgId: string, err: P2PError): void {
        const w = this.waiting.get(msgId);
        if (!w) return;
        this.waiting.delete(msgId);
        clearTimeout(w.timer);
        w.reject(err);
    }

    /** A reply frame from `from`; ignored unless it answers a pending request to that session. */
    reply(frame: Frame, from: string): void {
        const w = this.waiting.get(frame.replyTo);
        if (!w || w.target !== from) return;
        this.waiting.delete(frame.replyTo);
        clearTimeout(w.timer);
        if (frame.error) w.reject(new P2PError("REPLY_ERROR", String(frame.error.message ?? "")));
        else w.resolve(frame.data);
    }

    peerLeft(sessionId: string): void {
        for (const [msgId, w] of this.waiting) {
            if (w.target === sessionId) this.fail(msgId, new P2PError("PEER_LEFT", "Peer left"));
        }
    }

    rejectAll(code: "DISCONNECTED" | "CLOSED"): void {
        for (const msgId of [...this.waiting.keys()]) {
            this.fail(msgId, new P2PError(code, "Connection closed"));
        }
    }
}
