// An in-memory RTCPeerConnection for unit tests. Signaling goes through the real Server; once an
// offer/answer pair completes, the two fake connections open their DataChannels to each other.
import { after } from "node:test";

export const knobs = {
    /** Connections never open (link deadlines fire). */
    block: false,
    /** Delay before channels open after the answer. */
    openDelayMs: 5,
    maxMessageSize: 65_536,
};

const registry = new Map<string, FakePeerConnection>();
let counter = 0;

class FakeChannel {
    label: string;
    readyState: "connecting" | "open" | "closed" = "connecting";
    peer: FakeChannel | null = null;
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: ((e: unknown) => void) | null = null;
    sent = 0;

    constructor(label: string) {
        this.label = label;
    }

    send(data: string): void {
        if (this.readyState !== "open") throw new Error("channel not open");
        this.sent++;
        const peer = this.peer;
        setImmediate(() => {
            if (peer && peer.readyState === "open") peer.onmessage?.({ data });
        });
    }

    open(): void {
        if (this.readyState !== "connecting") return;
        this.readyState = "open";
        this.onopen?.({});
    }

    close(): void {
        if (this.readyState === "closed") return;
        this.readyState = "closed";
        this.onclose?.({});
        this.peer?.close();
    }
}

export class FakePeerConnection {
    id = `pc${++counter}`;
    signalingState = "stable";
    connectionState = "new";
    localDescription: { type: string; sdp: string } | null = null;
    remoteId: string | null = null;
    channels: FakeChannel[] = [];
    closed = false;
    onicecandidate: ((e: any) => void) | null = null;
    onnegotiationneeded: (() => void) | null = null;
    onconnectionstatechange: (() => void) | null = null;
    ondatachannel: ((e: { channel: FakeChannel }) => void) | null = null;
    ontrack: ((e: unknown) => void) | null = null;
    private negotiationScheduled = false;

    constructor(_config?: unknown) {
        registry.set(this.id, this);
    }

    get sctp() {
        return { maxMessageSize: knobs.maxMessageSize };
    }

    createDataChannel(label: string): FakeChannel {
        const channel = new FakeChannel(label);
        this.channels.push(channel);
        if (!this.negotiationScheduled) {
            this.negotiationScheduled = true;
            setImmediate(() => !this.closed && this.onnegotiationneeded?.());
        }
        return channel;
    }

    async setLocalDescription(): Promise<void> {
        if (this.signalingState === "have-remote-offer") {
            this.localDescription = { type: "answer", sdp: `fake:${this.id}` };
            this.signalingState = "stable";
            this.connect();
        } else {
            this.localDescription = { type: "offer", sdp: `fake:${this.id}` };
            this.signalingState = "have-local-offer";
        }
    }

    async setRemoteDescription(desc: { type: string; sdp: string }): Promise<void> {
        this.remoteId = desc.sdp.split(":")[1];
        this.signalingState = desc.type === "offer" ? "have-remote-offer" : "stable";
    }

    async addIceCandidate(): Promise<void> {}

    addTrack(): never {
        throw new Error("tracks are not supported by the fake");
    }

    removeTrack(): void {}

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.connectionState = "closed";
        for (const ch of this.channels) ch.close();
        registry.delete(this.id);
    }

    /** Simulates the network dropping: both ends see their channels close. */
    breakLink(): void {
        for (const ch of this.channels) ch.close();
    }

    private setState(state: string): void {
        this.connectionState = state;
        this.onconnectionstatechange?.();
    }

    /** Answerer side: pair with the offerer and open the channels. */
    private connect(): void {
        const offerer = this.remoteId ? registry.get(this.remoteId) : undefined;
        if (!offerer || knobs.block) return;
        setTimeout(() => {
            if (this.closed || offerer.closed) return;
            this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "fake" }) } });
            offerer.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "fake" }) } });
            for (const local of offerer.channels) {
                if (local.peer) continue;
                const remote = new FakeChannel(local.label);
                local.peer = remote;
                remote.peer = local;
                this.channels.push(remote);
                this.ondatachannel?.({ channel: remote });
            }
            this.setState("connected");
            offerer.setState("connected");
            for (const ch of [...offerer.channels, ...this.channels]) ch.open();
        }, knobs.openDelayMs);
    }
}

/** Installs the fake on globalThis for the current test file. */
export function installFakeRTC(): typeof knobs {
    const g = globalThis as any;
    const previous = g.RTCPeerConnection;
    g.RTCPeerConnection = FakePeerConnection;
    after(() => {
        g.RTCPeerConnection = previous;
        Object.assign(knobs, { block: false, openDelayMs: 5, maxMessageSize: 65_536 });
    });
    return knobs;
}

export function liveConnections(): FakePeerConnection[] {
    return [...registry.values()];
}
