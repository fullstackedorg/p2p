import test from "node:test";
import assert from "node:assert/strict";
import { P2PError } from "../src/protocol/errors.ts";
import {
    collect,
    connectClient,
    join,
    sleep,
    startServer,
    until,
    waitForEvent,
} from "./helpers.ts";

test("connect returns identity, peers and channels", async () => {
    const { port } = await startServer();
    const alice = await connectClient(port, "rw", { peer: { id: "usr_alice", name: "Alice" } });
    await join(alice, "board:A");
    const bob = await connectClient(port, "rw", {
        peer: { id: "usr_bob", meta: { color: "red" } },
    });
    assert.equal(alice.peerId, "usr_alice");
    assert.equal(alice.role, "rw");
    assert.equal(alice.sessionId.length, 22);
    assert.ok(alice.deviceId.length > 0);
    assert.deepEqual(
        bob.getActivePeers().map((p) => p.peerId),
        ["usr_alice"]
    );
    assert.equal(bob.getActivePeers()[0].name, "Alice");
    assert.deepEqual(bob.getActivePeers()[0].channels, ["board:A"]);
    assert.deepEqual(
        bob.getChannels().map((c) => [c.id, c.createdBy]),
        [["board:A", "usr_alice"]]
    );
    assert.deepEqual(alice.self.channels, ["board:A"]);
    assert.equal(bob.self.meta.color, "red");
    assert.equal(bob.getTransport(alice.sessionId), "socket");
});

test("peerId defaults to the sessionId", async () => {
    const { port } = await startServer();
    const anon = await connectClient(port);
    assert.equal(anon.peerId, anon.sessionId);
});

test("presence: joined, updated, left in order", async () => {
    const { port } = await startServer();
    const alice = await connectClient(port, "rw", { peer: { id: "usr_alice" } });
    const events: string[] = [];
    for (const e of ["peer:joined", "peer:updated", "peer:left"]) {
        alice.on(e as any, (p: any) => events.push(`${e}:${p.peerId}`));
    }
    const bob = await connectClient(port, "rw", { peer: { id: "usr_bob" } });
    await until(() => events.length === 1);
    await bob.updatePresence({ tool: "pen" }, { name: "Bobby" });
    await until(() => events.length === 2);
    assert.equal(alice.getPeer(bob.sessionId)?.meta.tool, "pen");
    assert.equal(alice.getPeer(bob.sessionId)?.name, "Bobby");
    const left = waitForEvent(alice, "peer:left");
    await bob.close();
    await left;
    assert.deepEqual(events, ["peer:joined:usr_bob", "peer:updated:usr_bob", "peer:left:usr_bob"]);
    assert.equal(alice.getActivePeers().length, 0);
});

test("every role updates its global presence", async () => {
    const { port } = await startServer();
    const rw = await connectClient(port, "rw");
    const ro = await connectClient(port, "ro");
    await ro.updatePresence({ status: "busy" });
    await until(() => rw.getPeer(ro.sessionId)?.meta.status === "busy");
});

test("peer:left carries the close reason", async () => {
    const { port } = await startServer();
    const alice = await connectClient(port);
    const bob = await connectClient(port, "rw", { reconnect: false });
    const reasons: string[] = [];
    alice.on("peer:left", (_p, reason) => reasons.push(reason));
    bob.conn!.destroy("connection_lost");
    await until(() => reasons.length === 1);
    assert.equal(reasons[0], "connection_lost");
});

test("send to a peerId and to a sessionId, whatever the channels", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" } });
    const c = await connectClient(port, "ro", { peer: { id: "usr_c" } });
    await join(a, "board:A");
    await join(b, "board:B");
    const atB = collect(b, "message");
    const atC = collect(c, "message");
    await a.send("usr_b", "to b");
    await a.send({ sessionId: c.sessionId }, "to c");
    await until(() => atB.length === 1 && atC.length === 1);
    assert.equal(atB[0].data, "to b");
    assert.equal(atB[0].direct, true);
    assert.equal(atB[0].channel, undefined);
    assert.equal(atC[0].data, "to c");
    await assert.rejects(a.send("usr_nobody", 1), { code: "PEER_NOT_FOUND" });
});

test("ephemeral send resolves without an ack and arrives flagged", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" } });
    await until(() => a.getActivePeers().length === 1);
    const got = waitForEvent(b, "message");
    await a.send("usr_b", { x: 1 }, { ephemeral: true });
    assert.equal((await got).ephemeral, true);
});

test("request / reply, errors, timeouts and PEER_LEFT", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const b = await connectClient(port, "ro", { peer: { id: "usr_b" } });
    b.on("message", async (event) => {
        if (!event.reply) return;
        if (event.data === "boom") throw new Error("exploded");
        if (event.data === "silent") return;
        if (event.data === "twice") {
            await event.reply(1);
            await assert.rejects(event.reply(2), { code: "INVALID_ARGUMENT" });
            return;
        }
        await event.reply({ pong: event.data });
    });
    await until(() => a.getActivePeers().length === 1);
    assert.deepEqual(await a.request("usr_b", "ping"), { pong: "ping" });
    assert.deepEqual(
        await b.request("usr_a", "ping", { timeoutMs: 100 }).catch((e) => e.code),
        "TIMEOUT"
    );
    assert.equal(await a.request("usr_b", "twice"), 1);
    await assert.rejects(a.request("usr_b", "boom"), (err: P2PError) => {
        return err.code === "REPLY_ERROR" && err.message === "exploded";
    });
    await assert.rejects(a.request("usr_b", "silent", { timeoutMs: 100 }), { code: "TIMEOUT" });
    await assert.rejects(a.request("usr_x", 1), { code: "PEER_NOT_FOUND" });
    const pending = assert.rejects(a.request("usr_b", "silent", { timeoutMs: 5000 }), {
        code: "PEER_LEFT",
    });
    await sleep(20);
    await b.close();
    await pending;
});

test("a reply is accepted only for a request the session received", async () => {
    const { port } = await startServer();
    const { rawSocket } = await import("./helpers.ts");
    const raw = await rawSocket(port);
    const c = await raw.auth("ro");
    const rw = await connectClient(port, "rw");
    raw.send({
        type: "reply",
        reqId: 7,
        msgId: `${c.sessionId}:1`,
        to: { sessionId: rw.sessionId },
        replyTo: "nope",
        data: 1,
    });
    assert.equal((await raw.next("error")).code, "INVALID_ARGUMENT");
});

test("messages too large are rejected before sending", async () => {
    const { port } = await startServer({ maxPayloadBytes: 2048, maxBufferedBytes: 8192 });
    const a = await connectClient(port);
    const b = await connectClient(port);
    const board = await join(a);
    await join(b);
    await assert.rejects(board.broadcast("x".repeat(4096)), { code: "PAYLOAD_TOO_LARGE" });
    await assert.rejects(a.send(b.peerId, "x".repeat(4096)), { code: "PAYLOAD_TOO_LARGE" });
    await assert.rejects(board.setState("k", "x".repeat(4096)), { code: "PAYLOAD_TOO_LARGE" });
    assert.equal(board.getState("k"), undefined);
});
