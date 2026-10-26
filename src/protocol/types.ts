// Wire types shared by the Server and the Client. See docs/1-concepts/protocol-spec.md.

export const PROTOCOL_VERSION = 2;

export const LIMITS = {
    keyLength: 256,
    idLength: 128,
    backpressureBytes: 65_536,
    dedupWindow: 1_024,
    authDeadlineMs: 10_000,
    ackTimeoutMs: 10_000,
    maxRequestTimeoutMs: 120_000,
    tombstoneTtlMs: 24 * 60 * 60 * 1000,
    maxClockJump: 2 ** 32,
    linkMessageBytes: 65_536,
} as const;

export const ROLES = ["admin", "rw", "ro"] as const;
export type Role = (typeof ROLES)[number];

/** `"peer"` takes part (presence, channels); `"inspect"` is an invisible session for `getSchema` / `query`. */
export type Mode = "peer" | "inspect";

/** `"webrtc"`: a direct link. `"socket"`: relayed by the Server over the TCP control socket. */
export type Transport = "webrtc" | "socket";

/** What an environment supports. Node.js and the FullStacked CLI: both `false`. */
export type Capabilities = { webrtc: boolean; media: boolean };

/** One device of one user connected to the Server. */
export type PeerInfo = {
    peerId: string; // the user: shared by all their devices
    sessionId: string; // this connection: unique
    deviceId: string; // this device: unique per peerId
    /** Display name (`peer.name`, else the peerId). */
    name: string;
    /** This device's global presence, set by `peer.meta` and `updatePresence`. */
    meta: Record<string, unknown>;
    /** `"ro"` peers cannot create or delete channels. */
    role: Role;
    capabilities: Capabilities;
    /** The channels this device is subscribed to, sorted. */
    channels: string[];
    /** Epoch ms. */
    connectedAt: number;
};

/** A channel: a named scope for shared state, broadcasts, channel presence and media. */
export type ChannelInfo = {
    id: string;
    /** Epoch ms. */
    createdAt: number;
    /** peerId of the creator. */
    createdBy: string;
};

/** Sender of a relayed frame that is not a listed peer (an inspector session). */
export type SenderInfo = { peerId: string; role: Role };

/** Lamport version of a state entry: higher clock wins, ties broken by sessionId. */
export type Version = [clock: number, sessionId: string];

/** A stored state key, as returned by `query({ operation: "getState" })`. */
export type Entry = {
    value: unknown;
    deleted: boolean;
    version: Version;
    updatedBy: string;
    updatedAt: number;
};

/** A peerId string or `{ peerId }`: every device of that user. `{ sessionId }`: one device. */
export type Target = string | { peerId: string } | { sessionId: string };

export type WireTarget = { peerId: string } | { sessionId: string };

/** Every frame is a JSON object with a string `type`; fields are validated by the receiver. */
export type Frame = { type: string; [field: string]: any };

export type ConnectedFrame = {
    type: "connected";
    reqId: number;
    sessionId: string;
    peerId: string;
    deviceId: string;
    role: Role;
    peers: PeerInfo[];
    channels: ChannelInfo[];
    iceServers: unknown[];
    limits: { maxPayloadBytes: number; maxChannelsPerSession: number };
    heartbeat: { intervalMs: number; timeoutMs: number };
};

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isId(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= LIMITS.idLength;
}

export function isKey(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= LIMITS.keyLength;
}

const CHANNEL_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function isChannelId(value: unknown): value is string {
    return typeof value === "string" && CHANNEL_ID.test(value);
}

export function isWireTarget(value: unknown): value is WireTarget {
    if (!isPlainObject(value)) return false;
    return isId(value.peerId) !== isId(value.sessionId);
}
