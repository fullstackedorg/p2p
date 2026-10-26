import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import type { EventEmitter } from "node:events";
import { P2PClient, type Channel, type ClientOptions } from "../src/client/index.ts";
import { encodeFrame, FrameDecoder } from "../src/protocol/codec.ts";
import type { Frame } from "../src/protocol/types.ts";
import { loadConfig, type ServerConfig } from "../src/server/config.ts";
import type { Logger } from "../src/server/log.ts";
import { P2PServer } from "../src/server/server.ts";

export const PASSWORDS = { admin: "admin-secret", rw: "rw-secret", ro: "ro-secret" } as const;

export const silentLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
};

export function createTempDir(prefix = "p2p-test-"): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export type TestServer = {
    server: P2PServer;
    port: number;
    dataDir: string;
    config: ServerConfig;
    close(): Promise<void>;
};

export async function startServer(overrides: Partial<ServerConfig> = {}): Promise<TestServer> {
    const dataDir = overrides.dataDir ?? createTempDir();
    const config: ServerConfig = {
        ...loadConfig({}),
        host: "127.0.0.1",
        port: 0,
        dataDir,
        adminPassword: PASSWORDS.admin,
        rwPassword: PASSWORDS.rw,
        roPassword: PASSWORDS.ro,
        heartbeatIntervalMs: 200,
        heartbeatTimeoutMs: 1000,
        snapshotDebounceMs: 10,
        snapshotMaxDelayMs: 50,
        ...overrides,
    };
    const server = new P2PServer(config, silentLogger);
    const { port } = await server.listen();
    let closed = false;
    const close = async () => {
        if (closed) return;
        closed = true;
        await server.close();
        if (!overrides.dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    };
    after(close);
    return { server, port, dataDir, config, close };
}

export type Role = "admin" | "rw" | "ro";

export async function connectClient(
    port: number,
    role: Role = "rw",
    options: Partial<ClientOptions> = {}
): Promise<P2PClient> {
    const client = await P2PClient.connect({
        host: "127.0.0.1",
        port,
        user: role,
        password: PASSWORDS[role],
        reconnect: { initialDelayMs: 20, maxDelayMs: 100 },
        ...options,
    });
    after(() => client.close().catch(() => {}));
    return client;
}

/** Subscribes to a test channel, creating it unless the client is ro. */
export function join(client: P2PClient, channel = "main"): Promise<Channel> {
    return client.subscribe(channel, { create: client.role !== "ro" });
}

export function waitForEvent<T = any>(
    emitter: EventEmitter,
    event: string,
    predicate: (...args: any[]) => boolean = () => true,
    timeoutMs = 2000
): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            emitter.off(event, listener);
            reject(new Error(`Timed out waiting for ${event}`));
        }, timeoutMs);
        const listener = (...args: any[]) => {
            if (!predicate(...args)) return;
            clearTimeout(timer);
            emitter.off(event, listener);
            resolve(args[0]);
        };
        emitter.on(event, listener);
    });
}

/** Collects every emission of an event. */
export function collect<T = any>(emitter: EventEmitter, event: string): T[] {
    const out: T[] = [];
    emitter.on(event, (arg: T) => out.push(arg));
    return out;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

export async function until(check: () => boolean, timeoutMs = 2000, label = "condition") {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
        await sleep(5);
    }
}

/** A hand-driven framed socket, for frames a real Client would never send. */
export type RawSocket = {
    socket: net.Socket;
    send(frame: Frame): void;
    sendBytes(bytes: Uint8Array): void;
    next(type?: string, timeoutMs?: number): Promise<Frame>;
    frames: Frame[];
    closed: Promise<void>;
    auth(role?: Role, extra?: Record<string, unknown>): Promise<Frame>;
    /** Subscribes (creating the channel) and returns the ack. */
    subscribe(channel?: string, extra?: Record<string, unknown>): Promise<Frame>;
};

export function rawSocket(port: number): Promise<RawSocket> {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port });
        const decoder = new FrameDecoder(64 * 1024 * 1024);
        const frames: Frame[] = [];
        const waiters: Array<() => void> = [];
        socket.on("data", (chunk) => {
            frames.push(...decoder.push(chunk as Buffer));
            for (const w of waiters.splice(0)) w();
        });
        socket.on("error", () => {});
        const closed = new Promise<void>((r) => socket.on("close", () => r()));
        after(() => socket.destroy());
        const raw: RawSocket = {
            socket,
            frames,
            closed,
            send: (frame) => socket.write(encodeFrame(frame, Number.MAX_SAFE_INTEGER)),
            sendBytes: (bytes) => socket.write(bytes),
            next(type, timeoutMs = 2000) {
                return new Promise((res, rej) => {
                    const timer = setTimeout(
                        () => rej(new Error(`no ${type ?? "frame"}`)),
                        timeoutMs
                    );
                    const check = () => {
                        const i = frames.findIndex((f) => !type || f.type === type);
                        if (i >= 0) {
                            clearTimeout(timer);
                            res(frames.splice(i, 1)[0]);
                        } else waiters.push(check);
                    };
                    check();
                });
            },
            async auth(role = "rw", extra = {}) {
                raw.send({
                    type: "auth",
                    reqId: 1,
                    version: 2,
                    user: role,
                    password: PASSWORDS[role],
                    ...extra,
                });
                return raw.next("connected");
            },
            async subscribe(channel = "main", extra = {}) {
                raw.send({ type: "subscribe", reqId: 999, channel, create: true, ...extra });
                return raw.next("ack");
            },
        };
        socket.once("connect", () => resolve(raw));
        socket.once("error", reject);
    });
}
