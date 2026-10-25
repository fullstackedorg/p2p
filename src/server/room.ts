// The Server's single room: registry, presence, relays, backpressure. See docs/3-subsystems/room.md.
import { encodeFrame } from "../protocol/codec.ts";
import type { CloseReason } from "../protocol/errors.ts";
import {
    LIMITS,
    type Capabilities,
    type Frame,
    type Mode,
    type PeerInfo,
    type Role,
} from "../protocol/types.ts";
import type { StateStore } from "./state-store.ts";

export type Member = {
    sessionId: string;
    peerId: string;
    deviceId: string;
    name: string;
    meta: Record<string, unknown>;
    role: Role;
    mode: Mode;
    capabilities: Capabilities;
    connectedAt: number;
    links: Record<string, string>;
    /** msgId -> requester sessionId and expiry, for reply authorization. */
    requests: Map<string, { from: string; expires: number }>;
    /** "<sender sessionId>:<streamId>" media streams this member is out of sync for. */
    outOfSync: Set<string>;
    writableLength(): number;
    write(bytes: Uint8Array): void;
    close(reason: CloseReason): void;
};

export type RoomStats = {
    relayedFrames: number;
    skippedByDeliveredTo: number;
    droppedEphemeral: number;
    droppedMediaChunks: number;
    mediaResyncs: number;
};

export type Delivery = "reliable" | "ephemeral" | "media" | "media-init";

export class Room {
    peers = new Map<string, Member>();
    byPeerId = new Map<string, Set<string>>();
    inspectors = new Set<Member>();
    store: StateStore;
    stats: RoomStats = {
        relayedFrames: 0,
        skippedByDeliveredTo: 0,
        droppedEphemeral: 0,
        droppedMediaChunks: 0,
        mediaResyncs: 0,
    };
    private maxPayloadBytes: number;
    private maxBufferedBytes: number;

    constructor(store: StateStore, maxPayloadBytes: number, maxBufferedBytes: number) {
        this.store = store;
        this.maxPayloadBytes = maxPayloadBytes;
        this.maxBufferedBytes = maxBufferedBytes;
    }

    get connections(): number {
        return this.peers.size + this.inspectors.size;
    }

    info(m: Member): PeerInfo {
        return {
            peerId: m.peerId,
            sessionId: m.sessionId,
            deviceId: m.deviceId,
            name: m.name,
            meta: m.meta,
            role: m.role,
            capabilities: m.capabilities,
            connectedAt: m.connectedAt,
        };
    }

    /** The session a new one with this identity would replace, if any. */
    findDevice(peerId: string, deviceId: string): Member | undefined {
        for (const id of this.byPeerId.get(peerId) ?? []) {
            const m = this.peers.get(id);
            if (m && m.deviceId === deviceId) return m;
        }
        return undefined;
    }

    join(m: Member, replaces?: string): void {
        if (m.mode === "inspect") {
            this.inspectors.add(m);
            return;
        }
        this.peers.set(m.sessionId, m);
        let set = this.byPeerId.get(m.peerId);
        if (!set) this.byPeerId.set(m.peerId, (set = new Set()));
        set.add(m.sessionId);
        const frame: Frame = { type: "peer:joined", peer: this.info(m) };
        if (replaces) frame.replaces = replaces;
        this.toPeers(frame, new Set([m.sessionId]));
    }

    /** Removes a member; returns true when it was a visible peer (peer:left was sent). */
    leave(m: Member, reason: CloseReason): boolean {
        if (this.inspectors.delete(m)) return false;
        if (this.peers.get(m.sessionId) !== m) return false;
        this.peers.delete(m.sessionId);
        const set = this.byPeerId.get(m.peerId);
        set?.delete(m.sessionId);
        if (set && set.size === 0) this.byPeerId.delete(m.peerId);
        for (const peer of this.peers.values()) {
            delete peer.links[m.sessionId];
            peer.requests.forEach((r, id) => r.from === m.sessionId && peer.requests.delete(id));
        }
        this.toPeers({ type: "peer:left", peer: this.info(m), reason }, new Set());
        return true;
    }

    sessionsOf(peerId: string): Member[] {
        return [...(this.byPeerId.get(peerId) ?? [])].map((id) => this.peers.get(id)!);
    }

    /** Writes one encoded frame to every listed recipient with the delivery rules of §4. */
    deliver(
        recipients: Iterable<Member>,
        frame: Frame,
        delivery: Delivery,
        relayed = true
    ): number {
        const bytes = encodeFrame(frame, Number.MAX_SAFE_INTEGER);
        let written = 0;
        for (const m of recipients) if (this.deliverOne(m, bytes, frame, delivery)) written++;
        if (relayed) this.stats.relayedFrames += written;
        return written;
    }

    /** Presence and other Server-originated frames to every peer but the excluded ones. */
    toPeers(frame: Frame, exclude: Set<string>): void {
        const recipients = [...this.peers.values()].filter((m) => !exclude.has(m.sessionId));
        this.deliver(recipients, frame, "reliable", false);
    }

    /** Room frames: every peer except the sender and deliveredTo. */
    fanOut(sender: Member | null, deliveredTo: unknown, filter?: (m: Member) => boolean): Member[] {
        const skip = new Set(Array.isArray(deliveredTo) ? deliveredTo : []);
        const out: Member[] = [];
        for (const m of this.peers.values()) {
            if (m === sender) continue;
            if (skip.has(m.sessionId)) {
                this.stats.skippedByDeliveredTo++;
                continue;
            }
            if (!filter || filter(m)) out.push(m);
        }
        return out;
    }

    private deliverOne(m: Member, bytes: Uint8Array, frame: Frame, delivery: Delivery): boolean {
        const queued = m.writableLength();
        if (delivery === "ephemeral" || delivery === "media") {
            const streamKey = delivery === "media" ? `${frame.from}:${frame.streamId}` : "";
            if (delivery === "media" && m.outOfSync.has(streamKey)) {
                this.stats.droppedMediaChunks++;
                return false;
            }
            if (queued > LIMITS.backpressureBytes) {
                if (delivery === "ephemeral") this.stats.droppedEphemeral++;
                else this.markOutOfSync(m, streamKey, frame);
                return false;
            }
        } else if (queued + bytes.byteLength > this.maxBufferedBytes) {
            m.close("slow_consumer");
            return false;
        }
        if (delivery === "media-init") m.outOfSync.delete(`${frame.from}:${frame.streamId}`);
        m.write(bytes);
        return true;
    }

    private markOutOfSync(m: Member, streamKey: string, frame: Frame): void {
        this.stats.droppedMediaChunks++;
        m.outOfSync.add(streamKey);
        const sender = this.peers.get(frame.from);
        if (!sender) return;
        this.stats.mediaResyncs++;
        const resync = { type: "media:resync", streamId: frame.streamId, from: m.sessionId };
        this.deliverOne(sender, encodeFrame(resync, this.maxPayloadBytes), resync, "reliable");
    }
}
