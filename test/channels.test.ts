import test from "node:test";
import assert from "node:assert/strict";
import {
    collect,
    connectClient,
    createTempDir,
    join,
    rawSocket,
    sleep,
    startServer,
    until,
    waitForEvent,
} from "./helpers.ts";

test("a list screen sees every channel and who is on it without receiving anything", async () => {
    const { port } = await startServer();
    const alice = await connectClient(port, "rw", { peer: { id: "usr_alice" } });
    const list = await connectClient(port, "rw", { peer: { id: "usr_list" } });
    const created = collect(list, "channel:created");
    const updates = collect(list, "peer:updated");
    const raw = await rawSocket(port);
    await raw.auth("rw");
    const boardA = await alice.subscribe("board:A", { create: true });
    await alice.createChannel("board:B");
    await until(() => created.length === 2 && updates.length === 1);
    assert.deepEqual(
        list.getChannels().map((c) => c.id),
        ["board:A", "board:B"]
    );
    assert.deepEqual(
        list.getSubscribers("board:A").map((p) => p.peerId),
        ["usr_alice"]
    );
    assert.deepEqual(list.getSubscribers("board:B"), []);
    assert.deepEqual(updates[0].channels, ["board:A"]);
    raw.frames.length = 0;
    await boardA.setState("stroke:1", [1, 2]);
    await boardA.broadcast({ cursor: 1 });
    await boardA.broadcast({ cursor: 2 }, { ephemeral: true });
    await boardA.updatePresence({ view: [0, 0] });
    await sleep(50);
    const types = raw.frames.map((f) => f.type);
    assert.deepEqual(types, [], "nothing from board:A reaches a non-subscriber");
});

test("subscribing loads subscribers with their channel presence and the state", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const b = await connectClient(port, "ro", { peer: { id: "usr_b" } });
    const boardA = await a.subscribe("board:A", { create: true, meta: { view: [1, 2] } });
    await boardA.setState("title", "Board A");
    const joined = waitForEvent(boardA, "subscriber:joined");
    const atB = await b.subscribe("board:A", { meta: { view: [3, 4] } });
    assert.equal(atB.getState("title"), "Board A");
    assert.deepEqual(
        atB.getSubscribers().map((s) => [s.peer.peerId, s.meta]),
        [["usr_a", { view: [1, 2] }]]
    );
    const sub = await joined;
    assert.equal(sub.peer.peerId, "usr_b");
    assert.deepEqual(sub.meta, { view: [3, 4] });
    assert.equal(b.channel("board:A"), atB);
    assert.equal(await b.subscribe("board:A"), atB, "subscribing again returns the same object");
});

test("channel presence reaches the channel's subscribers only", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    const b = await connectClient(port);
    const outsider = await connectClient(port);
    const boardA = await join(a, "board:A");
    const atB = await join(b, "board:A");
    await join(outsider, "board:B");
    const outsiderUpdates = collect(outsider, "peer:updated");
    const updated = waitForEvent(atB, "subscriber:updated");
    await boardA.updatePresence({ view: [10, 20] });
    const sub = await updated;
    assert.equal(sub.peer.sessionId, a.sessionId);
    assert.deepEqual(sub.meta, { view: [10, 20] });
    assert.deepEqual(atB.getSubscribers()[0].meta, { view: [10, 20] });
    await sleep(30);
    assert.equal(outsiderUpdates.length, 0, "channel presence is not global presence");
});

test("broadcasts stay in their channel and reach the sender's other devices", async () => {
    const { port } = await startServer();
    const a1 = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const a2 = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const b = await connectClient(port, "ro", { peer: { id: "usr_b" } });
    const c = await connectClient(port, "rw", { peer: { id: "usr_c" } });
    const boardA = await join(a1, "board:A");
    const a2A = await join(a2, "board:A");
    const bA = await join(b, "board:A");
    const cB = await join(c, "board:B");
    const atA1 = collect(boardA, "message");
    const atA2 = collect(a2A, "message");
    const atB = collect(bA, "message");
    const atC = collect(cB, "message");
    const atClient = collect(b, "message");
    await boardA.broadcast({ hello: 1 });
    await bA.broadcast({ from: "ro" });
    await until(() => atA2.length === 2 && atB.length === 1 && atA1.length === 1);
    await sleep(20);
    assert.equal(atC.length, 0);
    assert.equal(atClient.length, 0, "broadcasts are emitted on the Channel, not the client");
    assert.deepEqual(atB[0].data, { hello: 1 });
    assert.equal(atB[0].channel, "board:A");
    assert.equal(atB[0].direct, false);
    assert.equal(atB[0].transport, "socket");
    assert.ok(atB[0].msgId.startsWith(a1.sessionId + ":"));
    assert.deepEqual(atA1[0].data, { from: "ro" });
});

