export { P2PClient, type ClientOptions, type ConnectionOverrides } from "./client.ts";
export type { MessageEvent } from "./messaging.ts";
export type {
    P2PClientEvents,
    JoinInfo,
    TransportChange,
    MediaEvent,
    StateCleared,
    RoleChange,
} from "./events.ts";
export type { StateChange, WriteResult } from "./state.ts";
export type { SenderPeer } from "./peers.ts";
export { P2PError, ERROR_CODES, CLOSE_REASONS, READ_ONLY_MESSAGE } from "../protocol/errors.ts";
export type { ErrorCode, CloseReason } from "../protocol/errors.ts";
export type {
    PeerInfo,
    Entry,
    Version,
    Role,
    Mode,
    Target,
    Transport,
    Capabilities,
} from "../protocol/types.ts";
