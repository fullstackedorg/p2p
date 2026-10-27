// Visible peers, global presence, relays, backpressure. See docs/3-subsystems/channels.md.
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

export type Member = {
    sessionId: string;
    peerId: string;
    deviceId: string;
    deviceLabel: string;
    name: string;
    meta: Record<string, unknown>;
    role: Role;
    mode: Mode;
    capabilities: Capabilities;
    connectedAt: number;
    /** Subscribed channel id -> this member's channel presence. */
    channels: Map<string, Record<string, unknown>>;
    /** Inspector sessions: the channel id prefixes they watch. */
    watches: Set<string>;
    /** The session this one replaced (live or recently ended) and the channels it was in. */
    previous: Departed | null;
    links: Record<string, string>;
    /** msgId -> requester sessionId and expiry, for reply authorization. */
    requests: Map<string, { from: string; expires: number }>;
    /** "<sender sessionId>:<streamId>" media streams this member is out of sync for. */
    outOfSync: Set<string>;
    writableLength(): number;
    write(bytes: Uint8Array): void;
    close(reason: CloseReason): void;
};

export type RelayStats = {
    relayedFrames: number;
    skippedByDeliveredTo: number;
    droppedEphemeral: number;
    droppedMediaChunks: number;
    mediaResyncs: number;
    /** Ended sessions per close reason. */
    closeReasons: Record<string, number>;
};

/** A visible session that ended without client_close, remembered for the replacement window. */
export type Departed = { sessionId: string; channels: Set<string>; at: number };

export type CloseRecord = {
    at: number;
    reason: CloseReason;
    peerId: string;
    deviceId: string;
    sessionId: string;
    mode: Mode;
};

export type Delivery = "reliable" | "ephemeral" | "media" | "media-init";

export class Registry {
    peers = new Map<string, Member>();
    byPeerId = new Map<string, Set<string>>();
    inspectors = new Set<Member>();
    stats: RelayStats = {
        relayedFrames: 0,
        skippedByDeliveredTo: 0,
        droppedEphemeral: 0,
        droppedMediaChunks: 0,
        mediaResyncs: 0,
        closeReasons: {},
    };
    /** The last closes, newest first. */
    recentCloses: CloseRecord[] = [];
    /** "<peerId>\n<deviceId>" -> the device's last session, for `replaces`. */
    private departed = new Map<string, Departed>();
    private maxPayloadBytes: number;
    private maxBufferedBytes: number;
    private now: () => number;

    constructor(maxPayloadBytes: number, maxBufferedBytes: number, now: () => number = Date.now) {
        this.maxPayloadBytes = maxPayloadBytes;
        this.maxBufferedBytes = maxBufferedBytes;
        this.now = now;
    }

    get connections(): number {
        return this.peers.size + this.inspectors.size;
    }

    info(m: Member): PeerInfo {
        return {
            peerId: m.peerId,
            sessionId: m.sessionId,
            deviceId: m.deviceId,
            deviceLabel: m.deviceLabel,
            name: m.name,
            meta: m.meta,
            role: m.role,
            capabilities: m.capabilities,
            channels: [...m.channels.keys()].sort(),
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

    /** The device's session that ended within the replacement window, consumed. */
    takeDeparted(peerId: string, deviceId: string): Departed | null {
        const cutoff = this.now() - LIMITS.replaceWindowMs;
        for (const [key, d] of this.departed) if (d.at < cutoff) this.departed.delete(key);
        const key = `${peerId}\n${deviceId}`;
        const found = this.departed.get(key) ?? null;
        this.departed.delete(key);
        return found;
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
        this.toEveryone(frame, new Set([m.sessionId]));
    }

    /** Removes a member; returns true when it was a visible peer (peer:left was sent). */
    leave(m: Member, reason: CloseReason, channels: string[] = []): boolean {
        this.recordClose(m, reason);
        if (this.inspectors.delete(m)) return false;
        if (this.peers.get(m.sessionId) !== m) return false;
        if (reason !== "client_close") {
            const at = this.now();
            const departed = { sessionId: m.sessionId, channels: new Set(channels), at };
            this.departed.set(`${m.peerId}\n${m.deviceId}`, departed);
        }
        this.peers.delete(m.sessionId);
        const set = this.byPeerId.get(m.peerId);
        set?.delete(m.sessionId);
        if (set && set.size === 0) this.byPeerId.delete(m.peerId);
        for (const peer of this.peers.values()) {
            delete peer.links[m.sessionId];
            peer.requests.forEach((r, id) => r.from === m.sessionId && peer.requests.delete(id));
        }
        this.toEveryone({ type: "peer:left", peer: this.info(m), reason }, new Set());
        return true;
    }

    private recordClose(m: Member, reason: CloseReason): void {
        const counts = this.stats.closeReasons;
        counts[reason] = (counts[reason] ?? 0) + 1;
        const { peerId, deviceId, sessionId, mode } = m;
        this.recentCloses.unshift({ at: this.now(), reason, peerId, deviceId, sessionId, mode });
        this.recentCloses.length = Math.min(this.recentCloses.length, LIMITS.recentCloses);
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

    /** Presence and channel events to every peer and inspector but the excluded ones. */
    toEveryone(frame: Frame, exclude: Set<string>): void {
        const all = [...this.peers.values(), ...this.inspectors];
        const recipients = all.filter((m) => !exclude.has(m.sessionId));
        this.deliver(recipients, frame, "reliable", false);
    }

    /** peer:updated for m to everyone else. */
    updated(m: Member): void {
        this.toEveryone({ type: "peer:updated", peer: this.info(m) }, new Set([m.sessionId]));
    }

    /** Channel frames: every candidate except the sender and deliveredTo. */
    fanOut(
        candidates: Iterable<Member>,
        sender: Member | null,
        deliveredTo: unknown,
        filter?: (m: Member) => boolean
    ): Member[] {
        const skip = new Set(Array.isArray(deliveredTo) ? deliveredTo : []);
        const out: Member[] = [];
        for (const m of candidates) {
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
        const resync = {
            type: "media:resync",
            channel: frame.channel,
            streamId: frame.streamId,
            from: m.sessionId,
        };
        this.deliverOne(sender, encodeFrame(resync, this.maxPayloadBytes), resync, "reliable");
    }
}
