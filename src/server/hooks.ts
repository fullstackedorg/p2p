// Extension hooks: the Server counts and records nothing about its traffic; plugins do, through
// these. See docs/2-server/hooks.md.
import { pathToFileURL } from "node:url";
import path from "node:path";
import type net from "node:net";
import type { CloseReason } from "../protocol/errors.ts";
import type { Logger } from "./log.ts";

/** A session's identity, as of its handshake. */
export type SessionInfo = {
    sessionId: string;
    peerId: string;
    deviceId: string;
    role: string;
    mode: string;
};

/** One frame the Server relayed between peers (presence and system frames excluded). */
export type RelayInfo = {
    type: string;
    channel?: string;
    /** The sender's sessionId, absent for frames the Server writes on an inspector's behalf. */
    from?: string;
    delivery: "reliable" | "ephemeral" | "media" | "media-init";
    /** Recipients the frame was written to. */
    recipients: number;
    /** Encoded size of the frame, written once per recipient. */
    bytes: number;
};

export type Hooks = {
    /** A TCP connection was accepted, before any byte is read: attach byte counters here. */
    session_connected: (socket: net.Socket) => void;
    /** A session completed its handshake. */
    session_start: (session: SessionInfo) => void;
    /** An authenticated session ended. */
    session_end: (session: SessionInfo & { reason: CloseReason }) => void;
    /** A peer frame was relayed to `recipients` sessions. */
    frame_relayed: (relay: RelayInfo) => void;
    /** A recipient was not written: the sender's direct links already delivered it. */
    frame_skipped: (skip: { sessionId: string; from?: string }) => void;
    /** A frame was dropped for one recipient under backpressure (§ Backpressure). */
    frame_dropped: (drop: {
        sessionId: string;
        type: string;
        channel?: string;
        delivery: "ephemeral" | "media";
    }) => void;
    /** A media stream went out of sync for a recipient and the sender was asked to resync. */
    media_resync: (resync: { sessionId: string; from: string; channel?: string }) => void;
    /** The inspector `schema` overview, before it is sent: plugins may add fields. */
    schema_done: (schema: Record<string, unknown>) => void;
};

export type HookName = keyof Hooks;

const KNOWN_HOOKS = new Set<HookName>([
    "session_connected",
    "session_start",
    "session_end",
    "frame_relayed",
    "frame_skipped",
    "frame_dropped",
    "media_resync",
    "schema_done",
]);

/**
 * One Server's hooks. Handlers run synchronously in registration order; a throwing handler is
 * logged and never affects the Server or the other handlers.
 */
export class HookRegistry {
    private handlers = new Map<HookName, Array<(...args: any[]) => void>>();
    private log: Logger | null;

    constructor(log: Logger | null = null) {
        this.log = log;
    }

    /** Registers a handler; returns the function that removes it. Unknown names throw. */
    register<N extends HookName>(name: N, handler: Hooks[N]): () => void {
        if (!KNOWN_HOOKS.has(name)) throw new Error(`unknown hook: ${String(name)}`);
        const list = this.handlers.get(name) ?? [];
        list.push(handler);
        this.handlers.set(name, list);
        return () => {
            const at = list.indexOf(handler);
            if (at >= 0) list.splice(at, 1);
        };
    }

    /** True when `name` has a handler: callers skip building the hook's argument otherwise. */
    has(name: HookName): boolean {
        return (this.handlers.get(name)?.length ?? 0) > 0;
    }

    run<N extends HookName>(name: N, ...args: Parameters<Hooks[N]>): void {
        const list = this.handlers.get(name);
        if (!list) return;
        for (const handler of [...list]) {
            try {
                handler(...args);
            } catch (err: any) {
                this.log?.error("hook failed", { hook: name, error: err?.message ?? String(err) });
            }
        }
    }

    clear(): void {
        this.handlers.clear();
    }
}

/** A plugin module's default export: registers its hooks on the Server it is loaded into. */
export type Plugin = (server: { registerHook: HookRegistry["register"] }) => void;

/** Imports each comma-separated module of `list` (P2P_PLUGINS) and returns its plugin. */
export async function loadPlugins(
    list: string | undefined,
    cwd = process.cwd()
): Promise<Plugin[]> {
    const paths = (list ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
    const plugins: Plugin[] = [];
    for (const p of paths) {
        const mod = await import(pathToFileURL(path.resolve(cwd, p)).href);
        if (typeof mod.default !== "function") {
            throw new Error(`plugin ${p} has no default export function`);
        }
        plugins.push(mod.default as Plugin);
    }
    return plugins;
}