test("unsubscribe stops everything from that channel and announces it", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    const b = await connectClient(port);
    const boardA = await join(a, "board:A");
    const atB = await join(b, "board:A");
    const reasons: string[] = [];
    boardA.on("subscriber:left", (_s, reason) => reasons.push(reason));
    const updated = waitForEvent(a, "peer:updated", (p) => p.sessionId === b.sessionId);
    const closed = waitForEvent(atB, "closed");
    await atB.unsubscribe();
    assert.deepEqual(await closed, { reason: "unsubscribed" });
    assert.equal(atB.subscribed, false);
    assert.equal(b.channel("board:A"), undefined);
    assert.deepEqual((await updated).channels, []);
    await until(() => reasons.length === 1);
    assert.deepEqual(reasons, ["unsubscribed"]);
    const messages = collect(atB, "message");
    await boardA.broadcast(1);
    await boardA.setState("k", 1);
    await sleep(30);
    assert.equal(messages.length, 0);
    assert.equal(atB.getState("k"), undefined);
    await assert.rejects(atB.setState("k", 2), { code: "NOT_SUBSCRIBED" });
    await assert.rejects(atB.broadcast(1), { code: "NOT_SUBSCRIBED" });
});

test("a session closing leaves its channels with its close reason", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    const b = await connectClient(port, "rw", { reconnect: false });
    const boardA = await join(a, "board:A");
    await join(b, "board:A");
    const order: string[] = [];
    boardA.on("subscriber:left", (_s, reason) => order.push(`subscriber:left:${reason}`));
    a.on("peer:left", () => order.push("peer:left"));
    await b.close();
    await until(() => order.length === 2);
    assert.deepEqual(order, ["subscriber:left:client_close", "peer:left"]);
    assert.deepEqual(boardA.getSubscribers(), []);
});

test("ro joins existing channels only; rw and admin create and delete them", async () => {
    const { port } = await startServer();
    const ro = await connectClient(port, "ro");
    const rw = await connectClient(port, "rw");
    const admin = await connectClient(port, "admin");
    await assert.rejects(ro.subscribe("board:new", { create: true }), { code: "FORBIDDEN" });
    await assert.rejects(ro.subscribe("board:new"), { code: "CHANNEL_NOT_FOUND" });
    await assert.rejects(ro.createChannel("board:new"), { code: "FORBIDDEN" });
    await assert.rejects(rw.subscribe("board:new"), { code: "CHANNEL_NOT_FOUND" });
    assert.deepEqual(await rw.createChannel("board:new"), {
        created: true,
        channel: rw.getChannels()[0],
    });
    assert.equal((await admin.createChannel("board:new")).created, false);
    const atRo = await ro.subscribe("board:new", { create: true }); // exists: create is a no-op
    await atRo.setState("k", "ro writes");
    await assert.rejects(ro.deleteChannel("board:new"), { code: "FORBIDDEN" });
    await admin.deleteChannel("board:new");
    await until(() => !atRo.subscribed);
    assert.deepEqual(rw.getChannels(), []);
});

test("deleting a channel closes it for its subscribers and drops its state", async () => {
    const { port, server } = await startServer();
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" } });
    const list = await connectClient(port);
    const boardA = await join(a, "board:A");
    const atB = await join(b, "board:A");
    await boardA.setState("k", "v");
    const deleted = waitForEvent(list, "channel:deleted");
    const closed = waitForEvent(atB, "closed");
    const updated = waitForEvent(list, "peer:updated", (p) => p.sessionId === b.sessionId);
    await a.deleteChannel("board:A");
    assert.deepEqual(await closed, { reason: "channel_deleted", by: "usr_a" });
    assert.deepEqual(await deleted, { channel: "board:A", by: "usr_a" });
    assert.deepEqual((await updated).channels, []);
    assert.equal(boardA.subscribed, false);
    assert.equal(server.store.get("board:A"), undefined);
    const again = await join(b, "board:A");
    assert.deepEqual(again.getState(), {}, "a recreated channel starts empty");
});

