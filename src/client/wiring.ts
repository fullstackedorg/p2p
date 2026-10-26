// Environment detection and the hosts that connect links and media to the client.
import type { Capabilities, Mode, PeerInfo } from "../protocol/types.ts";
import type { P2PClient } from "./client.ts";
import type { LinkHost } from "./webrtc.ts";

export function detectCapabilities(webrtc: unknown): Capabilities {
    const g = globalThis as any;
    const hasRtc = typeof g.RTCPeerConnection === "function";
    const hasMedia =
        typeof g.MediaStream === "function" &&
        typeof g.MediaRecorder === "function" &&
        typeof g.MediaSource === "function" &&
        typeof g.document === "object";
    return { webrtc: hasRtc && webrtc !== false, media: hasMedia };
}

/** Links form between peers that both support WebRTC and share at least one channel. */
export function linkEligible(
    mode: Mode | undefined,
    caps: Capabilities,
    peer: PeerInfo,
    sharesChannel: boolean
) {
    return mode !== "inspect" && caps.webrtc && peer.capabilities.webrtc && sharesChannel;
}

export function randomId(): string {
    const bytes = new Uint8Array(12);
    const c = (globalThis as any).crypto;
    if (c?.getRandomValues) c.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function trySend(client: P2PClient, frame: Record<string, unknown>): void {
    try {
        client.conn?.send(frame as any);
    } catch {}
}

export function createLinkHost(client: P2PClient): LinkHost {
    const changed = (sessionId: string, transport: "webrtc" | "socket") => {
        trySend(client, { type: "link", to: sessionId, mode: transport });
        const peer = client.peers.get(sessionId);
        if (peer) client.emit("transport:changed", { peer, transport });
        for (const channel of client.channelSet.subscribed.values())
            if (channel.has(sessionId)) channel.media?.update(transport === "socket");
    };
    return {
        selfId: () => client.sessionId,
        iceServers: () => client.iceServers,
        signal: (to, signal) => trySend(client, { type: "signal", to, signal }),
        wants: (id) => {
            const peer = client.peers.get(id);
            return peer !== undefined && client.eligible(peer);
        },
        streams: (id) => client.channelSet.streamsFor(id),
        onOpen: (id) => {
            changed(id, "webrtc");
            const peer = client.peers.get(id);
            if (!peer || !client.eligible(peer)) client.links?.release(id);
        },
        onClose: (id) => changed(id, "socket"),
        onMessage: (id, frame) => client.onFrame(frame, "webrtc", id),
        onTrack: (id, stream) => client.channelSet.onTrack(id, stream),
        onError: (err) => client.emitError(err),
    };
}
