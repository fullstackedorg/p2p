import test from "node:test";
import assert from "node:assert/strict";
import { ConfigError, loadConfig } from "../src/server/config.ts";

test("defaults", () => {
    const c = loadConfig({});
    assert.equal(c.host, "0.0.0.0");
    assert.equal(c.port, 4444);
    assert.equal(c.dataDir, "data");
    assert.equal(c.maxConnections, 256);
    assert.equal(c.maxPayloadBytes, 1_048_576);
    assert.equal(c.maxBufferedBytes, 8_388_608);
    assert.equal(c.maxStateBytes, 67_108_864);
    assert.equal(c.heartbeatIntervalMs, 10_000);
    assert.equal(c.heartbeatTimeoutMs, 30_000);
    assert.deepEqual(c.iceServers, []);
    assert.deepEqual([c.adminUser, c.rwUser, c.roUser], ["admin", "rw", "ro"]);
    assert.equal(c.adminPassword, undefined);
    assert.equal(c.logLevel, "info");
});

test("every variable is read", () => {
    const c = loadConfig({
        P2P_HOST: "127.0.0.1",
        P2P_PORT: "0",
        P2P_DATA_DIR: "/tmp/x",
        P2P_MAX_CONNECTIONS: "5",
        P2P_MAX_PAYLOAD_BYTES: "4096",
        P2P_MAX_BUFFERED_BYTES: "8192",
        P2P_MAX_STATE_BYTES: "100000",
        P2P_HEARTBEAT_INTERVAL: "2",
        P2P_HEARTBEAT_TIMEOUT: "5",
        P2P_ICE_SERVERS: '[{"urls":"stun:stun.example.com:3478"}]',
        P2P_ADMIN_USER: "root",
        P2P_ADMIN_PASSWORD: "a",
        P2P_RW_USER: "app_rw",
        P2P_RW_PASSWORD: "b",
        P2P_RO_USER: "app_ro",
        P2P_RO_PASSWORD: "c",
        P2P_LOG_LEVEL: "debug",
    });
    assert.equal(c.host, "127.0.0.1");
    assert.equal(c.port, 0);
    assert.equal(c.heartbeatTimeoutMs, 5000);
    assert.deepEqual(c.iceServers, [{ urls: "stun:stun.example.com:3478" }]);
    assert.deepEqual([c.adminUser, c.rwUser, c.roUser], ["root", "app_rw", "app_ro"]);
    assert.equal(c.logLevel, "debug");
});

test("invalid values name the variable", () => {
    const bad: Array<[Record<string, string>, string]> = [
        [{ P2P_PORT: "http" }, "P2P_PORT"],
        [{ P2P_PORT: "70000" }, "P2P_PORT"],
        [{ P2P_MAX_CONNECTIONS: "0" }, "P2P_MAX_CONNECTIONS"],
        [{ P2P_HEARTBEAT_INTERVAL: "30", P2P_HEARTBEAT_TIMEOUT: "30" }, "P2P_HEARTBEAT_TIMEOUT"],
        [{ P2P_ICE_SERVERS: "nope" }, "P2P_ICE_SERVERS"],
        [{ P2P_ICE_SERVERS: '[{"x":1}]' }, "P2P_ICE_SERVERS"],
        [{ P2P_RW_USER: "admin" }, "P2P_RW_USER"],
        [{ P2P_LOG_LEVEL: "loud" }, "P2P_LOG_LEVEL"],
        [{ P2P_MAX_PAYLOAD_BYTES: "9000000" }, "P2P_MAX_BUFFERED_BYTES"],
    ];
    for (const [env, variable] of bad) {
        assert.throws(
            () => loadConfig(env),
            (err: ConfigError) => err.variable === variable
        );
    }
});
