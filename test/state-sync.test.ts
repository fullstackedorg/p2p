import test from "node:test";
import assert from "node:assert/strict";
import { collect, connectClient, rawSocket, startServer, until } from "./helpers.ts";

test("set, delete and clear propagate; local writes fire state:changed first", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    const b = await connectClient(port);
    const atA = collect(a, "state:changed");
    const atB = collect(b, "state:changed");
    const result = await a.setState("shape:1", { x: 1 });
    assert.deepEqual(result, { applied: true });
    assert.equal(atA[0].local, true);
    await until(() => atB.length === 1);
    assert.deepEqual(b.getState("shape:1"), { x: 1 });
    assert.equal(atB[0].local, false);
    assert.equal(atB[0].transport, "socket");
    await a.deleteState("shape:1");
    await until(() => b.getState("shape:1") === undefined);
    assert.equal(atB[1].deleted, true);
    await a.setState("x", 1);
    await a.setState("y", 2);
    const cleared = collect(b, "state:cleared");
    assert.equal((await a.clearState()).count, 2);
    await until(() => cleared.length === 1);
    assert.deepEqual(b.getState(), {});
    assert.deepEqual(a.getState(), {});
});

test("late joiners get the state after every writer left", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    await a.setState("doc", "v1");
    await a.setState("other", [1, 2]);
    await a.close();
    const late = await connectClient(port);
    assert.deepEqual(late.getState(), { doc: "v1", other: [1, 2] });
    assert.equal(late.getState("doc"), "v1");
});

test("a stale write is acked applied:false with the winner", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    await a.setState("k", "first");
    await a.setState("k", "new"); // clock 2: beats any [1, sessionId]
    const raw = await rawSocket(port);
    const c = await raw.auth("rw");
    raw.send({
        type: "state:set",
        reqId: 2,
        key: "k",
        value: "old",
        version: [1, c.sessionId],
        deliveredTo: [],
    });
    const ack = await raw.next("ack");
    assert.equal(ack.applied, false);
    assert.equal(ack.entry.value, "new");
});

test("a client whose write lost adopts the winner", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    const raw = await rawSocket(port);
    const c = await raw.auth("rw");
    // a far-ahead clock from another writer wins over a's next write
    raw.send({
        type: "state:set",
        reqId: 2,
        key: "k",
        value: "winner",
        version: [1000, c.sessionId],
        deliveredTo: [],
    });
    await raw.next("ack");
    await until(() => a.getState("k") === "winner");
    a.state.replica.clock = 0; // simulate a's clock lagging behind
    a.state.replica.entries.delete("k");
    const result = await a.setState("k", "loser");
    assert.deepEqual(result, { applied: false });
    assert.equal(a.getState("k"), "winner");
});

test("concurrent writes from many clients converge everywhere", async () => {
    const { port } = await startServer();
    const clients = await Promise.all([0, 1, 2, 3].map(() => connectClient(port)));
    await Promise.all(clients.map((c, i) => c.setState("shared", `from ${i}`)));
    await Promise.all(clients.map((c, i) => c.setState(`own:${i}`, i)));
    await until(() => {
        const values = clients.map((c) => JSON.stringify(Object.entries(c.getState()).sort()));
        return (
            values.every((v) => v === values[0]) && Object.keys(clients[0].getState()).length === 5
        );
    });
});

test("clear keeps entries written after it", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    const raw = await rawSocket(port);
    const c = await raw.auth("rw");
    raw.send({
        type: "state:set",
        reqId: 2,
        key: "future",
        value: 1,
        version: [50, c.sessionId],
        deliveredTo: [],
    });
    await raw.next("ack");
    await a.setState("past", 1);
    await until(() => a.getState("future") === 1);
    a.state.replica.clock = 10;
    await a.clearState();
    await until(() => a.getState("past") === undefined);
    assert.equal(a.getState("future"), 1);
});

test("invalid writes: key rules, foreign version, clock jumps", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    await assert.rejects(a.setState("", 1), { code: "INVALID_ARGUMENT" });
    await assert.rejects(a.setState("k".repeat(257), 1), { code: "INVALID_ARGUMENT" });
    const raw = await rawSocket(port);
    const c = await raw.auth("rw");
    const bad = [
        { version: [1, "someone-else"] },
        { version: [2 ** 33, c.sessionId] },
        { version: [0, c.sessionId] },
    ];
    for (const [i, extra] of bad.entries()) {
        raw.send({
            type: "state:set",
            reqId: 10 + i,
            key: "k",
            value: 1,
            deliveredTo: [],
            ...extra,
        });
        assert.equal((await raw.next("error")).code, "INVALID_ARGUMENT");
    }
});

test("STATE_TOO_LARGE rejects and restores the local replica", async () => {
    const { port } = await startServer({ maxStateBytes: 2048 });
    const a = await connectClient(port);
    await a.setState("small", "x");
    await assert.rejects(a.setState("big", "y".repeat(3000)), { code: "STATE_TOO_LARGE" });
    assert.equal(a.getState("big"), undefined);
    await a.deleteState("small"); // deletes always fit
});

test("reconnect rebuilds the replica and reports differences", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    const b = await connectClient(port, "rw", { reconnect: false });
    await a.setState("keep", 1);
    await a.setState("gone", 1);
    await until(() => b.getState("gone") === 1);
    await until(() => a.getActivePeers().length === 1);
    a.conn!.destroy("connection_lost");
    await b.setState("added", 2);
    await b.deleteState("gone");
    const changes = collect(a, "state:changed");
    const reconnected = new Promise((r) => a.once("reconnected", r));
    await reconnected;
    await until(() => a.getState("added") === 2);
    assert.equal(a.getState("gone"), undefined);
    assert.equal(a.getState("keep"), 1);
    const keys = changes.map((c) => `${c.key}:${c.deleted}`).sort();
    assert.deepEqual(keys, ["added:false", "gone:true"]);
});
