// The visible peers, one per device. See docs/4-client/client-api.md §2–§3.
import { P2PError } from "../protocol/errors.ts";
import type { PeerInfo, Target } from "../protocol/types.ts";

/** A message sender: a listed peer, or an inspector session (`inspector: true`). */
export type SenderPeer = PeerInfo & { inspector?: true };

export function targetOf(target: Target): { peerId: string } | { sessionId: string } {
    if (typeof target === "string") return { peerId: target };
    if (target && typeof (target as any).sessionId === "string") {
        return { sessionId: (target as any).sessionId };
    }
    if (target && typeof (target as any).peerId === "string")
        return { peerId: (target as any).peerId };
    throw new P2PError("INVALID_ARGUMENT", "Target must be a peerId, { peerId } or { sessionId }");
}

export class PeerTable {
    private map = new Map<string, PeerInfo>();

    load(peers: PeerInfo[]): void {
        this.map = new Map(peers.map((p) => [p.sessionId, p]));
    }

    set(peer: PeerInfo): void {
        this.map.set(peer.sessionId, peer);
    }

    remove(sessionId: string): PeerInfo | undefined {
        const peer = this.map.get(sessionId);
        this.map.delete(sessionId);
        return peer;
    }

    get(sessionId: string): PeerInfo | undefined {
        return this.map.get(sessionId);
    }

    all(): PeerInfo[] {
        return [...this.map.values()];
    }

    ofUser(peerId: string): PeerInfo[] {
        return this.all().filter((p) => p.peerId === peerId);
    }

    /** Recipients of a send: one device, or every device of a user. */
    resolve(target: Target): PeerInfo[] {
        const t = targetOf(target);
        const out =
            "sessionId" in t ? [this.map.get(t.sessionId)].filter(Boolean) : this.ofUser(t.peerId);
        if (!out.length) throw new P2PError("PEER_NOT_FOUND", "No peer for that target");
        return out as PeerInfo[];
    }

    /** The one device a request goes to: the given session, or the user's most recent one. */
    pickOne(target: Target): PeerInfo {
        const candidates = this.resolve(target);
        return candidates.reduce((a, b) => (b.connectedAt > a.connectedAt ? b : a));
    }

    /** What a relayed frame's sender looks like when it is not a listed peer. */
    sender(sessionId: string, sender?: { peerId?: string; role?: string }): SenderPeer | undefined {
        const peer = this.map.get(sessionId);
        if (peer) return peer;
        if (!sender || typeof sender.peerId !== "string") return undefined;
        return {
            peerId: sender.peerId,
            sessionId,
            deviceId: sessionId,
            name: sender.peerId,
            meta: {},
            role: sender.role === "admin" || sender.role === "rw" ? sender.role : "ro",
            capabilities: { webrtc: false, media: false },
            connectedAt: 0,
            inspector: true,
        };
    }
}
