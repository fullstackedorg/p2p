// Options and result types of P2PClient. See docs/4-client/client-api.md §1.
import type { CloseReason } from "../protocol/errors.ts";
import type { Entry, Mode } from "../protocol/types.ts";
import type { Dialer } from "./connection.ts";
import type { LinkTiming } from "./webrtc.ts";

/** Fields `beforeConnect` may override for one connection attempt. */
export type ConnectionOverrides = Partial<{
    host: string;
    port: number;
    user: string;
    password: string;
}>;

/** A channel's numbers, from `peek` and `getSchema(channel)`. */
export type ChannelStats = {
    keyCount: number;
    stateBytes: number;
    subscriberCount: number;
    /** Epoch ms of the newest write, `null` when never written. */
    lastWriteAt: number | null;
    /** peerId of the newest write's author, `null` when never written. */
    lastWriteBy: string | null;
};

/** Options of `peek`. */
export type PeekOptions = { keys?: string[]; prefix?: string; after?: string; limit?: number };

/** Result of `peek`: one page of live entries, in key order. */
export type PeekResult = {
    entries: Record<string, Entry>;
    /** Pass as `after` for the next page; absent on the last one. */
    next?: string;
    stats: ChannelStats;
};

/** Options of `P2PClient.connect`. Only `host` is required (plus `user` / `password` on a secured Server). */
export type ClientOptions = {
    /** Server host: anything `node:net` can reach (native in Node.js, the runtime's in FullStacked). */
    host: string;
    /** Server port. Default 4444. */
    port?: number;
    /**
     * Username: decides the role (`admin`, `rw`, or `ro` which cannot create or delete channels).
     * Optional against a Server in open mode (no password configured), which accepts everyone as `rw`.
     */
    user?: string;
    /** Password of `user`. Optional in open mode. */
    password?: string;
    /**
     * `"peer"` (default) takes part. `"inspect"` is an invisible session for tools and monitors:
     * it sees presence, subscribes to and watches channels without appearing anywhere, and writes
     * through `query`.
     */
    mode?: Mode;
    /**
     * Who this peer is. `id` is the user's identity (e.g. the authenticated user id) and is shared by
     * all of that user's devices; it defaults to the sessionId. `meta` is this device's global presence.
     */
    peer?: { id?: string; name?: string; meta?: Record<string, unknown> };
    /**
     * This Client instance. Default: random per P2PClient, kept across reconnects. Two live clients
     * with the same `peer.id` and `deviceId` replace each other, so never share one between tabs.
     */
    deviceId?: string;
    /** A name people understand for this device (`"MacBook"`). Default: the detected platform. */
    deviceLabel?: string;
    /** Called before the first connection and every reconnect; returned fields override the options. */
    beforeConnect?: (info: {
        attempt: number;
        reason: CloseReason | null;
    }) => ConnectionOverrides | Promise<ConnectionOverrides>;
    /** `false` forces socket-only; `{ iceServers }` overrides the Server's ICE servers. Default: auto. */
    webrtc?: boolean | { iceServers?: RTCIceServer[] };
    /** `false` disables reconnection. Default `{ initialDelayMs: 1000, maxDelayMs: 30000 }`. */
    reconnect?: boolean | { initialDelayMs?: number; maxDelayMs?: number };
    /** TCP connect plus handshake deadline per attempt. Default 10000. */
    connectTimeoutMs?: number;
    /** Default `request()` timeout. Default 10000. */
    requestTimeoutMs?: number;
    /** Replaces how the control socket is opened (tests, custom transports). Default `node:net`. */
    connect?: Dialer;
    /** Link deadlines (15 s open, 30 s retry, 10 s idle close) and the 10 s live value expiry. Tests only. */
    timing?: Partial<LinkTiming & { liveTtlMs: number }>;
};
