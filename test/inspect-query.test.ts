import test from "node:test";
import assert from "node:assert/strict";
import { collect, connectClient, startServer, until } from "./helpers.ts";

test("schema reports peers, devices, state keys, limits and counters", async () => {
    const { port } = await startServer({ maxConnections: 50 });
    const a = await connectClient(port, "rw", { peer: { id: "usr_a", name: "A" } });
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" } });
    await a.setState("shape:1", { x: 1 });
    await a.setState("label", "hi");
    await a.deleteState("label");
    await until(() => b.getState("shape:1") !== undefined);
    await a.broadcast("x");
    const tool = await connectClient(port, "ro", { mode: "inspect" });
    const schema = await tool.getSchema();
    assert.equal(schema.peerCount, 2);
    assert.equal(schema.userCount, 2);
    assert.equal(schema.inspectorCount, 1);
    assert.equal(schema.connections, 3);
    assert.equal(schema.maxConnections, 50);
    assert.ok(schema.storageBytes > 0 && schema.maxStateBytes > 0);
    assert.equal(schema.stateKeyCount, 1);
    assert.deepEqual(
        schema.stateKeys.map((k: any) => [k.key, k.type, k.updatedBy]),
        [["shape:1", "object", "usr_a"]]
    );
    const peerA = schema.peers.find((p: any) => p.peerId === "usr_a");
    assert.equal(peerA.name, "A");
    assert.equal(typeof peerA.socketWritableBytes, "number");
    assert.ok(schema.stats.relayedFrames >= 1);
});

test("query reads for every role, paging and prefix", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    for (let i = 0; i < 5; i++) await a.setState(`item:${i}`, i);
    await a.setState("other", 1);
    const tool = await connectClient(port, "ro", { mode: "inspect" });
    assert.deepEqual(
        (await tool.query({ operation: "peers" })).map((p: any) => p.peerId),
        ["usr_a"]
    );
    assert.equal((await tool.query({ operation: "peers", peerId: "usr_x" })).length, 0);
    const page1 = await tool.query({ operation: "getState", prefix: "item:", limit: 2 });
    assert.deepEqual(Object.keys(page1.entries), ["item:0", "item:1"]);
    const page2 = await tool.query({
        operation: "getState",
        prefix: "item:",
        limit: 2,
        after: page1.next,
    });
    assert.deepEqual(Object.keys(page2.entries), ["item:2", "item:3"]);
    const last = await tool.query({ operation: "getState", prefix: "item:", after: page2.next });
    assert.deepEqual(Object.keys(last.entries), ["item:4"]);
    assert.equal(last.next, undefined);
    assert.deepEqual(
        Object.keys((await tool.query({ operation: "getState", key: "other" })).entries),
        ["other"]
    );
    await assert.rejects(tool.query({ operation: "deleteState", key: "other" }), {
        code: "READ_ONLY",
    });
    await assert.rejects(tool.query({ operation: "nope" }), { code: "INVALID_ARGUMENT" });
});

test("query writes are ordinary events for peers, attributed to the inspector", async () => {
    const { port } = await startServer();
    const peer = await connectClient(port, "rw", { peer: { id: "usr_p" } });
    const tool = await connectClient(port, "admin", { mode: "inspect", peer: { id: "usr_ops" } });
    const changes = collect(peer, "state:changed");
    const messages = collect(peer, "message");
    const set = await tool.query({ operation: "setState", key: "a:1", value: 1 });
    assert.equal(set.applied, true);
    await tool.query({ operation: "setState", key: "a:2", value: 2 });
    await tool.query({ operation: "setState", key: "b:1", value: 3 });
    await until(() => changes.length === 3);
    assert.equal(changes[0].updatedBy, "usr_ops");
    assert.equal((await tool.query({ operation: "clearState", prefix: "a:" })).count, 2);
    await until(() => peer.getState("a:1") === undefined && peer.getState("a:2") === undefined);
    assert.equal(peer.getState("b:1"), 3);
    await tool.query({ operation: "deleteState", key: "b:1" });
    await until(() => peer.getState("b:1") === undefined);
    assert.equal((await tool.query({ operation: "broadcast", data: "hi" })).recipients, 1);
    assert.equal(
        (await tool.query({ operation: "send", to: { peerId: "usr_p" }, data: "dm" })).recipients,
        1
    );
    await until(() => messages.length === 2);
    assert.equal(messages[0].from.inspector, true);
    assert.equal(messages[0].from.peerId, "usr_ops");
    await assert.rejects(tool.query({ operation: "send", to: { peerId: "x" }, data: 1 }), {
        code: "PEER_NOT_FOUND",
    });
});

test("server-assigned versions win over older client writes", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw");
    const tool = await connectClient(port, "rw", { mode: "inspect" });
    await a.setState("k", "client");
    await tool.query({ operation: "setState", key: "k", value: "query" });
    await until(() => a.getState("k") === "query");
    await a.setState("k", "client again");
    const entry = (await tool.query({ operation: "getState", key: "k" })).entries.k;
    assert.equal(entry.value, "client again");
});
