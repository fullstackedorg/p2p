// Event names and payloads of P2PClient and Channel. See docs/4-client/client-api.md.
import type { CloseReason, P2PError } from "../protocol/errors.ts";
import type { ChannelInfo, PeerInfo, Role, Transport } from "../protocol/types.ts";
import type { MessageEvent } from "./messaging.ts";
import type { StateChange } from "./state.ts";

/** Second argument of `peer:joined`. */
export type JoinInfo = {
    /** Set when this session took over the previous session of the same device (a reconnect). */
    replaces?: string;
};

/** Payload of `transport:changed`. */
export type TransportChange = { peer: PeerInfo; transport: Transport };

/** Payload of a channel's `media`: a remote stream, from tracks on a link or rebuilt from chunks. */
export type MediaEvent = { peer: PeerInfo; stream: MediaStream; transport: Transport };

/** Payload of `state:cleared`. */
export type StateCleared = { updatedBy: string; local: boolean };

/** Payload of `role:changed`. */
export type RoleChange = { role: Role; previous: Role };

/** Payload of `channel:deleted`. */
export type ChannelDeleted = { channel: string; by: string };

/** A subscriber of a channel: the device and its channel presence. */
export type Subscriber = { peer: PeerInfo; meta: Record<string, unknown> };

/** Payload of a channel's `closed`. */
export type ChannelClosed = { reason: "unsubscribed" | "channel_deleted"; by?: string };

/**
 * Every event P2PClient emits, with its listener arguments:
 * `p2p.on("peer:joined", (peer, { replaces }) => ...)`.
 */
export type P2PClientEvents = {
    /** A peer (one device of one user) connected. Includes the local user's other devices. */
    "peer:joined": [peer: PeerInfo, info: JoinInfo];
    /** A peer changed its `meta` / `name`, or subscribed to or left a channel (`peer.channels`). */
    "peer:updated": [peer: PeerInfo];
    /** A peer's session ended; `reason` is its close reason (`client_close`, `connection_lost`, ...). */
    "peer:left": [peer: PeerInfo, reason: CloseReason];
    /** A channel was created. */
    "channel:created": [channel: ChannelInfo];
    /** A channel was deleted (its subscribers' Channel objects close). */
    "channel:deleted": [info: ChannelDeleted];
    /** A `send` or `request` from another peer. Requests carry `event.reply`. */
    message: [event: MessageEvent];
    /** The transport to one peer switched between `"webrtc"` and `"socket"`. */
    "transport:changed": [change: TransportChange];
    /** The control socket dropped with a retryable reason; the client is reconnecting. */
    disconnected: [info: { reason: CloseReason }];
    /** A new session is up after a drop (new `sessionId`), channels subscribed again. */
    reconnected: [info: { sessionId: string }];
    /** A reconnect authenticated with another role (e.g. write access was withdrawn). */
    "role:changed": [change: RoleChange];
    /** Final: `close()` was called, or a non-retryable close reason arrived. */
    close: [info: { reason: CloseReason }];
    /** Non-fatal problems with no Promise to reject. Optional: unhandled errors are not thrown. */
    error: [error: P2PError | Error];
};

/** Every event a Channel emits: `board.on("state:changed", (change) => ...)`. */
export type ChannelEvents = {
    /** A device subscribed to the channel. */
    "subscriber:joined": [subscriber: Subscriber];
    /** A subscriber replaced its channel presence. */
    "subscriber:updated": [subscriber: Subscriber];
    /** A subscriber left: `"unsubscribed"` or the close reason of its session. */
    "subscriber:left": [subscriber: Subscriber, reason: CloseReason | "unsubscribed"];
    /** A broadcast in this channel (`event.channel` is its id). */
    message: [event: MessageEvent];
    /** A key of the channel's state changed, locally (`local: true`) or remotely. */
    "state:changed": [change: StateChange];
    /** `clearState` ran (each cleared key also fired `state:changed`). */
    "state:cleared": [info: StateCleared];
    /** A subscriber's shared media stream is available. Attach the latest one per peer. */
    media: [event: MediaEvent];
    /** A subscriber stopped sharing media. */
    "media:ended": [event: { peer: PeerInfo }];
    /** The channel ended for this client: unsubscribed, or deleted (`by`). */
    closed: [info: ChannelClosed];
};
