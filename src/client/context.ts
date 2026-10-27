// What the client modules share. Kept as an interface so messaging and state stay testable alone.
import { P2PError } from "../protocol/errors.ts";
import type { PeerInfo, Role, Transport } from "../protocol/types.ts";
import type { Connection } from "./connection.ts";
import type { PeerTable } from "./peers.ts";
import type { LinkManager } from "./webrtc.ts";

export interface ClientContext {
    readonly sessionId: string;
    readonly peerId: string;
    readonly deviceId: string;
    readonly role: Role;
    readonly peers: PeerTable;
    readonly links: LinkManager | null;
    readonly conn: Connection | null;
    nextMsgId(): string;
    emit(event: string, ...args: unknown[]): void;
    listeners(event: string): Function[];
    emitError(err: unknown): void;
}

export function socketOf(ctx: ClientContext): Connection {
    if (!ctx.conn || !ctx.conn.isOpen) throw new P2PError("DISCONNECTED", "Not connected");
    return ctx.conn;
}

export function transportTo(ctx: ClientContext, sessionId: string): Transport {
    return ctx.links?.isOpen(sessionId) ? "webrtc" : "socket";
}

/** Sends over every open link among `peers`; returns the session ids reached. */
export function overLinks(
    ctx: ClientContext,
    peers: PeerInfo[],
    frame: Record<string, unknown>,
    ephemeral: boolean
): string[] {
    if (!ctx.links) return [];
    const ids = peers.map((p) => p.sessionId);
    return ctx.links.sendMany(ids, frame as any, ephemeral);
}
