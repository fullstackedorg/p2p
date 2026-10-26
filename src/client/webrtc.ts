// Links: one RTCPeerConnection per peer, two DataChannels, tracks. See docs/4-client/transports.md §2.
import { decodeLinkMessage, encodeLinkMessage } from "../protocol/codec.ts";
import { LIMITS, type Frame } from "../protocol/types.ts";

export type LinkTiming = { openTimeoutMs: number; retryDelayMs: number; idleCloseMs: number };

/** A stream shared in a channel, sent as tracks to the links of that channel's subscribers. */
export type SharedStream = { channel: string; stream: MediaStream };

export type LinkHost = {
    selfId(): string;
    iceServers(): RTCIceServer[];
    signal(to: string, signal: Record<string, unknown>): void;
    /** Whether a link to this peer is still wanted (it shares a channel). */
    wants(sessionId: string): boolean;
    streams(sessionId: string): SharedStream[];
    onOpen(sessionId: string): void;
    onClose(sessionId: string): void;
    onMessage(sessionId: string, frame: Frame): void;
    onTrack(sessionId: string, stream: MediaStream): void;
    onError(err: unknown): void;
};

type Link = {
    id: string;
    /** Negotiation generation: a retry starts a new one, stale signals are ignored. */
    gen: number;
    pc: RTCPeerConnection;
    polite: boolean;
    reliable: RTCDataChannel | null;
    ephemeral: RTCDataChannel | null;
    open: boolean;
    makingOffer: boolean;
    ignoreOffer: boolean;
    queue: Promise<void>;
    deadline: any;
    senders: RTCRtpSender[];
};

export class LinkManager {
    private links = new Map<string, Link>();
    private retried = new Set<string>();
    private retryTimers = new Map<string, any>();
    private generations = new Map<string, number>();
    private idle = new Map<string, any>();
    private host: LinkHost;
    private timing: LinkTiming;

    constructor(host: LinkHost, timing: LinkTiming) {
        this.host = host;
        this.timing = timing;
    }

    /** Called for every eligible peer; only the initiator (greater sessionId) dials. */
    consider(sessionId: string): void {
        clearTimeout(this.idle.get(sessionId));
        this.idle.delete(sessionId);
        if (this.links.has(sessionId) || this.retryTimers.has(sessionId)) return;
        if (this.host.selfId() > sessionId) this.create(sessionId, false, this.nextGen(sessionId));
    }

    isOpen(sessionId: string): boolean {
        return this.links.get(sessionId)?.open === true;
    }

    openIds(): string[] {
        return [...this.links.values()].filter((l) => l.open).map((l) => l.id);
    }

    /** Sends over the link; false when it is not open or the message is too large for it. */
    send(sessionId: string, frame: Frame, ephemeral: boolean): boolean {
        const link = this.links.get(sessionId);
        if (!link?.open || !link.reliable) return false;
        const message = encodeLinkMessage(frame);
        const max = (link.pc as any).sctp?.maxMessageSize || LIMITS.linkMessageBytes;
        if (new TextEncoder().encode(message).byteLength > max) return false;
        const channel =
            ephemeral && link.ephemeral?.readyState === "open" ? link.ephemeral : link.reliable;
        try {
            channel.send(message);
            return true;
        } catch {
            return false;
        }
    }

    /** Sends to every listed session with an open link; returns the ones reached. */
    sendMany(sessionIds: string[], frame: Frame, ephemeral: boolean): string[] {
        return sessionIds.filter((id) => this.send(id, frame, ephemeral));
    }

    handleSignal(from: string, signal: any): void {
        const gen = Number.isSafeInteger(signal?.gen) ? signal.gen : 0;
        let link = this.links.get(from);
        if (link && gen > link.gen && signal.kind === "offer" && link.polite) {
            this.teardown(from);
            link = undefined;
        }
        if (!link && signal?.kind === "offer" && this.host.selfId() < from) {
            link = this.create(from, true, gen);
        }
        if (!link || gen !== link.gen) return;
        const target = link;
        target.queue = target.queue
            .then(() => this.applySignal(target, signal))
            .catch(this.host.onError);
    }

    /** A peer no longer shares a channel: close its link after the idle delay. */
    release(sessionId: string): void {
        const known = this.links.has(sessionId) || this.retryTimers.has(sessionId);
        if (!known || this.idle.has(sessionId)) return;
        const timer = setTimeout(() => {
            this.idle.delete(sessionId);
            if (!this.host.wants(sessionId)) this.remove(sessionId);
        }, this.timing.idleCloseMs);
        this.idle.set(sessionId, timer);
    }

    /** Adds or removes the shared streams' tracks on every link (renegotiates). */
    refreshTracks(): void {
        for (const link of this.links.values()) this.syncTracks(link);
    }

    remove(sessionId: string): void {
        clearTimeout(this.idle.get(sessionId));
        this.idle.delete(sessionId);
        clearTimeout(this.retryTimers.get(sessionId));
        this.retryTimers.delete(sessionId);
        this.retried.delete(sessionId);
        this.teardown(sessionId);
        this.generations.delete(sessionId);
    }

    closeAll(): void {
        const ids = [...this.links.keys(), ...this.retryTimers.keys(), ...this.idle.keys()];
        for (const id of ids) this.remove(id);
    }

    private nextGen(id: string): number {
        const gen = (this.generations.get(id) ?? 0) + 1;
        this.generations.set(id, gen);
        return gen;
    }

