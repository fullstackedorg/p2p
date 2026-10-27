import test from "node:test";
import assert from "node:assert/strict";
import {
    collect,
    connectClient,
    join,
    rawSocket,
    sleep,
    startServer,
    until,
    waitForEvent,
} from "./helpers.ts";

test("channel meta: set at creation, patched with updateChannelMeta, gone with the channel", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" } });
    const created = waitForEvent(b, "channel:created");
    await a.createChannel("room:1", { meta: { title: "Kitchen", color: "red" } });
    assert.deepEqual((await created).meta, { title: "Kitchen", color: "red" });
    await b.subscribe("room:2", { create: { meta: { title: "Garage" } } });
    await until(() => a.getChannels().length === 2);
    assert.deepEqual(
        a.getChannels().map((c) => [c.id, c.meta]),
        [
            ["room:1", { title: "Kitchen", color: "red" }],
            ["room:2", { title: "Garage" }],
        ]
    );
    const updated = waitForEvent(a, "channel:updated");
    await b.updateChannelMeta("room:1", { color: null, size: 3 });
    assert.deepEqual(await updated, {
        channel: {
            ...a.getChannels()[0],
            meta: { title: "Kitchen", size: 3 },
        },
        by: "usr_b",
        sessionId: b.sessionId,
        deviceId: b.deviceId,
    });
    assert.deepEqual(a.getChannels()[0].meta, { title: "Kitchen", size: 3 });
    assert.equal((await a.createChannel("room:1", { meta: { title: "x" } })).created, false);
    assert.deepEqual(a.getChannels()[0].meta.title, "Kitchen", "meta of an existing channel");
    await assert.rejects(a.updateChannelMeta("room:1", { big: "x".repeat(5000) }), {
        code: "INVALID_ARGUMENT",
    });
    await assert.rejects(a.updateChannelMeta("nope", { a: 1 }), { code: "CHANNEL_NOT_FOUND" });
    await a.deleteChannel("room:1");
    await a.createChannel("room:1");
    const recreated = a.getChannels().find((c) => c.id === "room:1")!;
    assert.deepEqual(recreated.meta, {}, "a recreated channel starts without meta");
});

test("channel meta survives a Server restart", async () => {
    const first = await startServer();
    const a = await connectClient(first.port);
    await a.createChannel("room:1", { meta: { title: "Kitchen" } });
    await a.close();
    await first.server.store.flush();
    await first.server.close();
    const second = await startServer({ dataDir: first.dataDir });
    const b = await connectClient(second.port);
    assert.deepEqual(b.getChannels()[0].meta, { title: "Kitchen" });
});

test("peek reads a page of a channel without subscribing, with its stats", async () => {
    const { port } = await startServer({ maxChannelsPerSession: 1 });
    const writer = await connectClient(port, "rw", { peer: { id: "usr_w" } });
    const room = await join(writer, "room:1");
    await room.setState("title", "Kitchen");
    for (let i = 0; i < 3; i++) await room.setState(`item:${i}`, i);
    await room.deleteState("item:2");
    const reader = await connectClient(port, "rw");
    await join(reader, "elsewhere"); // at the channel limit: peek does not count
    const page = await reader.peek("room:1", { prefix: "item:", limit: 1 });
    assert.deepEqual(Object.keys(page.entries), ["item:0"]);
    assert.equal(page.entries["item:0"].value, 0);
    assert.equal(page.entries["item:0"].deviceId, writer.deviceId);
    assert.equal(page.next, "item:0");
    const rest = await reader.peek("room:1", { prefix: "item:", after: page.next });
    assert.deepEqual(Object.keys(rest.entries), ["item:1"]);
    const picked = await reader.peek("room:1", { keys: ["title", "missing", "item:2"] });
    assert.deepEqual(Object.keys(picked.entries), ["title"]);
    assert.equal(picked.stats.keyCount, 3);
    assert.equal(picked.stats.subscriberCount, 1);
    assert.equal(picked.stats.lastWriteBy, "usr_w");
    assert.ok(picked.stats.lastWriteAt! > 0);
    assert.ok(picked.stats.stateBytes > 0);
    assert.deepEqual(reader.self.channels, ["elsewhere"]);
    await writer.createChannel("empty");
    const empty = await reader.peek("empty");
    assert.deepEqual(empty.entries, {});
    assert.equal(empty.stats.lastWriteAt, null);
    await assert.rejects(reader.peek("nope"), { code: "CHANNEL_NOT_FOUND" });
});

