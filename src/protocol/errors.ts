// Error codes and close reasons: the exact tables of docs/1-concepts/protocol-spec.md (§3.1, §7).

/** Every `P2PError.code`. */
export const ERROR_CODES = {
    invalidChannel: "INVALID_CHANNEL",
    channelNotFound: "CHANNEL_NOT_FOUND",
    notSubscribed: "NOT_SUBSCRIBED",
    channelLimit: "CHANNEL_LIMIT",
    forbidden: "FORBIDDEN",
    peerNotFound: "PEER_NOT_FOUND",
    payloadTooLarge: "PAYLOAD_TOO_LARGE",
    stateTooLarge: "STATE_TOO_LARGE",
    invalidArgument: "INVALID_ARGUMENT",
    invalidFrame: "INVALID_FRAME",
    timeout: "TIMEOUT",
    peerLeft: "PEER_LEFT",
    disconnected: "DISCONNECTED",
    unsupported: "UNSUPPORTED",
    replyError: "REPLY_ERROR",
    authFailed: "AUTH_FAILED",
    serverFull: "SERVER_FULL",
    sessionReplaced: "SESSION_REPLACED",
    closed: "CLOSED",
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Why a session ended: `peer:left`, `disconnected` and `close` carry one of these. */
export const CLOSE_REASONS = {
    clientClose: "client_close",
    connectionLost: "connection_lost",
    heartbeatTimeout: "heartbeat_timeout",
    authTimeout: "auth_timeout",
    authFailed: "auth_failed",
    unsupportedVersion: "unsupported_version",
    serverFull: "server_full",
    payloadTooLarge: "payload_too_large",
    slowConsumer: "slow_consumer",
    invalidFrame: "invalid_frame",
    sessionReplaced: "session_replaced",
    serverShutdown: "server_shutdown",
} as const;
export type CloseReason = (typeof CLOSE_REASONS)[keyof typeof CLOSE_REASONS];

const CLOSE_TO_CODE: Record<CloseReason, ErrorCode> = {
    client_close: "CLOSED",
    connection_lost: "DISCONNECTED",
    heartbeat_timeout: "DISCONNECTED",
    auth_timeout: "TIMEOUT",
    auth_failed: "AUTH_FAILED",
    unsupported_version: "CLOSED",
    server_full: "SERVER_FULL",
    payload_too_large: "CLOSED",
    slow_consumer: "DISCONNECTED",
    invalid_frame: "CLOSED",
    session_replaced: "SESSION_REPLACED",
    server_shutdown: "DISCONNECTED",
};

const RETRYABLE = new Set<CloseReason>([
    "connection_lost",
    "heartbeat_timeout",
    "auth_timeout",
    "server_full",
    "payload_too_large",
    "slow_consumer",
    "server_shutdown",
]);

export function isCloseReason(value: unknown): value is CloseReason {
    return typeof value === "string" && value in CLOSE_TO_CODE;
}

export function closeReasonCode(reason: CloseReason): ErrorCode {
    return CLOSE_TO_CODE[reason];
}

export function isRetryable(reason: CloseReason): boolean {
    return RETRYABLE.has(reason);
}

/** Every rejection of the client driver. Switch on `err.code` (see ERROR_CODES). */
export class P2PError extends Error {
    code: ErrorCode;
    reqId?: number;

    constructor(code: ErrorCode, message?: string, reqId?: number) {
        super(message ?? code);
        this.name = "P2PError";
        this.code = code;
        if (reqId !== undefined) this.reqId = reqId;
    }
}
