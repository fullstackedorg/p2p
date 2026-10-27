import test from "node:test";
import assert from "node:assert/strict";
import type { Activity } from "../src/client/index.ts";
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

test("an inspector sees global presence and channel events", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    await join(a, "room:1");
    const monitor = await connectClient(port, "ro", { mode: "inspect" });
    assert.deepEqual(monitor.getActivePeers()[0].channels, ["room:1"]);
    assert.deepEqual(
        monitor.getSubscribers("room:1").map((p) => p.peerId),
        ["usr_a"]
    );
    const joined = waitForEvent(monitor, "peer:joined");
    const created = waitForEvent(monitor, "channel:created");
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" } });
    await b.createChannel("room:2");
    assert.equal((await joined).peerId, "usr_b");
    assert.equal((await created).id, "room:2");
    await monitor.send("usr_a", "hi").then(
        () => assert.fail("inspectors cannot send"),
        (err) => assert.equal(err.code, "FORBIDDEN")
    );
});

test("an inspector subscription receives the channel and appears nowhere", async () => {
    const { port, server } = await startServer({ maxChannelsPerSession: 1 });
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const room = await a.subscribe("room:1", { create: true, meta: { view: 1 } });
    await room.setState("k", "before");
    for (const id of ["room:2", "room:3"]) await a.createChannel(id);
    const monitor = await connectClient(port, "ro", { mode: "inspect" });
    const watched = await monitor.subscribe("room:1");
    await monitor.subscribe("room:2");
    await monitor.subscribe("room:3"); // not limited to 1
    assert.equal(watched.getState("k"), "before");
    assert.deepEqual(
        watched.getSubscribers().map((s) => [s.peer.peerId, s.meta]),
        [["usr_a", { view: 1 }]]
    );
    const messages = collect(watched, "message");
    const changes = collect(watched, "state:changed");
    const joins = collect(watched, "subscriber:joined");
    await room.broadcast("reliable");
    await room.broadcast("fast", { ephemeral: true });
    await room.setState("k", "after");
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" } });
    const atB = await join(b, "room:1");
    await until(() => messages.length === 2 && changes.length === 1 && joins.length === 1);
    assert.deepEqual(
        messages.map((m) => [m.data, m.ephemeral]),
        [
            ["reliable", false],
            ["fast", true],
        ]
    );
    assert.equal(changes[0].deviceId, a.deviceId);
    assert.deepEqual(
        atB.getSubscribers().map((s) => s.peer.peerId),
        ["usr_a"],
        "the inspector is not a subscriber"
    );
    assert.deepEqual(b.getPeer(a.sessionId)!.channels, ["room:1"]);
    const detail = await b.getSchema("room:1");
    assert.equal(detail.subscribers.length, 2);
    assert.equal(server.channels.subscribers("room:1").length, 2);
    const closed = waitForEvent(watched, "closed");
    await a.deleteChannel("room:1");
    assert.deepEqual(await closed, { reason: "channel_deleted", by: "usr_a" });
});

test("a prefix watch follows every matching channel, now and later", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const room1 = await a.subscribe("room:1", { create: true, meta: { at: "door" } });
    await join(a, "other");
    const monitor = await connectClient(port, "ro", { mode: "inspect" });
    const rooms = await monitor.watch("room:");
    assert.deepEqual(
        rooms.getSubscribers("room:1").map((s) => [s.peer.peerId, s.meta]),
        [["usr_a", { at: "door" }]]
    );
    const activity: Activity[] = [];
    rooms.on("activity", (a) => activity.push(a));
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" } });
    const room2 = await join(b, "room:2"); // created after the watch started
    await room2.setState("item", 1);
    await room2.broadcast("cursor", { ephemeral: true });
    await room1.updatePresence({ at: "window" });
    await a.channel("other")!.broadcast("not watched");
    await room2.unsubscribe();
    await until(() => activity.length === 5);
    assert.deepEqual(
        activity.map((x) => [x.type, x.channel]),
        [
            ["subscriber:joined", "room:2"],
            ["state:changed", "room:2"],
            ["message", "room:2"],
            ["subscriber:updated", "room:1"],
            ["subscriber:left", "room:2"],
        ]
    );
    const change = activity[1] as Extract<Activity, { type: "state:changed" }>;
    assert.equal(change.change.deviceId, b.deviceId);
    assert.equal(change.change.value, 1);
    const left = activity[4] as Extract<Activity, { type: "subscriber:left" }>;
    assert.equal(left.reason, "unsubscribed");
    assert.equal(left.subscriber.peer.peerId, "usr_b");
    assert.deepEqual(rooms.getSubscribers("room:1")[0].meta, { at: "window" });
    await rooms.close();
    await room1.broadcast("after close");
    await sleep(30);
    assert.equal(activity.length, 5);
    await assert.rejects(a.watch("room:"), { code: "FORBIDDEN" });
});

test("a frame reaches an inspector once even when several subscriptions match", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    const room = await join(a, "room:1");
    const raw = await rawSocket(port);
    await raw.auth("ro", { mode: "inspect" });
    await raw.subscribe("room:1", { create: false });
    raw.send({ type: "subscribe", reqId: 2, prefix: "room:" });
    const ack = await raw.next("ack");
    assert.deepEqual(ack.channels, [
        { id: "room:1", subscribers: [{ sessionId: a.sessionId, meta: {} }] },
    ]);
    raw.send({ type: "subscribe", reqId: 3, prefix: "" });
    await raw.next("ack");
    await room.broadcast("once");
    raw.send({ type: "ping" });
    await raw.next("pong");
    assert.equal(raw.frames.filter((f) => f.type === "broadcast").length, 1);
    raw.send({ type: "unsubscribe", reqId: 4, prefix: "nope" });
    assert.equal((await raw.next("error")).code, "NOT_SUBSCRIBED");
    const peer = await rawSocket(port);
    await peer.auth("rw");
    peer.send({ type: "subscribe", reqId: 2, prefix: "room:" });
    assert.equal((await peer.next("error")).code, "FORBIDDEN");
});

test("an inspector renews its subscriptions and watches after a reconnect", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    const room = await join(a, "room:1");
    const monitor = await connectClient(port, "ro", { mode: "inspect" });
    const watched = await monitor.subscribe("room:1");
    const rooms = await monitor.watch("room:");
    const activity = collect(rooms, "activity");
    const messages = collect(watched, "message");
    const back = waitForEvent(monitor, "reconnected");
    monitor.conn!.destroy("connection_lost");
    await back;
    await room.broadcast("after");
    await until(() => messages.length === 1 && activity.length === 1);
    assert.equal(watched.subscribed, true);
});
