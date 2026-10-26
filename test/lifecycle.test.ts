import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { P2PClient } from "../src/client/index.ts";
import { probe } from "../src/server/healthcheck.ts";
import {
    PASSWORDS,
    collect,
    connectClient,
    createTempDir,
    join,
    rawSocket,
    sleep,
    startServer,
    until,
} from "./helpers.ts";

test("auth deadline closes silent sockets with auth_timeout", async () => {
    const { port } = await startServer({ authTimeoutMs: 100 });
    const raw = await rawSocket(port);
    assert.equal((await raw.next("close")).reason, "auth_timeout");
});

test("server_full when every connection slot is taken", async () => {
    const { port } = await startServer({ maxConnections: 2 });
    await connectClient(port);
    await connectClient(port, "rw", { mode: "inspect" });
    await assert.rejects(
        P2PClient.connect({ host: "127.0.0.1", port, user: "rw", password: PASSWORDS.rw }),
        { code: "SERVER_FULL" }
    );
});

test("oversized frames close with payload_too_large, unknown types with invalid_frame", async () => {
    const { port } = await startServer({ maxPayloadBytes: 4096, maxBufferedBytes: 8192 });
    const big = await rawSocket(port);
    await big.auth("rw");
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, 4097);
    big.sendBytes(header);
    assert.equal((await big.next("close")).reason, "payload_too_large");
    const odd = await rawSocket(port);
    await odd.auth("rw");
    odd.send({ type: "teleport" });
    assert.equal((await odd.next("close")).reason, "invalid_frame");
});

test("heartbeat: silent sessions time out, idle clients stay alive with pings", async () => {
    const { port } = await startServer({ heartbeatIntervalMs: 100, heartbeatTimeoutMs: 400 });
    const silent = await rawSocket(port);
    await silent.auth("rw");
    const idle = await connectClient(port);
    const left = collect(idle, "peer:left");
    assert.equal((await silent.next("close", 2000)).reason, "heartbeat_timeout");
    await sleep(600);
    assert.equal(idle.connected, true);
    assert.deepEqual(left.map((p) => p.sessionId).length, 1);
});

test("a dropped connection reconnects with the same identity; pending calls reject DISCONNECTED", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { deviceId: "dev-a" });
    const b = await connectClient(port);
    await until(() => b.getActivePeers().length === 1);
    const firstSession = a.sessionId;
    const peerId = a.peerId;
    const disconnected = new Promise((r) => a.once("disconnected", r));
    const reconnected = new Promise((r) => a.once("reconnected", r));
    const joined = collect(b, "peer:joined");
    const board = await join(a);
    a.conn!.destroy("connection_lost");
    assert.deepEqual(await disconnected, { reason: "connection_lost" });
    await assert.rejects(board.broadcast(1), { code: "DISCONNECTED" });
    await assert.rejects(a.send(b.peerId, 1), { code: "DISCONNECTED" });
    await reconnected;
    assert.notEqual(a.sessionId, firstSession);
    assert.equal(a.peerId, peerId);
    assert.equal(a.deviceId, "dev-a");
    await until(() => joined.length === 1);
    assert.equal(joined[0].peerId, peerId);
    await board.broadcast("back");
});

test("clients reconnect to a restarted Server and keep the state", async () => {
    const dataDir = createTempDir();
    const first = await startServer({ dataDir });
    const port = first.port;
    const a = await connectClient(port);
    const board = await join(a);
    await board.setState("k", "v");
    const reasons = collect(a, "disconnected");
    const reconnected = new Promise((r) => a.once("reconnected", r));
    await first.close();
    assert.ok(fs.readFileSync(path.join(dataDir, "state.json"), "utf-8").includes('"v"'));
    await startServer({ dataDir, port });
    await reconnected;
    assert.deepEqual(reasons, [{ reason: "server_shutdown" }]);
    assert.equal(board.getState("k"), "v");
    assert.equal(board.subscribed, true);
});

test("close() sends bye: peers see client_close, the client emits close", async () => {
    const { port, server } = await startServer();
    const a = await connectClient(port);
    const b = await connectClient(port);
    const sessions = collect(server, "session");
    const reasons: string[] = [];
    a.on("peer:left", (_p, reason) => reasons.push(reason));
    const closed = new Promise((r) => b.once("close", r));
    await b.close();
    assert.deepEqual(await closed, { reason: "client_close" });
    await until(() => reasons.length === 1);
    assert.equal(reasons[0], "client_close");
    assert.equal(sessions.at(-1).event, "close");
    assert.equal(b.connected, false);
});

test("reconnect: false ends with close and the reason", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { reconnect: false });
    const closed = new Promise((r) => a.once("close", r));
    a.conn!.destroy("connection_lost");
    assert.deepEqual(await closed, { reason: "connection_lost" });
});

test("beforeConnect refreshes credentials; role:changed reports a new role", async () => {
    const { port } = await startServer();
    const attempts: number[] = [];
    const a = await connectClient(port, "rw", {
        beforeConnect: ({ attempt }) => {
            attempts.push(attempt);
            if (attempt === 0) return {};
            if (attempt === 1) return { user: "ro", password: "wrong" }; // retried: auth_failed
            return { user: "ro", password: PASSWORDS.ro };
        },
    });
    assert.equal(a.role, "rw");
    const roleChanged = new Promise((r) => a.once("role:changed", r));
    a.conn!.destroy("connection_lost");
    assert.deepEqual(await roleChanged, { role: "ro", previous: "rw" });
    assert.deepEqual(attempts.slice(0, 3), [0, 1, 2]);
    await assert.rejects(a.createChannel("k"), { code: "FORBIDDEN" });
});

test("graceful shutdown flushes the last writes", async () => {
    const dataDir = createTempDir();
    const srv = await startServer({
        dataDir,
        snapshotDebounceMs: 10_000,
        snapshotMaxDelayMs: 10_000,
    });
    const a = await connectClient(srv.port);
    await (await join(a)).setState("last", 42);
    await srv.close();
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf-8"));
    assert.equal(file.channels.main.entries.last.value, 42);
});

test("health probe", async () => {
    const { port, close } = await startServer();
    assert.equal(await probe("127.0.0.1", port), true);
    await close();
    assert.equal(await probe("127.0.0.1", port, 500), false);
});
