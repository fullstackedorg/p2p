// An inspector's watch on every channel whose id starts with a prefix.
// See docs/4-client/client-api.md §7.
import { EventEmitter } from "node:events";
import type { CloseReason, P2PError } from "../protocol/errors.ts";
import type { Entry, Frame } from "../protocol/types.ts";
import type { P2PClient } from "./client.ts";
import { socketOf } from "./context.ts";
import type { Subscriber, WatchEvents } from "./events.ts";
import type { MessageEvent } from "./messaging.ts";
import { changeOf, type StateChange, type StateCleared } from "./state.ts";

/** Something that happened in a watched channel. */
export type Activity =
    | { type: "subscriber:joined"; channel: string; subscriber: Subscriber; replaces?: string }
    | { type: "subscriber:updated"; channel: string; subscriber: Subscriber }
    | {
          type: "subscriber:left";
          channel: string;
          subscriber: Subscriber;
          reason: CloseReason | "unsubscribed";
      }
    | { type: "state:changed"; channel: string; change: StateChange }
    | { type: "state:cleared"; channel: string; info: StateCleared }
    | { type: "message"; channel: string; event: MessageEvent };

type WatchAck = {
    channels: { id: string; subscribers: { sessionId: string; meta: Record<string, unknown> }[] }[];
};

/**
 * Every channel whose id starts with `prefix`, now and later, from `await monitor.watch(prefix)`
 * on an inspector session. Emits `activity`; carries channel presence but no state (use `peek`).
 */
export class Watch extends EventEmitter<WatchEvents> {
    /** The watched channel id prefix. */
    readonly prefix: string;
    /** `true` until `close()`. */
    active = true;
    private client: P2PClient;
    /** channel id -> sessionId -> channel presence */
    private presence = new Map<string, Map<string, Record<string, unknown>>>();

    /** @internal */
    constructor(client: P2PClient, prefix: string) {
        super();
        this.client = client;
        this.prefix = prefix;
    }

    /** The subscribers of a watched channel, with their channel presence. */
    getSubscribers(channel: string): Subscriber[] {
        const out: Subscriber[] = [];
        for (const [sid, meta] of this.presence.get(channel) ?? []) {
            const peer = this.client.peers.get(sid);
            if (peer) out.push({ peer, meta });
        }
        return out;
    }

    /** Stops watching. */
    async close(): Promise<void> {
        if (!this.active) return;
        this.active = false;
        this.client.channelSet.watches.delete(this);
        try {
            await socketOf(this.client).request({ type: "unsubscribe", prefix: this.prefix });
        } catch (err) {
            if ((err as P2PError).code !== "DISCONNECTED") throw err;
        }
    }

    /** @internal Sends the watch (again, after a reconnect) and loads its subscribers. */
    async open(): Promise<void> {
        const ack = (await socketOf(this.client).request({
            type: "subscribe",
            prefix: this.prefix,
        })) as unknown as WatchAck;
        this.presence = new Map(
            ack.channels.map((c) => [
                c.id,
                new Map(c.subscribers.map((s) => [s.sessionId, s.meta])),
            ])
        );
    }

    /** @internal Whether a channel id is watched. */
    matches(channel: unknown): boolean {
        return this.active && typeof channel === "string" && channel.startsWith(this.prefix);
    }

    /** @internal A channel was deleted. */
    forget(channel: string): void {
        this.presence.delete(channel);
    }

    /** @internal A frame of a watched channel, from the Server. */
    handle(frame: Frame, from: string): void {
        const channel: string = frame.channel;
        switch (frame.type) {
            case "subscriber:joined":
            case "subscriber:updated": {
                this.presenceOf(channel).set(frame.sessionId, frame.meta ?? {});
                const subscriber = this.subscriber(frame.sessionId, frame.meta ?? {});
                if (!subscriber) return;
                const base = { channel, subscriber };
                if (frame.type === "subscriber:updated")
                    return this.push({ type: "subscriber:updated", ...base });
                const replaces =
                    typeof frame.replaces === "string" ? { replaces: frame.replaces } : {};
                return this.push({ type: "subscriber:joined", ...base, ...replaces });
            }
            case "subscriber:left": {
                const meta = this.presenceOf(channel).get(frame.sessionId) ?? {};
                this.presenceOf(channel).delete(frame.sessionId);
                const subscriber = this.subscriber(frame.sessionId, meta);
                if (subscriber)
                    this.push({
                        type: "subscriber:left",
                        channel,
                        subscriber,
                        reason: frame.reason,
                    });
                return;
            }
            case "state:changed":
                return this.changed(channel, frame.key, frame.entry, frame.created);
            case "state:changes":
                for (const c of frame.changes ?? [])
                    this.changed(channel, c.key, c.entry, c.created);
                return;
            case "state:live":
                return this.live(channel, frame, from);
            case "state:cleared": {
                const info: StateCleared = {
                    updatedBy: String(frame.updatedBy),
                    sessionId: from,
                    deviceId: String(frame.deviceId ?? ""),
                    local: false,
                };
                if (typeof frame.prefix === "string") info.prefix = frame.prefix;
                return this.push({ type: "state:cleared", channel, info });
            }
            case "broadcast": {
                const sender = this.client.peers.sender(from, frame.sender);
                if (!sender || typeof frame.msgId !== "string") return;
                const event: MessageEvent = {
                    from: sender,
                    data: frame.data,
                    msgId: frame.msgId,
                    channel,
                    direct: false,
                    ephemeral: frame.ephemeral === true,
                    transport: "socket",
                };
                return this.push({ type: "message", channel, event });
            }
        }
    }

    private changed(channel: string, key: unknown, entry: Entry | undefined, created = false) {
        if (typeof key !== "string" || !entry) return;
        const src = {
            created: created === true,
            live: false,
            local: false,
            transport: "socket" as const,
        };
        this.push({ type: "state:changed", channel, change: changeOf(key, entry, src) });
    }

    /** A live value: reported as a change with `live: true` (watches keep no state). */
    private live(channel: string, frame: Frame, from: string): void {
        const peer = this.client.peers.get(from);
        if (typeof frame.key !== "string" || !peer) return;
        const live = {
            value: frame.value,
            version: frame.version,
            updatedBy: peer.peerId,
            deviceId: peer.deviceId,
            tag: typeof frame.tag === "string" ? frame.tag : undefined,
            at: Date.now(),
        };
        if (live.tag === undefined) delete live.tag;
        const src = { created: false, live: true, local: false, transport: "socket" as const };
        this.push({ type: "state:changed", channel, change: changeOf(frame.key, live, src) });
    }

    private presenceOf(channel: string): Map<string, Record<string, unknown>> {
        let map = this.presence.get(channel);
        if (!map) this.presence.set(channel, (map = new Map()));
        return map;
    }

    private subscriber(sessionId: string, meta: Record<string, unknown>): Subscriber | null {
        const peer = this.client.peers.get(sessionId);
        return peer ? { peer, meta } : null;
    }

    private push(activity: Activity): void {
        this.emit("activity", activity);
    }
}
