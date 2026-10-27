// node:net listener, connection limits, heartbeat sweep, shutdown. See docs/2-server/server.md.
import { EventEmitter } from "node:events";
import net from "node:net";
import type { CloseReason } from "../protocol/errors.ts";
import { createAuthenticator, type Authenticator } from "./auth.ts";
import { validateConfig, type ServerConfig } from "./config.ts";
import { createLogger, type Logger } from "./log.ts";
import { Channels } from "./channels.ts";
import { Registry } from "./registry.ts";
import { Session, type SessionHost } from "./session.ts";
import { StateStore } from "./state-store.ts";

export type SessionEvent = {
    event: "open" | "close";
    peerId: string;
    deviceId: string;
    sessionId: string;
    role: string;
    mode: string;
    reason?: CloseReason;
};

export class P2PServer extends EventEmitter {
    config: ServerConfig;
    log: Logger;
    auth: Authenticator;
    store: StateStore;
    registry: Registry;
    channels: Channels;
    private server: net.Server;
    private sessions = new Set<Session>();
    private sweep: NodeJS.Timeout | null = null;
    private host: SessionHost;

    constructor(config: ServerConfig, log?: Logger) {
        super();
        this.config = validateConfig(config);
        this.log = log ?? createLogger(config.logLevel);
        this.auth = createAuthenticator(config);
        this.store = new StateStore({
            dataDir: config.dataDir,
            maxStateBytes: config.maxStateBytes,
            debounceMs: config.snapshotDebounceMs,
            maxDelayMs: config.snapshotMaxDelayMs,
            now: config.now,
            log: this.log,
        });
        this.registry = new Registry(config.maxPayloadBytes, config.maxBufferedBytes, config.now);
        this.channels = new Channels(this.registry, this.store, config, config.now);
        this.host = {
            config,
            registry: this.registry,
            channels: this.channels,
            store: this.store,
            auth: this.auth,
            log: this.log,
            onOpen: (s) => this.onOpen(s),
            onClose: (s, reason) => this.onClose(s, reason),
        };
        this.server = net.createServer((socket) => this.accept(socket));
    }

    async listen(): Promise<{ host: string; port: number }> {
        await this.store.load();
        await new Promise<void>((resolve, reject) => {
            this.server.once("error", reject);
            this.server.listen(this.config.port, this.config.host, () => {
                this.server.off("error", reject);
                resolve();
            });
        });
        const every = Math.max(50, Math.min(1000, this.config.heartbeatTimeoutMs / 4));
        this.sweep = setInterval(() => this.sweepSessions(), every);
        this.sweep.unref();
        const address = this.server.address() as net.AddressInfo;
        this.log.info("listening", {
            host: address.address,
            port: address.port,
            roles: this.auth.enabledRoles.join(","),
        });
        if (this.auth.openMode) {
            this.log.warn(
                'open mode: every client is accepted as rw (user "ro": cannot create channels, user "admin": admin); set P2P_*_PASSWORD to require credentials'
            );
        }
        return { host: address.address, port: address.port };
    }

    async close(): Promise<void> {
        if (this.sweep) clearInterval(this.sweep);
        const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
        for (const session of this.sessions) session.close("server_shutdown");
        await Promise.race([closed, new Promise((r) => setTimeout(r, 2000).unref())]);
        await this.store.close();
        this.log.info("stopped");
    }

    flush(): Promise<void> {
        return this.store.flush();
    }

    private accept(socket: net.Socket): void {
        const pending = [...this.sessions].filter((s) => !s.authenticated).length;
        if (pending >= 2 * this.config.maxConnections) {
            socket.destroy();
            return;
        }
        const session = new Session(socket, this.host);
        this.sessions.add(session);
        socket.once("close", () => this.sessions.delete(session));
    }

    private sweepSessions(): void {
        const now = this.config.now();
        for (const s of this.sessions) {
            if (!s.authenticated || s.closed) continue;
            if (now - s.lastReceived > this.config.heartbeatTimeoutMs) {
                s.close("heartbeat_timeout");
                continue;
            }
            for (const [id, r] of s.requests) if (r.expires < now) s.requests.delete(id);
        }
    }

    private event(s: Session, event: "open" | "close", reason?: CloseReason): SessionEvent {
        const { peerId, deviceId, sessionId, role, mode } = s;
        return { event, peerId, deviceId, sessionId, role, mode, reason };
    }

    private onOpen(s: Session): void {
        this.log.info("session open", { peerId: s.peerId, role: s.role, mode: s.mode });
        this.emit("session", this.event(s, "open"));
    }

    private onClose(s: Session, reason: CloseReason): void {
        const channels = [...s.channels.keys()];
        this.channels.leaveAll(s, reason);
        this.registry.leave(s, reason, channels);
        this.log.info("session close", { peerId: s.peerId, role: s.role, reason });
        this.emit("session", this.event(s, "close", reason));
    }
}
