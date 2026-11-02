// Plugin: relay diagnostics from the Server's hooks (docs/2-server/hooks.md). The Server itself
// counts nothing; load this to see how much it relays, drops and why sessions end.
//
//   P2P_PLUGINS=./examples/relay-stats.ts node src/server/main.ts
//
// The counters are added to the inspector `schema` overview as `stats` and `recentCloses`.
// Totals are per process and start at zero with it; nothing is persisted.
import type { CloseReason } from "../src/protocol/errors.ts";
import type { HookRegistry } from "../src/server/hooks.ts";

export type RelayStats = {
    relayedFrames: number;
    /** Bytes written for relayed frames, every recipient counted. */
    relayedBytes: number;
    skippedByDeliveredTo: number;
    droppedEphemeral: number;
    droppedMediaChunks: number;
    mediaResyncs: number;
    /** Ended sessions per close reason. */
    closeReasons: Record<string, number>;
};

export type CloseRecord = {
    at: number;
    reason: CloseReason;
    peerId: string;
    deviceId: string;
    sessionId: string;
    mode: string;
};

/** How many ended sessions `recentCloses` keeps, newest first. */
export const RECENT_CLOSES = 50;

/** Registers the counters on `server`; returns them, live. */
export function relayStats(
    server: { registerHook: HookRegistry["register"] },
    now: () => number = Date.now
): { stats: RelayStats; recentCloses: CloseRecord[] } {
    const stats: RelayStats = {
        relayedFrames: 0,
        relayedBytes: 0,
        skippedByDeliveredTo: 0,
        droppedEphemeral: 0,
        droppedMediaChunks: 0,
        mediaResyncs: 0,
        closeReasons: {},
    };
    const recentCloses: CloseRecord[] = [];
    server.registerHook("frame_relayed", (r) => {
        stats.relayedFrames += r.recipients;
        stats.relayedBytes += r.recipients * r.bytes;
    });
    server.registerHook("frame_skipped", () => void stats.skippedByDeliveredTo++);
    server.registerHook("frame_dropped", (d) => {
        if (d.delivery === "ephemeral") stats.droppedEphemeral++;
        else stats.droppedMediaChunks++;
    });
    server.registerHook("media_resync", () => void stats.mediaResyncs++);
    server.registerHook("session_end", ({ reason, peerId, deviceId, sessionId, mode }) => {
        stats.closeReasons[reason] = (stats.closeReasons[reason] ?? 0) + 1;
        recentCloses.unshift({ at: now(), reason, peerId, deviceId, sessionId, mode });
        recentCloses.length = Math.min(recentCloses.length, RECENT_CLOSES);
    });
    server.registerHook("schema_done", (schema) => {
        schema.stats = { ...stats, closeReasons: { ...stats.closeReasons } };
        schema.recentCloses = [...recentCloses];
    });
    return { stats, recentCloses };
}

export default function plugin(server: { registerHook: HookRegistry["register"] }): void {
    relayStats(server);
}
