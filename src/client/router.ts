// Routes frames from the Server and from links to the client modules.
import { P2PError, type CloseReason } from "../protocol/errors.ts";
import type { Frame, PeerInfo, Transport } from "../protocol/types.ts";
import type { P2PClient } from "./client.ts";

const MESSAGE_FRAMES = new Set(["send", "broadcast", "request", "reply"]);
const STATE_FRAMES = new Set([
    "state:set",
    "state:delete",
    "state:clear",
    "state:changed",
    "state:cleared",
]);

function peerJoined(client: P2PClient, peer: PeerInfo, replaces?: string): void {
    client.peers.set(peer);
    if (client.links && client.eligible(peer)) client.links.consider(peer.sessionId);
    client.emit("peer:joined", peer, replaces ? { replaces } : {});
    client.media?.update(peer.capabilities.media);
}

function peerLeft(client: P2PClient, info: PeerInfo, reason: CloseReason): void {
    const peer = client.peers.remove(info.sessionId) ?? info;
    client.links?.remove(peer.sessionId);
    client.messaging.peerLeft(peer);
    client.media?.peerLeft(peer.sessionId);
    client.emit("peer:left", peer, reason);
    client.media?.update(false);
}

export function routeFrame(
    client: P2PClient,
    frame: Frame,
    transport: Transport,
    linkFrom?: string
): void {
    const from = linkFrom ?? frame.from;
    if (MESSAGE_FRAMES.has(frame.type)) return void client.messaging.handle(frame, from, transport);
    if (STATE_FRAMES.has(frame.type)) return client.state.handle(frame, from, transport);
    if (linkFrom) return; // nothing else travels on links
    switch (frame.type) {
        case "peer:joined":
            return peerJoined(client, frame.peer, frame.replaces);
        case "peer:updated":
            client.peers.set(frame.peer);
            return void client.emit("peer:updated", frame.peer);
        case "peer:left":
            return peerLeft(client, frame.peer, frame.reason);
        case "signal":
            return client.links?.handleSignal(from, frame.signal);
        case "media:chunk":
            return client.media?.onChunk(from, frame);
        case "media:end": {
            client.media?.onEnd(from, frame.streamId);
            const peer = client.peers.get(from);
            if (peer) client.emit("peer:media:ended", { peer });
            return;
        }
        case "media:resync":
            return client.media?.onResync(frame.streamId);
        case "error":
            return client.emitError(new P2PError(frame.code, frame.message));
    }
}
