// Incoming state frames: relayed by the Server, or sent over a link. See docs/3-subsystems/state-store.md §7.
import { compareVersion, isVersion, tombstone } from "../protocol/lww.ts";
import { isKey, type Entry, type Frame, type Transport } from "../protocol/types.ts";
import type { ClientContext } from "./context.ts";
import type { SharedState } from "./state.ts";

function str(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

function remote(state: SharedState, key: unknown, entry: Entry | undefined, t: Transport): void {
    if (!isKey(key) || !entry || !isVersion(entry.version)) return;
    state.commit(key, entry, false, t);
}

export function handleStateFrame(
    state: SharedState,
    ctx: ClientContext,
    frame: Frame,
    from: string,
    transport: Transport
): void {
    if (frame.type === "state:changed") return remote(state, frame.key, frame.entry, transport);
    if (frame.type === "state:changes") {
        if (Array.isArray(frame.changes))
            for (const c of frame.changes) remote(state, c?.key, c?.entry, transport);
        return;
    }
    const prefix = str(frame.prefix);
    const tag = str(frame.tag);
    if (frame.type === "state:cleared") {
        if (!isVersion(frame.version)) return;
        const deviceId = String(frame.deviceId ?? "");
        const who = { updatedBy: String(frame.updatedBy), sessionId: from, deviceId, prefix, tag };
        return state.applyClear(frame.version, who, false, transport);
    }
    // live values and link frames: the version must be the sender's own
    const sender = ctx.peers.get(from);
    if (!sender || !isVersion(frame.version) || frame.version[1] !== from) return;
    const { peerId: updatedBy, deviceId } = sender;
    if (frame.type === "state:clear") {
        const who = { updatedBy, sessionId: from, deviceId, prefix, tag };
        return state.applyClear(frame.version, who, false, transport);
    }
    if (!isKey(frame.key)) return;
    const now = Date.now();
    if (frame.type === "state:live") {
        const stored = state.replica.entries.get(frame.key);
        if (stored && compareVersion(frame.version, stored.version) <= 0) return; // already ended
        const live = {
            value: frame.value ?? null,
            version: frame.version,
            updatedBy,
            deviceId,
            tag,
            at: now,
        };
        return state.showLive(frame.key, live, false, transport);
    }
    const entry: Entry =
        frame.type === "state:delete"
            ? tombstone(frame.version, updatedBy, deviceId, now, tag)
            : {
                  value: frame.value ?? null,
                  deleted: false,
                  version: frame.version,
                  updatedBy,
                  deviceId,
                  updatedAt: now,
              };
    if (tag && !entry.deleted) entry.tag = tag;
    state.commit(frame.key, entry, false, transport);
}
