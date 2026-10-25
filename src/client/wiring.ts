// Environment detection and the hosts that connect links and media to the client.
import type { Capabilities, Mode, PeerInfo, Role } from "../protocol/types.ts";
import type { P2PClient } from "./client.ts";
import type { MediaHost } from "./media-fallback.ts";
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

/** Links form between peers that both support WebRTC, unless both are spectators. */
export function linkEligible(
    mode: Mode | undefined,
    role: Role,
    caps: Capabilities,
    peer: PeerInfo
) {
    return (
        mode !== "inspect" &&
        caps.webrtc &&
        peer.capabilities.webrtc &&
        !(role === "ro" && peer.role === "ro")
    );
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
        client.media?.update(transport === "socket");
    };
    return {
        selfId: () => client.sessionId,
        iceServers: () => client.iceServers,
        signal: (to, signal) => trySend(client, { type: "signal", to, signal }),
        isPeer: (id) => client.peers.get(id) !== undefined,
        stream: () => client.sharedStream,
        onOpen: (id) => changed(id, "webrtc"),
        onClose: (id) => changed(id, "socket"),
        onMessage: (id, frame) => client.onFrame(frame, "webrtc", id),
        onTrack: (id, stream) => {
            const peer = client.peers.get(id);
            if (peer) client.emit("peer:media", { peer, stream, transport: "webrtc" });
        },
        onError: (err) => client.emitError(err),
    };
}

export function createMediaHost(client: P2PClient): MediaHost {
    return {
        sessionId: () => client.sessionId,
        peers: () => client.peers.all(),
        linked: (id) => client.links?.isOpen(id) === true,
        send: (frame) => client.conn?.send(frame),
        onStream: (from, stream) => {
            const peer = client.peers.get(from);
            if (peer) client.emit("peer:media", { peer, stream, transport: "socket" });
        },
        onEnded: () => {},
    };
}
