// Shared state event payloads and write options. See docs/4-client/client-api.md §4.
import { P2PError } from "../protocol/errors.ts";
import { isTag, type Entry, type PeerInfo, type Transport } from "../protocol/types.ts";
import type { LiveValue } from "./live.ts";

/** Payload of `state:changed`. */
export type StateChange = {
    key: string;
    /** The new value; `undefined` when `deleted`. */
    value: unknown;
    deleted: boolean;
    /** peerId of the writer. */
    updatedBy: string;
    /** sessionId of the writer. */
    sessionId: string;
    /** deviceId of the writer; `""` for entries written before protocol 3. */
    deviceId: string;
    /** The key had no live value before this change and has one now. */
    created: boolean;
    /** A live value in progress (`setState` with `ephemeral`), not stored. */
    live: boolean;
    /** Why it was written, when the writer said. */
    tag?: string;
    /** `true` for this client's own writes (fired before the Server acknowledges them). */
    local: boolean;
    /** How a remote change arrived; `null` for local writes. */
    transport: Transport | null;
};

/** Payload of `state:cleared`. */
export type StateCleared = {
    updatedBy: string;
    sessionId: string;
    deviceId: string;
    /** Set when only the keys starting with it were cleared. */
    prefix?: string;
    tag?: string;
    local: boolean;
};

/** Result of `setState` / `deleteState`: `applied: false` when a concurrent newer write won. */
export type WriteResult = { applied: boolean };

/** Options of the channel's write methods. */
export type WriteOptions = {
    /** Why the write happens (1-128 characters), delivered as `StateChange.tag`. */
    tag?: string;
};

/** The channel a SharedState belongs to: its id, its events, its other subscribers. */
export type StateScope = {
    id: string;
    emit(event: string, ...args: any[]): unknown;
    recipients(): PeerInfo[];
    observed(): boolean;
};

type ChangeSource = {
    created: boolean;
    live: boolean;
    local: boolean;
    transport: Transport | null;
};

/** The `state:changed` payload for an entry (or a live value). */
export function changeOf(key: string, entry: Entry | LiveValue, src: ChangeSource): StateChange {
    const deleted = "deleted" in entry && entry.deleted;
    const change: StateChange = {
        key,
        value: deleted ? undefined : entry.value,
        deleted,
        updatedBy: entry.updatedBy,
        sessionId: entry.version[1],
        deviceId: entry.deviceId ?? "",
        ...src,
    };
    if (entry.tag !== undefined) change.tag = entry.tag;
    return change;
}

export function requireTag(tag: unknown): string | undefined {
    if (!isTag(tag)) throw new P2PError("INVALID_ARGUMENT", "tag must be 1-128 characters");
    return tag;
}
