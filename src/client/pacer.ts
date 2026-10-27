// Throttle and settle for ephemeral updates. See docs/4-client/client-api.md (Pacing).
import { P2PError } from "../protocol/errors.ts";
import { mergeMeta, type Frame } from "../protocol/types.ts";

/** Pacing options of `updatePresence` and `broadcast` (with `ephemeral: true`). */
export type PaceOptions = {
    /** At most one ephemeral send per interval; the latest value goes out at its end. */
    throttleMs?: number;
    /** Once calls stop for this long, the final value is sent again as a regular update. */
    settleMs?: number;
};

export function isPaced(opts: PaceOptions & { ephemeral?: boolean }): boolean {
    if (opts.throttleMs === undefined && opts.settleMs === undefined) return false;
    if (opts.ephemeral !== true)
        throw new P2PError("INVALID_ARGUMENT", "throttleMs and settleMs need ephemeral: true");
    return true;
}

/**
 * Keeps the latest pending value (`combine` folds a new one into it), sends it at most once
 * per `throttleMs`, and calls `send(latest, true)` once calls stop for `settleMs`.
 */
export class Pacer<T> {
    private pending: { value: T } | null = null;
    private latest: T | undefined;
    private sentAt = -Infinity;
    private throttleTimer: ReturnType<typeof setTimeout> | null = null;
    private settleTimer: ReturnType<typeof setTimeout> | null = null;
    private send: (value: T, settled: boolean) => unknown;
    private combine: (pending: T, next: T) => T;
    private onError: (err: unknown) => void;

    constructor(
        send: (value: T, settled: boolean) => unknown,
        combine: (pending: T, next: T) => T,
        onError: (err: unknown) => void
    ) {
        this.send = send;
        this.combine = combine;
        this.onError = onError;
    }

    push(value: T, opts: PaceOptions): void {
        this.latest = value;
        this.pending = this.pending
            ? { value: this.combine(this.pending.value, value) }
            : { value };
        const throttle = Math.max(0, opts.throttleMs ?? 0);
        const wait = this.sentAt + throttle - Date.now();
        if (wait <= 0 && !this.throttleTimer) this.flush();
        else if (!this.throttleTimer) this.throttleTimer = setTimeout(() => this.flush(), wait);
        if (opts.settleMs !== undefined) {
            if (this.settleTimer) clearTimeout(this.settleTimer);
            this.settleTimer = setTimeout(() => this.settle(), Math.max(0, opts.settleMs));
        }
    }

    /** Drops whatever is pending (the channel was left). */
    cancel(): void {
        if (this.throttleTimer) clearTimeout(this.throttleTimer);
        if (this.settleTimer) clearTimeout(this.settleTimer);
        this.throttleTimer = this.settleTimer = null;
        this.pending = null;
    }

    private flush(): void {
        this.throttleTimer = null;
        if (!this.pending) return;
        const { value } = this.pending;
        this.pending = null;
        this.sentAt = Date.now();
        this.run(value, false);
    }

    private settle(): void {
        this.settleTimer = null;
        if (this.throttleTimer) clearTimeout(this.throttleTimer);
        this.throttleTimer = null;
        this.pending = null;
        this.run(this.latest as T, true);
    }

    private run(value: T, settled: boolean): void {
        try {
            Promise.resolve(this.send(value, settled)).catch(this.onError);
        } catch (err) {
            this.onError(err);
        }
    }
}

type PresenceOpts = PaceOptions & { merge?: boolean; ephemeral?: boolean };

/** A paced presence update: a whole meta, or a patch. */
export type PresenceUpdate = { meta: Record<string, unknown>; merge: boolean };

/** Folds a later presence update into a pending one. */
export function foldPresence(a: PresenceUpdate, b: PresenceUpdate): PresenceUpdate {
    if (!b.merge) return b;
    if (a.merge) return { meta: { ...a.meta, ...b.meta }, merge: true };
    const meta = { ...a.meta };
    for (const [k, v] of Object.entries(b.meta)) {
        if (v === null) delete meta[k];
        else meta[k] = v;
    }
    return { meta, merge: false };
}

/** What a channel's presence updates need from the channel. */
export type PresenceHost = {
    id: string;
    meta(): Record<string, unknown>;
    setMeta(meta: Record<string, unknown>): void;
    /** Sends a channel:presence frame: acknowledged, or ephemeral. Nothing once unsubscribed. */
    send(frame: Frame, acked: boolean): Promise<unknown> | void;
};

/** A channel's presence updates and pacers: one for its presence, one per broadcast stream. */
export class ChannelPacing {
    private host: PresenceHost;
    private presencePacer: Pacer<PresenceUpdate>;
    private streams = new Map<string, Pacer<unknown>>();
    private sendBroadcast: (data: unknown, settled: boolean) => unknown;
    private onError: (err: unknown) => void;

    constructor(
        host: PresenceHost,
        sendBroadcast: (data: unknown, settled: boolean) => unknown,
        onError: (err: unknown) => void
    ) {
        this.host = host;
        const send = (update: PresenceUpdate, settled: boolean) =>
            settled
                ? this.sendPresence({ meta: host.meta(), merge: false }, true)
                : this.sendPresence(update, false);
        this.presencePacer = new Pacer(send, foldPresence, onError);
        this.sendBroadcast = sendBroadcast;
        this.onError = onError;
    }

    /** `channel.updatePresence`: acknowledged, ephemeral, or paced. */
    async updatePresence(meta: Record<string, unknown>, opts: PresenceOpts): Promise<void> {
        const update = { meta, merge: opts.merge === true };
        const next = update.merge ? mergeMeta(this.host.meta(), meta) : meta;
        if (isPaced(opts)) {
            this.host.setMeta(next);
            return this.presencePacer.push(update, opts);
        }
        if (opts.ephemeral) this.sendPresence(update, false);
        else await this.sendPresence(update, true);
        this.host.setMeta(next);
    }

    private sendPresence(update: PresenceUpdate, acked: boolean): Promise<unknown> | void {
        const frame: Frame = { type: "channel:presence", channel: this.host.id, meta: update.meta };
        if (update.merge) frame.merge = true;
        return this.host.send(frame, acked);
    }

    broadcast(stream: string, data: unknown, opts: PaceOptions): void {
        let pacer = this.streams.get(stream);
        if (!pacer) {
            pacer = new Pacer(this.sendBroadcast, (_a, b) => b, this.onError);
            this.streams.set(stream, pacer);
        }
        pacer.push(data, opts);
    }

    cancel(): void {
        this.presencePacer.cancel();
        for (const pacer of this.streams.values()) pacer.cancel();
        this.streams.clear();
    }
}
