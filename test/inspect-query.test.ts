import test from "node:test";
import assert from "node:assert/strict";
import { collect, connectClient, join, sleep, startServer, until } from "./helpers.ts";

test("schema reports peers, devices, channels, limits and counters", async () => {
    const { port } = await startServer({ maxConnections: 50 });
    const a = await connectClient(port, "rw", { peer: { id: "usr_a", name: "A" } });
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" } });
    const boardA = await join(a, "board:A");
    const atB = await join(b, "board:A");
    await a.createChannel("board:B");
    await boardA.setState("shape:1", { x: 1 });
    await boardA.setState("label", "hi");
    await boardA.deleteState("label");
    await until(() => atB.getState("shape:1") !== undefined);
    await boardA.broadcast("x");
    const tool = await connectClient(port, "ro", { mode: "inspect" });
    const schema = await tool.getSchema();
    assert.equal(schema.peerCount, 2);
    assert.equal(schema.userCount, 2);
    assert.equal(schema.inspectorCount, 1);
    assert.equal(schema.connections, 3);
    assert.equal(schema.maxConnections, 50);
    assert.equal(schema.maxChannels, 1024);
    assert.ok(schema.storageBytes > 0 && schema.maxStateBytes > 0);
    assert.equal(schema.channelCount, 2);
    assert.deepEqual(
        schema.channels.map((c: any) => [c.id, c.createdBy, c.subscriberCount, c.keyCount]),
        [
            ["board:A", "usr_a", 2, 1],
            ["board:B", "usr_a", 0, 0],
        ]
    );
    const peerA = schema.peers.find((p: any) => p.peerId === "usr_a");
    assert.equal(peerA.name, "A");
    assert.deepEqual(peerA.channels, ["board:A"]);
    assert.equal(typeof peerA.socketWritableBytes, "number");
    assert.ok(schema.stats.relayedFrames >= 1);
    const detail = await tool.getSchema("board:A");
    assert.equal(detail.id, "board:A");
    assert.equal(detail.keyCount, 1);
    assert.deepEqual(
        detail.keys.map((k: any) => [k.key, k.type, k.updatedBy]),
        [["shape:1", "object", "usr_a"]]
    );
    assert.deepEqual(detail.subscribers.map((s: any) => s.peerId).sort(), ["usr_a", "usr_b"]);
    await assert.rejects(tool.getSchema("board:nope"), { code: "CHANNEL_NOT_FOUND" });
});

test("query reads for every role, paging and prefix", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const board = await join(a);
    for (let i = 0; i < 5; i++) await board.setState(`item:${i}`, i);
    await board.setState("other", 1);
    await a.createChannel("board:x");
    const tool = await connectClient(port, "ro", { mode: "inspect" });
    assert.deepEqual(
        (await tool.query({ operation: "peers" })).map((p: any) => p.peerId),
        ["usr_a"]
    );
    assert.equal((await tool.query({ operation: "peers", peerId: "usr_x" })).length, 0);
    assert.equal((await tool.query({ operation: "peers", channel: "main" })).length, 1);
    assert.equal((await tool.query({ operation: "peers", channel: "board:x" })).length, 0);
    assert.deepEqual(
        (await tool.query({ operation: "channels" })).map((c: any) => c.id),
        ["board:x", "main"]
    );
    assert.deepEqual(
        (await tool.query({ operation: "channels", prefix: "board:" })).map((c: any) => c.id),
        ["board:x"]
    );
    const q = { operation: "getState", channel: "main", prefix: "item:", limit: 2 };
    const page1 = await tool.query(q);
    assert.deepEqual(Object.keys(page1.entries), ["item:0", "item:1"]);
    const page2 = await tool.query({ ...q, after: page1.next });
    assert.deepEqual(Object.keys(page2.entries), ["item:2", "item:3"]);
    const last = await tool.query({ ...q, limit: undefined, after: page2.next });
    assert.deepEqual(Object.keys(last.entries), ["item:4"]);
    assert.equal(last.next, undefined);
    const one = await tool.query({ operation: "getState", channel: "main", key: "other" });
    assert.deepEqual(Object.keys(one.entries), ["other"]);
    await assert.rejects(tool.query({ operation: "getState", channel: "nope" }), {
        code: "CHANNEL_NOT_FOUND",
    });
    await assert.rejects(tool.query({ operation: "getState", channel: "bad id" }), {
        code: "INVALID_CHANNEL",
    });
    await assert.rejects(tool.query({ operation: "setState", channel: "nope", key: "k" }), {
        code: "CHANNEL_NOT_FOUND",
    });
    await assert.rejects(tool.query({ operation: "createChannel", channel: "new" }), {
        code: "FORBIDDEN",
    });
    await assert.rejects(tool.query({ operation: "deleteChannel", channel: "main" }), {
        code: "FORBIDDEN",
    });
    await tool.query({ operation: "deleteState", channel: "main", key: "other" }); // ro writes
    await assert.rejects(tool.query({ operation: "nope" }), { code: "INVALID_ARGUMENT" });
});

