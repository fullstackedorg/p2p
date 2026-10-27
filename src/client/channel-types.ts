// Channel option and acknowledgement types. See docs/4-client/client-api.md §4.
import type { Entry } from "../protocol/types.ts";
import type { PaceOptions } from "./pacer.ts";

/** What a subscribe acknowledgement carries. */
export type SubscribeAck = {
    subscribers: { sessionId: string; meta: Record<string, unknown> }[];
    state: Record<string, Entry>;
    clock: number;
    observed?: boolean;
    leases?: Record<string, string>;
};

/** Options of `channel.updatePresence`. */
export type PresenceOptions = {
    /** Patch the presence: each key replaces that key, `null` removes it, the rest stays. */
    merge?: boolean;
    /** No acknowledgement, may be dropped under congestion; the Server keeps the latest value. */
    ephemeral?: boolean;
} & PaceOptions;

/** Options of `channel.broadcast`. */
export type BroadcastOptions = {
    /** Unordered, may be dropped, no acknowledgement: for values the next one supersedes. */
    ephemeral?: boolean;
    /** Paced broadcasts keep only the latest data per stream. Default `"default"`. */
    stream?: string;
} & PaceOptions;

/** Why a Channel ended for this client. */
export type ChannelCloseReason = "unsubscribed" | "channel_deleted";

export const STATE_FRAMES = new Set([
    "state:set",
    "state:delete",
    "state:clear",
    "state:changed",
    "state:changes",
    "state:cleared",
    "state:live",
]);
