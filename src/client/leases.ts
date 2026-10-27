// A channel's leases as this Client sees them: holders, its own requests and renewals.
// See docs/4-client/client-api.md (Leases).
import { P2PError } from "../protocol/errors.ts";
import { isId, type PeerInfo } from "../protocol/types.ts";
import type { P2PClient } from "./client.ts";
import { socketOf } from "./context.ts";

/** Options of `channel.lease`. */
export type LeaseOptions = {
    /** How long the lease lasts without a renewal (1 s - 10 min). Default 30000. */
    ttlMs?: number;
    /** Queue for the lease when another device holds it. Default true. */
    wait?: boolean;
};

/** Payload of `lease:changed`, and what `getLease` returns (without `name`). */
export type LeaseState = { holder: PeerInfo | null; mine: boolean };

type Wanted = { ttlMs: number; wait: boolean };

export class ChannelLeases {
    private client: P2PClient;
    private channel: string;
    private emit: (event: "lease:changed", info: LeaseState & { name: string }) => void;
    /** name -> holder sessionId */
    private holders = new Map<string, string>();
    /** The leases this Client asked for and has not released. */
    private wanted = new Map<string, Wanted>();
    private renewals = new Map<string, ReturnType<typeof setInterval>>();

    constructor(
        client: P2PClient,
        channel: string,
        emit: (event: "lease:changed", info: LeaseState & { name: string }) => void
    ) {
        this.client = client;
        this.channel = channel;
        this.emit = emit;
    }

    get(name: string): LeaseState {
        const sid = this.holders.get(name);
        if (!sid) return { holder: null, mine: false };
        const mine = sid === this.client.sessionId;
        return { holder: mine ? this.client.self : (this.client.peers.get(sid) ?? null), mine };
    }

    async request(name: string, opts: LeaseOptions): Promise<boolean> {
        if (!isId(name)) throw new P2PError("INVALID_ARGUMENT", "name must be 1-128 characters");
        const wanted = { ttlMs: opts.ttlMs ?? 30_000, wait: opts.wait !== false };
        this.wanted.set(name, wanted);
        const ack = await this.send(name, wanted);
        if (ack.granted === true) {
            this.holders.set(name, this.client.sessionId);
            this.renew(name, wanted.ttlMs);
        }
        return ack.granted === true;
    }

    async release(name: string): Promise<void> {
        this.wanted.delete(name);
        this.stopRenewal(name);
        const frame = { type: "lease:release", channel: this.channel, name };
        await socketOf(this.client).request(frame);
    }

    /** Holders from a subscribe ack; after a reconnect, asks again for the wanted leases. */
    load(holders: Record<string, string> | undefined, resubscribe: boolean): void {
        this.holders = new Map(Object.entries(holders ?? {}));
        if (!resubscribe) return;
        for (const [name, wanted] of this.wanted) {
            this.send(name, wanted).then(
                (ack) => {
                    if (ack.granted !== true) return;
                    const changed = this.holders.get(name) !== this.client.sessionId;
                    this.holders.set(name, this.client.sessionId);
                    this.renew(name, wanted.ttlMs);
                    if (changed) this.emit("lease:changed", { name, ...this.get(name) });
                },
                (err) => this.client.emitError(err)
            );
        }
    }

    /** lease:changed from the Server. */
    changed(name: string, holder: string | null): void {
        if (holder) this.holders.set(name, holder);
        else this.holders.delete(name);
        const state = this.get(name);
        const wanted = this.wanted.get(name);
        if (state.mine && wanted) this.renew(name, wanted.ttlMs);
        else this.stopRenewal(name);
        this.emit("lease:changed", { name, ...state });
    }

    /** The connection dropped or the channel ended: renewals stop (the Server released). */
    pause(): void {
        for (const name of [...this.renewals.keys()]) this.stopRenewal(name);
    }

    /** The channel ended for good. */
    stop(): void {
        this.pause();
        this.wanted.clear();
    }

    private send(name: string, wanted: Wanted) {
        const frame = { type: "lease", channel: this.channel, name, ...wanted };
        return socketOf(this.client).request(frame);
    }

    private renew(name: string, ttlMs: number): void {
        if (this.renewals.has(name)) return;
        const every = Math.max(250, Math.floor(ttlMs / 3));
        const timer = setInterval(() => {
            const wanted = this.wanted.get(name);
            if (!wanted) return this.stopRenewal(name);
            this.send(name, wanted).catch(() => {});
        }, every);
        (timer as any).unref?.();
        this.renewals.set(name, timer);
    }

    private stopRenewal(name: string): void {
        clearInterval(this.renewals.get(name));
        this.renewals.delete(name);
    }
}