test("query writes are ordinary events for subscribers only, attributed to the inspector", async () => {
    const { port } = await startServer();
    const peer = await connectClient(port, "rw", { peer: { id: "usr_p" } });
    const board = await join(peer);
    const outsider = await connectClient(port, "rw", { peer: { id: "usr_o" } });
    const elsewhere = await join(outsider, "elsewhere");
    const tool = await connectClient(port, "admin", { mode: "inspect", peer: { id: "usr_ops" } });
    const changes = collect(board, "state:changed");
    const outside = collect(elsewhere, "state:changed");
    const broadcasts = collect(board, "message");
    const direct = collect(peer, "message");
    const set = await tool.query({ operation: "setState", channel: "main", key: "a:1", value: 1 });
    assert.equal(set.applied, true);
    await tool.query({ operation: "setState", channel: "main", key: "a:2", value: 2 });
    await tool.query({ operation: "setState", channel: "main", key: "b:1", value: 3 });
    await until(() => changes.length === 3);
    assert.equal(changes[0].updatedBy, "usr_ops");
    const cleared = await tool.query({ operation: "clearState", channel: "main", prefix: "a:" });
    assert.equal(cleared.count, 2);
    await until(() => board.getState("a:1") === undefined && board.getState("a:2") === undefined);
    assert.equal(board.getState("b:1"), 3);
    await tool.query({ operation: "deleteState", channel: "main", key: "b:1" });
    await until(() => board.getState("b:1") === undefined);
    const sent = await tool.query({ operation: "broadcast", channel: "main", data: "hi" });
    assert.equal(sent.recipients, 1);
    const dm = await tool.query({ operation: "send", to: { peerId: "usr_p" }, data: "dm" });
    assert.equal(dm.recipients, 1);
    await until(() => broadcasts.length === 1 && direct.length === 1);
    assert.equal(broadcasts[0].from.inspector, true);
    assert.equal(broadcasts[0].from.peerId, "usr_ops");
    assert.equal(broadcasts[0].channel, "main");
    await assert.rejects(tool.query({ operation: "send", to: { peerId: "x" }, data: 1 }), {
        code: "PEER_NOT_FOUND",
    });
    await sleep(20);
    assert.equal(outside.length, 0);
});

test("createChannel and deleteChannel through query", async () => {
    const { port } = await startServer();
    const peer = await connectClient(port, "rw");
    const tool = await connectClient(port, "rw", { mode: "inspect", peer: { id: "usr_ops" } });
    const created = collect(peer, "channel:created");
    const result = await tool.query({ operation: "createChannel", channel: "made" });
    assert.equal(result.created, true);
    assert.equal(result.channel.createdBy, "usr_ops");
    await until(() => created.length === 1);
    const board = await peer.subscribe("made");
    const closed = new Promise((r) => board.once("closed", r));
    assert.deepEqual(await tool.query({ operation: "deleteChannel", channel: "made" }), {
        deleted: true,
    });
    assert.deepEqual(await closed, { reason: "channel_deleted", by: "usr_ops" });
});

test("server-assigned versions win over older client writes", async () => {
    const { port } = await startServer();
    const a = await join(await connectClient(port, "rw"));
    const tool = await connectClient(port, "rw", { mode: "inspect" });
    await a.setState("k", "client");
    await tool.query({ operation: "setState", channel: "main", key: "k", value: "query" });
    await until(() => a.getState("k") === "query");
    await a.setState("k", "client again");
    const entry = (await tool.query({ operation: "getState", channel: "main", key: "k" })).entries
        .k;
    assert.equal(entry.value, "client again");
});

test("schema counts closes by reason and lists the recent ones", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" }, reconnect: false });
    const tool = await connectClient(port, "ro", { mode: "inspect" });
    await a.close();
    b.conn!.destroy("connection_lost");
    await until(() => tool.getActivePeers().length === 0);
    const schema = await tool.getSchema();
    assert.equal(schema.stats.closeReasons.client_close, 1);
    assert.equal(schema.stats.closeReasons.connection_lost, 1);
    assert.deepEqual(
        schema.recentCloses.map((c: any) => [c.peerId, c.reason, c.mode]),
        [
            ["usr_b", "connection_lost", "peer"],
            ["usr_a", "client_close", "peer"],
        ]
    );
    assert.ok(schema.recentCloses.every((c: any) => c.at > 0 && c.deviceId && c.sessionId));
});

test("getState and schema report channel stats and meta", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const room = await a.subscribe("room", { create: { meta: { title: "R" } } });
    await room.setState("k", 1);
    const result = await a.query({ operation: "getState", channel: "room" });
    assert.equal(result.stats.keyCount, 1);
    assert.equal(result.stats.lastWriteBy, "usr_a");
    assert.equal(result.stats.subscriberCount, 1);
    const detail = await a.getSchema("room");
    assert.deepEqual(detail.meta, { title: "R" });
    assert.equal(detail.stats.lastWriteBy, "usr_a");
    const overview = await a.getSchema();
    assert.deepEqual(overview.channels[0].meta, { title: "R" });
});
