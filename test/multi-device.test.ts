import test from "node:test";
import assert from "node:assert/strict";
import { collect, connectClient, join, rawSocket, sleep, startServer, until } from "./helpers.ts";

test("one peerId on many devices: all coexist with their own meta and channels", async () => {
    const { port } = await startServer();
    const laptop = await connectClient(port, "rw", {
        peer: { id: "usr_alice", meta: { device: "laptop" } },
    });
    const phone = await connectClient(port, "rw", {
        peer: { id: "usr_alice", meta: { device: "phone" } },
    });
    const devices = [];
    for (let i = 0; i < 20; i++)
        devices.push(await connectClient(port, "rw", { peer: { id: "usr_alice" } }));
    await join(laptop, "board:A");
    await join(phone, "board:B");
    const bob = await connectClient(port, "rw", { peer: { id: "usr_bob" } });
    await until(() => bob.getPeers("usr_alice").length === 22);
    assert.deepEqual(bob.getPeer(laptop.sessionId)?.channels, ["board:A"]);
    assert.deepEqual(bob.getPeer(phone.sessionId)?.channels, ["board:B"]);
    assert.deepEqual(
        bob
            .getPeers("usr_alice")
            .slice(0, 2)
            .map((p) => p.meta.device),
        ["laptop", "phone"]
    );
    assert.notEqual(laptop.deviceId, phone.deviceId);
    assert.equal(laptop.getPeers(laptop.peerId).length, 21); // own other devices, not itself
    const schema = await bob.getSchema();
    assert.equal(schema.userCount, 2);
    assert.equal(schema.peerCount, 23);
});

test("send to a peerId reaches every device; to own peerId only the other devices", async () => {
    const { port } = await startServer();
    const a1 = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const a2 = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" } });
    await until(() => b.getPeers("usr_a").length === 2 && a1.getActivePeers().length === 2);
    const at1 = collect(a1, "message");
    const at2 = collect(a2, "message");
    await b.send("usr_a", "both");
    await until(() => at1.length === 1 && at2.length === 1);
    await a1.send(a1.peerId, "my other devices");
    await until(() => at2.length === 2);
    await sleep(20);
    assert.equal(at1.length, 1);
    assert.equal(at2[1].from.peerId, "usr_a");
    await b.send({ sessionId: a2.sessionId }, "one");
    await until(() => at2.length === 3);
    assert.equal(at1.length, 1);
    const board1 = await join(a1);
    const board2 = await join(a2);
    const atBoard2 = collect(board2, "message");
    await board1.broadcast("all");
    await until(() => atBoard2.length === 1);
    const solo = await connectClient(port, "rw", { peer: { id: "usr_solo" } });
    await until(() => solo.getActivePeers().length === 3);
    await assert.rejects(solo.send(solo.peerId, 1), { code: "PEER_NOT_FOUND" });
});

test("request to a peerId goes to exactly one device: the most recent", async () => {
    const { port } = await startServer();
    const old = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    await sleep(5);
    const recent = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" } });
    let oldCalls = 0;
    old.on("message", (e) => {
        oldCalls++;
        e.reply?.("old");
    });
    recent.on("message", (e) => e.reply?.("recent"));
    await until(() => b.getPeers("usr_a").length === 2);
    assert.equal(await b.request("usr_a", "who"), "recent");
    assert.equal(await b.request({ sessionId: old.sessionId }, "who"), "old");
    assert.equal(oldCalls, 1);
});

test("same peerId and deviceId replaces only that device, with replaces", async () => {
    const { port } = await startServer();
    const watcher = await connectClient(port, "rw", { peer: { id: "usr_w" } });
    const board = await join(watcher);
    const other = await connectClient(port, "rw", { peer: { id: "usr_a" }, deviceId: "phone" });
    const first = await rawSocket(port);
    const c1 = await first.auth("rw", { peer: { id: "usr_a" }, deviceId: "laptop" });
    await first.subscribe("main");
    await until(() => watcher.getActivePeers().length === 2 && board.getSubscribers().length === 1);
    const events: string[] = [];
    board.on("subscriber:left", (s, reason) =>
        events.push(`sub-left:${s.peer.sessionId}:${reason}`)
    );
    watcher.on("peer:left", (p, reason) => events.push(`left:${p.sessionId}:${reason}`));
    watcher.on("peer:joined", (p, info) => events.push(`joined:${p.sessionId}:${info.replaces}`));
    const second = await rawSocket(port);
    const c2 = await second.auth("rw", { peer: { id: "usr_a" }, deviceId: "laptop" });
    assert.equal((await first.next("close")).reason, "session_replaced");
    await until(() => events.length === 3);
    assert.deepEqual(events, [
        `sub-left:${c1.sessionId}:session_replaced`,
        `left:${c1.sessionId}:session_replaced`,
        `joined:${c2.sessionId}:${c1.sessionId}`,
    ]);
    assert.ok(watcher.getPeer(other.sessionId), "the other device is untouched");
    assert.equal(watcher.getPeers("usr_a").length, 2);
});

test("a replaced client does not reconnect and reports session_replaced", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" }, deviceId: "d1" });
    const closed = new Promise((r) => a.once("close", r));
    await connectClient(port, "rw", { peer: { id: "usr_a" }, deviceId: "d1" });
    assert.deepEqual(await closed, { reason: "session_replaced" });
});

test("state writes are attributed to the user and the writing device", async () => {
    const { port } = await startServer();
    const a1 = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" } });
    const atA1 = await join(a1);
    const changes = collect(await join(b), "state:changed");
    await atA1.setState("k", 1);
    await until(() => changes.length === 1);
    assert.equal(changes[0].updatedBy, "usr_a");
    const entry = (await b.query({ operation: "getState", channel: "main", key: "k" })).entries.k;
    assert.equal(entry.version[1], a1.sessionId);
});
