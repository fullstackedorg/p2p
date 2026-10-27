// Live values: what keys look like while someone is still changing them. Never stored.
// See docs/1-concepts/protocol-spec.md §5.3.2.
import type { Version } from "../protocol/types.ts";

export type LiveValue = {
    value: unknown;
    version: Version;
    updatedBy: string;
    deviceId: string;
    tag?: string;
    /** When it arrived (or was sent), for the expiry. */
    at: number;
};

export class LiveValues {
    private map = new Map<string, LiveValue>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private ttlMs: number;
    private onExpire: (key: string, live: LiveValue) => void;

    constructor(ttlMs: number, onExpire: (key: string, live: LiveValue) => void) {
        this.ttlMs = ttlMs;
        this.onExpire = onExpire;
    }

    get(key: string): LiveValue | undefined {
        return this.map.get(key);
    }

    keys(): string[] {
        return [...this.map.keys()];
    }

    set(key: string, live: LiveValue): void {
        this.map.set(key, live);
        this.schedule(this.ttlMs);
    }

    drop(key: string): LiveValue | undefined {
        const live = this.map.get(key);
        this.map.delete(key);
        return live;
    }

    /** The live values a session sent (it left the channel). */
    dropFrom(sessionId: string): string[] {
        const keys = [...this.map].filter(([, l]) => l.version[1] === sessionId).map(([k]) => k);
        for (const key of keys) this.map.delete(key);
        return keys;
    }

    clear(): void {
        this.map.clear();
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private schedule(delay: number): void {
        if (this.timer) return;
        this.timer = setTimeout(() => this.sweep(), delay);
        (this.timer as any).unref?.();
    }

    private sweep(): void {
        this.timer = null;
        const now = Date.now();
        let next = Infinity;
        for (const [key, live] of [...this.map]) {
            const left = live.at + this.ttlMs - now;
            if (left > 0) next = Math.min(next, left);
            else {
                this.map.delete(key);
                this.onExpire(key, live);
            }
        }
        if (next !== Infinity) this.schedule(next);
    }
}
