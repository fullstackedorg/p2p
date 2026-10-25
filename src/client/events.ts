// Event names and payloads of P2PClient. See docs/4-client/client-api.md.
import type { CloseReason, P2PError } from "../protocol/errors.ts";
import type { PeerInfo, Role, Transport } from "../protocol/types.ts";
import type { MessageEvent } from "./messaging.ts";
import type { StateChange } from "./state.ts";

/** Second argument of `peer:joined`. */
export type JoinInfo = {
    /** Set when this session took over the previous session of the same device (a reconnect). */
    replaces?: string;
};

/** Payload of `transport:changed`. */
export type TransportChange = { peer: PeerInfo; transport: Transport };

/** Payload of `peer:media`: a remote stream, from tracks on a link or rebuilt from socket chunks. */
export type MediaEvent = { peer: PeerInfo; stream: MediaStream; transport: Transport };

/** Payload of `state:cleared`. */
export type StateCleared = { updatedBy: string; local: boolean };

/** Payload of `role:changed`. */
export type RoleChange = { role: Role; previous: Role };

/**
 * Every event P2PClient emits, with its listener arguments:
 * `p2p.on("peer:joined", (peer, { replaces }) => ...)`.
 */
export type P2PClientEvents = {
    /** A peer (one device of one user) joined. Includes the local user's other devices. */
    "peer:joined": [peer: PeerInfo, info: JoinInfo];
    /** A peer replaced its `meta` / `name` with `updatePresence`. */
    "peer:updated": [peer: PeerInfo];
    /** A peer's session ended; `reason` is its close reason (`client_close`, `connection_lost`, ...). */
    "peer:left": [peer: PeerInfo, reason: CloseReason];
    /** A `broadcast`, `send` or `request` from another peer. Requests carry `event.reply`. */
    message: [event: MessageEvent];
    /** A key of the shared state changed, locally (`local: true`) or remotely. */
    "state:changed": [change: StateChange];
    /** `clearState` ran (each cleared key also fired `state:changed`). */
    "state:cleared": [info: StateCleared];
    /** The transport to one peer switched between `"webrtc"` and `"socket"`. */
    "transport:changed": [change: TransportChange];
    /** A peer's shared media stream is available. Attach the latest one per peer. */
    "peer:media": [event: MediaEvent];
    /** A peer stopped sharing media. */
    "peer:media:ended": [event: { peer: PeerInfo }];
    /** The control socket dropped with a retryable reason; the client is reconnecting. */
    disconnected: [info: { reason: CloseReason }];
    /** A new session is up after a drop (new `sessionId`, same `peerId` and `deviceId`). */
    reconnected: [info: { sessionId: string }];
    /** A reconnect authenticated with another role (e.g. write access was withdrawn). */
    "role:changed": [change: RoleChange];
    /** Final: `close()` was called, or a non-retryable close reason arrived. */
    close: [info: { reason: CloseReason }];
    /** Non-fatal problems with no Promise to reject. Optional: unhandled errors are not thrown. */
    error: [error: P2PError | Error];
};