test("channel ids are validated on both sides", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    for (const id of ["", "a b", "x".repeat(129), "board/1", "é"]) {
        await assert.rejects(a.subscribe(id, { create: true }), { code: "INVALID_CHANNEL" });
    }
    const raw = await rawSocket(port);
    await raw.auth("rw");
    raw.send({ type: "subscribe", reqId: 2, channel: "bad id", create: true });
    assert.equal((await raw.next("error")).code, "INVALID_CHANNEL");
    raw.send({ type: "state:set", reqId: 3, channel: 5, key: "k", value: 1, version: [1, "x"] });
    assert.equal((await raw.next("error")).code, "INVALID_CHANNEL");
});

test("channel frames for a channel the sender is not subscribed to: NOT_SUBSCRIBED", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    await join(a, "board:A");
    const raw = await rawSocket(port);
    const c = await raw.auth("rw");
    const id = c.sessionId;
    const frames = [
        { type: "broadcast", reqId: 2, channel: "board:A", msgId: `${id}:1`, data: 1 },
        { type: "state:set", reqId: 3, channel: "board:A", key: "k", value: 1, version: [1, id] },
        { type: "state:clear", reqId: 4, channel: "board:A", version: [1, id] },
        { type: "channel:presence", reqId: 5, channel: "board:A", meta: {} },
        { type: "media:chunk", reqId: 6, channel: "board:A", streamId: "s", data: "" },
        { type: "unsubscribe", reqId: 7, channel: "board:A" },
    ];
    for (const f of frames) {
        raw.send(f);
        const err = await raw.next("error");
        assert.equal(err.code, "NOT_SUBSCRIBED");
        assert.equal(err.reqId, f.reqId);
    }
});

test("CHANNEL_LIMIT per session and per Server", async () => {
    const { port } = await startServer({ maxChannelsPerSession: 2, maxChannels: 3 });
    const a = await connectClient(port);
    await join(a, "c1");
    await join(a, "c2");
    await assert.rejects(join(a, "c3"), { code: "CHANNEL_LIMIT" }); // local check
    const raw = await rawSocket(port);
    await raw.auth("rw");
    await raw.subscribe("c1");
    await raw.subscribe("c2");
    raw.send({ type: "subscribe", reqId: 5, channel: "c3", create: true });
    assert.equal((await raw.next("error")).code, "CHANNEL_LIMIT");
    await a.createChannel("c3");
    await assert.rejects(a.createChannel("c4"), { code: "CHANNEL_LIMIT" });
});

test("reconnect subscribes again, reports what changed, and closes deleted channels", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" } });
    const boardA = await join(a, "board:A");
    const boardB = await join(a, "board:B");
    const bA = await join(b, "board:A");
    await join(b, "board:B");
    await boardA.setState("keep", 1);
    await until(() => bA.getState("keep") === 1);
    const changes = collect(boardA, "state:changed");
    const closedB = waitForEvent(boardB, "closed");
    const reconnected = waitForEvent(a, "reconnected");
    a.conn!.destroy("connection_lost");
    await bA.setState("added", 2);
    await b.deleteChannel("board:B");
    await reconnected;
    assert.deepEqual(await closedB, { reason: "channel_deleted" });
    assert.equal(boardA.subscribed, true);
    assert.equal(boardA.getState("added"), 2);
    assert.equal(boardA.getState("keep"), 1);
    assert.deepEqual(
        changes.map((c) => c.key),
        ["added"]
    );
    assert.deepEqual(a.self.channels, ["board:A"]);
    await until(() => b.getPeer(a.sessionId)?.channels.join() === "board:A");
    const got = waitForEvent(bA, "message");
    await boardA.broadcast("after reconnect");
    assert.equal((await got).data, "after reconnect");
});

test("channels and their state survive a Server restart", async () => {
    const dataDir = createTempDir();
    const first = await startServer({ dataDir });
    const a = await connectClient(first.port);
    const board = await join(a, "board:A");
    await board.setState("k", "v");
    await a.close();
    await first.close();
    const second = await startServer({ dataDir });
    const b = await connectClient(second.port);
    assert.deepEqual(
        b.getChannels().map((c) => c.id),
        ["board:A"]
    );
    assert.equal((await b.subscribe("board:A")).getState("k"), "v");
});