    private signal(link: Link, signal: Record<string, unknown>): void {
        this.host.signal(link.id, { ...signal, gen: link.gen });
    }

    private create(id: string, polite: boolean, gen: number): Link {
        const pc = new RTCPeerConnection({ iceServers: this.host.iceServers() });
        const link: Link = {
            id,
            gen,
            pc,
            polite,
            reliable: null,
            ephemeral: null,
            open: false,
            makingOffer: false,
            ignoreOffer: false,
            queue: Promise.resolve(),
            deadline: setTimeout(() => this.fail(id, pc), this.timing.openTimeoutMs),
            senders: [],
        };
        this.links.set(id, link);
        pc.onicecandidate = (e) => {
            if (e.candidate) this.signal(link, { kind: "ice", candidate: e.candidate.toJSON() });
        };
        pc.onnegotiationneeded = async () => {
            try {
                link.makingOffer = true;
                await pc.setLocalDescription();
                this.signal(link, { kind: "offer", sdp: pc.localDescription!.sdp });
            } catch (err) {
                this.host.onError(err);
            } finally {
                link.makingOffer = false;
            }
        };
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === "failed") this.fail(id, pc);
        };
        pc.ondatachannel = (e) => this.bindChannel(link, e.channel);
        pc.ontrack = (e) => this.host.onTrack(id, e.streams[0] ?? new MediaStream([e.track]));
        if (!polite) {
            this.bindChannel(link, pc.createDataChannel("p2p-reliable", { ordered: true }));
            const eph = { ordered: false, maxRetransmits: 0 };
            this.bindChannel(link, pc.createDataChannel("p2p-ephemeral", eph));
        }
        return link;
    }

    private bindChannel(link: Link, channel: RTCDataChannel): void {
        if (this.links.get(link.id) !== link) return;
        if (channel.label === "p2p-reliable") link.reliable = channel;
        else if (channel.label === "p2p-ephemeral") link.ephemeral = channel;
        else return;
        channel.onmessage = (e) => {
            if (typeof e.data !== "string") return;
            let frame: Frame;
            try {
                frame = decodeLinkMessage(e.data);
            } catch (err) {
                return this.host.onError(err);
            }
            this.host.onMessage(link.id, frame);
        };
        if (channel.label !== "p2p-reliable") return;
        channel.onopen = () => {
            if (this.links.get(link.id) !== link || link.open) return;
            clearTimeout(link.deadline);
            link.open = true;
            this.host.onOpen(link.id);
            this.syncTracks(link); // tracks follow their media:announce, so only on open links
        };
        channel.onclose = () => this.fail(link.id, link.pc);
        if (channel.readyState === "open") channel.onopen!(new Event("open"));
    }

    private async applySignal(link: Link, signal: any): Promise<void> {
        const { pc } = link;
        if (signal.kind === "offer" || signal.kind === "answer") {
            const collision =
                signal.kind === "offer" && (link.makingOffer || pc.signalingState !== "stable");
            link.ignoreOffer = !link.polite && collision;
            if (link.ignoreOffer) return;
            await pc.setRemoteDescription({ type: signal.kind, sdp: signal.sdp });
            if (signal.kind === "offer") {
                await pc.setLocalDescription();
                this.signal(link, { kind: "answer", sdp: pc.localDescription!.sdp });
            }
        } else if (signal.kind === "ice" && signal.candidate) {
            try {
                await pc.addIceCandidate(signal.candidate);
            } catch (err) {
                if (!link.ignoreOffer) throw err;
            }
        }
    }

    private syncTracks(link: Link): void {
        if (!link.open) return;
        const wanted = new Map<MediaStreamTrack, SharedStream>();
        for (const shared of this.host.streams(link.id))
            for (const track of shared.stream.getTracks()) wanted.set(track, shared);
        for (const sender of [...link.senders]) {
            if (sender.track && wanted.has(sender.track)) continue;
            link.pc.removeTrack(sender);
            link.senders.splice(link.senders.indexOf(sender), 1);
        }
        const sending = new Set(link.senders.map((s) => s.track));
        const announced = new Set<string>();
        for (const [track, { channel, stream }] of wanted) {
            if (sending.has(track)) continue;
            if (!announced.has(stream.id)) {
                announced.add(stream.id);
                const announce = { type: "media:announce", channel, streamId: stream.id };
                this.send(link.id, announce, false);
            }
            link.senders.push(link.pc.addTrack(track, stream));
        }
    }

    private fail(id: string, pc: RTCPeerConnection): void {
        const link = this.links.get(id);
        if (!link || link.pc !== pc) return;
        this.teardown(id);
        const initiator = this.host.selfId() > id;
        if (!initiator || this.retried.has(id) || !this.host.wants(id)) return;
        this.retried.add(id);
        const timer = setTimeout(() => {
            this.retryTimers.delete(id);
            if (this.host.wants(id) && !this.links.has(id))
                this.create(id, false, this.nextGen(id));
        }, this.timing.retryDelayMs);
        this.retryTimers.set(id, timer);
    }

    private teardown(id: string): void {
        const link = this.links.get(id);
        if (!link) return;
        this.links.delete(id);
        clearTimeout(link.deadline);
        const wasOpen = link.open;
        link.open = false;
        for (const ch of [link.reliable, link.ephemeral]) if (ch) ch.onclose = null;
        try {
            link.pc.close();
        } catch {}
        if (wasOpen) this.host.onClose(id);
    }
}
