// P2P_* settings. See docs/2-server/configuration.md.

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type ServerConfig = {
    host: string;
    port: number;
    dataDir: string;
    maxConnections: number;
    maxPayloadBytes: number;
    maxBufferedBytes: number;
    maxStateBytes: number;
    maxChannels: number;
    maxChannelsPerSession: number;
    heartbeatIntervalMs: number;
    heartbeatTimeoutMs: number;
    iceServers: unknown[];
    adminUser: string;
    adminPassword?: string;
    rwUser: string;
    rwPassword?: string;
    roUser: string;
    roPassword?: string;
    logLevel: LogLevel;
    /** Not settable from the environment: test hooks for the fixed deadlines of the spec. */
    authTimeoutMs: number;
    snapshotDebounceMs: number;
    snapshotMaxDelayMs: number;
    now: () => number;
};

export class ConfigError extends Error {
    variable: string;

    constructor(variable: string, message: string) {
        super(`${variable}: ${message}`);
        this.name = "ConfigError";
        this.variable = variable;
    }
}

type Env = Record<string, string | undefined>;

function int(env: Env, name: string, fallback: number, min: number, max = 2 ** 31): number {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new ConfigError(name, `expected an integer between ${min} and ${max}, got "${raw}"`);
    }
    return value;
}

function str(env: Env, name: string, fallback: string): string {
    const raw = env[name];
    return raw === undefined || raw === "" ? fallback : raw;
}

function optional(env: Env, name: string): string | undefined {
    const raw = env[name];
    return raw === undefined || raw === "" ? undefined : raw;
}

function iceServers(env: Env): unknown[] {
    const raw = optional(env, "P2P_ICE_SERVERS");
    if (!raw) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new ConfigError("P2P_ICE_SERVERS", "not valid JSON");
    }
    const valid =
        Array.isArray(parsed) &&
        parsed.every((s) => typeof s === "object" && s !== null && "urls" in s);
    if (!valid) throw new ConfigError("P2P_ICE_SERVERS", "expected an array of { urls }");
    return parsed as unknown[];
}

export function validateConfig(config: ServerConfig): ServerConfig {
    if (config.heartbeatTimeoutMs <= config.heartbeatIntervalMs) {
        throw new ConfigError("P2P_HEARTBEAT_TIMEOUT", "must be greater than the interval");
    }
    if (config.maxBufferedBytes < config.maxPayloadBytes) {
        throw new ConfigError("P2P_MAX_BUFFERED_BYTES", "must be >= P2P_MAX_PAYLOAD_BYTES");
    }
    const users = [config.adminUser, config.rwUser, config.roUser];
    if (new Set(users).size !== users.length) {
        throw new ConfigError("P2P_RW_USER", "admin, rw and ro usernames must be distinct");
    }
    if (!LOG_LEVELS.includes(config.logLevel)) {
        throw new ConfigError("P2P_LOG_LEVEL", `expected one of ${LOG_LEVELS.join(", ")}`);
    }
    return config;
}

export function loadConfig(env: Env = process.env): ServerConfig {
    return validateConfig({
        host: str(env, "P2P_HOST", "0.0.0.0"),
        port: int(env, "P2P_PORT", 4444, 0, 65535),
        dataDir: str(env, "P2P_DATA_DIR", "data"),
        maxConnections: int(env, "P2P_MAX_CONNECTIONS", 256, 1),
        maxPayloadBytes: int(env, "P2P_MAX_PAYLOAD_BYTES", 1_048_576, 1024),
        maxBufferedBytes: int(env, "P2P_MAX_BUFFERED_BYTES", 8_388_608, 1024),
        maxStateBytes: int(env, "P2P_MAX_STATE_BYTES", 67_108_864, 1024, Number.MAX_SAFE_INTEGER),
        maxChannels: int(env, "P2P_MAX_CHANNELS", 1024, 1),
        maxChannelsPerSession: int(env, "P2P_MAX_CHANNELS_PER_SESSION", 16, 1),
        heartbeatIntervalMs: int(env, "P2P_HEARTBEAT_INTERVAL", 10, 1) * 1000,
        heartbeatTimeoutMs: int(env, "P2P_HEARTBEAT_TIMEOUT", 30, 1) * 1000,
        iceServers: iceServers(env),
        adminUser: str(env, "P2P_ADMIN_USER", "admin"),
        adminPassword: optional(env, "P2P_ADMIN_PASSWORD"),
        rwUser: str(env, "P2P_RW_USER", "rw"),
        rwPassword: optional(env, "P2P_RW_PASSWORD"),
        roUser: str(env, "P2P_RO_USER", "ro"),
        roPassword: optional(env, "P2P_RO_PASSWORD"),
        logLevel: str(env, "P2P_LOG_LEVEL", "info") as LogLevel,
        authTimeoutMs: 10_000,
        snapshotDebounceMs: 100,
        snapshotMaxDelayMs: 1_000,
        now: Date.now,
    });
}