test("subscribe with replace switches channels in one presence update", async () => {
    const { port } = await startServer({ maxChannelsPerSession: 1 });
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const inA = await connectClient(port, "rw", { peer: { id: "usr_x" } });
    const inB = await connectClient(port, "rw", { peer: { id: "usr_y" } });
    const atA = await join(inA, "room:a");
    const atB = await join(inB, "room:b");
    const first = await join(a, "room:a");
    await until(() => atA.getSubscribers().length === 1);
    const updates = collect(inB, "peer:updated");
    const left = waitForEvent(atA, "subscriber:left");
    const joined = waitForEvent(atB, "subscriber:joined");
    const closed = waitForEvent(first, "closed");
    const second = await a.subscribe("room:b", { replace: "room:a" }); // at the limit of 1
    assert.equal((await left).peer.sessionId, a.sessionId);
    assert.equal((await joined).peer.sessionId, a.sessionId);
    assert.deepEqual(await closed, { reason: "unsubscribed" });
    assert.equal(first.subscribed, false);
    assert.equal(second.subscribed, true);
    assert.deepEqual(a.self.channels, ["room:b"]);
    await sleep(30);
    const mine = updates.filter((p) => p.sessionId === a.sessionId);
    assert.deepEqual(
        mine.map((p) => p.channels),
        [["room:b"]],
        "one peer:updated, never an empty list"
    );
    await assert.rejects(a.subscribe("room:a", { replace: "room:zzz" }), {
        code: "NOT_SUBSCRIBED",
    });
    const raw = await rawSocket(port);
    await raw.auth("rw");
    await raw.subscribe("room:c");
    raw.send({ type: "subscribe", reqId: 3, channel: "room:a", replace: "room:b" });
    assert.equal((await raw.next("error")).code, "NOT_SUBSCRIBED");
    raw.send({ type: "subscribe", reqId: 4, channel: "room:c", replace: "room:c" });
    assert.equal((await raw.next("error")).code, "INVALID_ARGUMENT");
    raw.send({ type: "subscribe", reqId: 5, channel: "nope", replace: "room:c" });
    assert.equal((await raw.next("error")).code, "CHANNEL_NOT_FOUND");
    raw.send({ type: "unsubscribe", reqId: 6, channel: "room:c" });
    assert.equal((await raw.next("ack")).reqId, 6, "the failed switches changed nothing");
});

test("getSubscribers leaves out this device unless includeSelf", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    const b = await connectClient(port);
    assert.deepEqual(a.getSubscribers("main", { includeSelf: true }), []);
    const atA = await a.subscribe("main", { create: true, meta: { me: 1 } });
    await join(b);
    await until(() => a.getSubscribers("main").length === 1);
    assert.deepEqual(
        a
            .getSubscribers("main", { includeSelf: true })
            .map((p) => p.sessionId)
            .sort(),
        [a.sessionId, b.sessionId].sort()
    );
    const all = atA.getSubscribers({ includeSelf: true });
    assert.equal(all.length, 2);
    assert.deepEqual(all.find((s) => s.peer.sessionId === a.sessionId)!.meta, { me: 1 });
    assert.equal(atA.getSubscribers().length, 1);
});

test("presence patches with merge, globally and in a channel", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { peer: { meta: { color: "red" } } });
    const b = await connectClient(port);
    const atA = await a.subscribe("main", { create: true, meta: { view: 1, tool: "pen" } });
    const atB = await join(b);
    await a.updatePresence({ status: "busy" }, { merge: true });
    await until(() => b.getPeer(a.sessionId)?.meta.status === "busy");
    assert.deepEqual(b.getPeer(a.sessionId)!.meta, { color: "red", status: "busy" });
    assert.deepEqual(a.self.meta, { color: "red", status: "busy" });
    await atA.updatePresence({ tool: null, cursor: [1, 2] }, { merge: true });
    await until(() => atB.getSubscribers()[0]?.meta.cursor !== undefined);
    assert.deepEqual(atB.getSubscribers()[0].meta, { view: 1, cursor: [1, 2] });
    const self = atA
        .getSubscribers({ includeSelf: true })
        .find((s) => s.peer.sessionId === a.sessionId);
    assert.deepEqual(self?.meta, { view: 1, cursor: [1, 2] });
});

test("ephemeral channel presence: no ack, delivered, kept for later subscribers", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    const b = await connectClient(port);
    const atA = await join(a);
    const atB = await join(b);
    const updates = collect(atB, "subscriber:updated");
    for (let x = 1; x <= 5; x++)
        atA.updatePresence({ cursor: x }, { merge: true, ephemeral: true });
    await until(() => updates.at(-1)?.meta.cursor === 5);
    const late = await join(await connectClient(port));
    assert.deepEqual(late.getSubscribers().find((s) => s.peer.sessionId === a.sessionId)!.meta, {
        cursor: 5,
    });
    const raw = await rawSocket(port);
    await raw.auth("rw");
    await raw.subscribe("main");
    raw.send({ type: "channel:presence", channel: "main", meta: { x: 1 }, ephemeral: true });
    raw.send({ type: "ping" });
    await raw.next("pong");
    assert.equal(raw.frames.filter((f) => f.type === "ack" || f.type === "error").length, 0);
});
