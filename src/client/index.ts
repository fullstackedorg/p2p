export { P2PClient, type ClientOptions, type ConnectionOverrides } from "./client.ts";
export { Channel } from "./channel.ts";
export type { SubscribeOptions } from "./channels.ts";
export type { MessageEvent } from "./messaging.ts";
export type {
    P2PClientEvents,
    ChannelEvents,
    JoinInfo,
    TransportChange,
    MediaEvent,
    StateCleared,
    RoleChange,
    ChannelDeleted,
    ChannelClosed,
    Subscriber,
} from "./events.ts";
export type { StateChange, WriteResult } from "./state.ts";
export type { SenderPeer } from "./peers.ts";
export { P2PError, ERROR_CODES, CLOSE_REASONS } from "../protocol/errors.ts";
export type { ErrorCode, CloseReason } from "../protocol/errors.ts";
export type {
    PeerInfo,
    ChannelInfo,
    Entry,
    Version,
    Role,
    Mode,
    Target,
    Transport,
    Capabilities,
} from "../protocol/types.ts";
