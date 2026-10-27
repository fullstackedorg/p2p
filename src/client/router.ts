// Routes frames from the Server and from links to the client modules.
import { P2PError, type CloseReason } from "../protocol/errors.ts";
import type { ConnectedFrame, Frame, PeerInfo, Role, Transport } from "../protocol/types.ts";
import type { P2PClient } from "./client.ts";

const DIRECT_FRAMES = new Set(["send", "request", "reply"]);
/** Frames that carry `channel` and belong to one subscribed channel. */
const CHANNEL_FRAMES = new Set([
    "broadcast",
    "state:set",
    "state:delete",
    "state:clear",
    "state:changed",
    "state:changes",
    "state:cleared",
    "subscriber:joined",
    "subscriber:updated",
    "subscriber:left",
    "media:chunk",
    "media:end",
    "media:resync",
    "media:announce",
]);
/** What a link may carry: messages, state writes and track announcements. */
const LINK_FRAMES = new Set([
    ...DIRECT_FRAMES,
    "broadcast",
    "state:set",
    "state:delete",
    "state:clear",
    "media:announce",
]);

function peerJoined(client: P2PClient, peer: PeerInfo, replaces?: string): void {
    client.peers.set(peer);
    client.channelSet.syncLinks();
    client.emit("peer:joined", peer, replaces ? { replaces } : {});
}

function peerUpdated(client: P2PClient, peer: PeerInfo): void {
    client.peers.set(peer);
    client.channelSet.syncLinks();
    client.emit("peer:updated", peer);
}

function peerLeft(client: P2PClient, info: PeerInfo, reason: CloseReason): void {
    const peer = client.peers.remove(info.sessionId) ?? info;
    client.links?.remove(peer.sessionId);
    client.messaging.peerLeft(peer);
    client.channelSet.peerLeft(peer.sessionId);
    client.emit("peer:left", peer, reason);
}

export function routeFrame(
    client: P2PClient,
    frame: Frame,
    transport: Transport,
    linkFrom?: string
): void {
    const from = linkFrom ?? frame.from;
    if (linkFrom && !LINK_FRAMES.has(frame.type)) return;
    if (DIRECT_FRAMES.has(frame.type)) return void client.messaging.handle(frame, from, transport);
    if (CHANNEL_FRAMES.has(frame.type)) return client.channelSet.route(frame, from, transport);
    if (client.channelSet.handleServer(frame)) return;
    switch (frame.type) {
        case "peer:joined":
            return peerJoined(client, frame.peer, frame.replaces);
        case "peer:updated":
            return peerUpdated(client, frame.peer);
        case "peer:left":
            return peerLeft(client, frame.peer, frame.reason);
        case "signal":
            return client.links?.handleSignal(from, frame.signal);
        case "error":
            return client.emitError(new P2PError(frame.code, frame.message));
    }
}

/** After a reconnect: events for what changed in the peer list, the channel list and the role. */
export function reportReconnect(
    client: P2PClient,
    c: ConnectedFrame,
    before: PeerInfo[],
    known: string[],
    previousRole: Role
): void {
    const now = new Set(c.peers.map((p) => p.sessionId));
    const old = new Set(before.map((p) => p.sessionId));
    for (const p of before)
        if (!now.has(p.sessionId)) client.emit("peer:left", p, "connection_lost");
    for (const p of c.peers) if (!old.has(p.sessionId)) client.emit("peer:joined", p, {});
    const ids = new Set(c.channels.map((ch) => ch.id));
    const unknown = { by: "", sessionId: "", deviceId: "" };
    for (const id of known)
        if (!ids.has(id)) client.emit("channel:deleted", { channel: id, ...unknown });
    for (const ch of c.channels) if (!known.includes(ch.id)) client.emit("channel:created", ch);
    if (previousRole !== c.role)
        client.emit("role:changed", { role: c.role, previous: previousRole });
}
