// Environment detection and the hosts that connect links and media to the client.
import type { Capabilities, Mode, PeerInfo } from "../protocol/types.ts";
import type { P2PClient } from "./client.ts";
import { LinkManager, type LinkHost, type LinkTiming } from "./webrtc.ts";

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

/** A name people understand for this device's platform; `""` when unknown. */
export function detectDeviceLabel(): string {
    const g = globalThis as any;
    const ua: string = g.navigator?.userAgent ?? "";
    if (ua) {
        if (/iPhone/.test(ua)) return "iPhone";
        if (/iPad/.test(ua)) return "iPad";
        if (/Android/.test(ua)) return "Android";
        if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
        if (/Windows/.test(ua)) return "Windows";
        if (/Linux/.test(ua)) return "Linux";
    }
    const platform: string = g.process?.platform ?? "";
    const names: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };
    return names[platform] ?? "";
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

/** The link manager of a WebRTC-capable peer session, with the spec deadlines. */
export function createLinks(client: P2PClient, timing: Partial<LinkTiming> = {}): LinkManager {
    const deadlines = { openTimeoutMs: 15_000, retryDelayMs: 30_000, idleCloseMs: 10_000 };
    return new LinkManager(createLinkHost(client), { ...deadlines, ...timing });
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
