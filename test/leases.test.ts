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

test("one holder at a time; the queue takes over on release, unsubscribe and disconnect", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" } });
    const c = await connectClient(port, "rw", { peer: { id: "usr_c" }, reconnect: false });
    const atA = await join(a);
    const atB = await join(b);
    const atC = await join(c);
    const seenByA = collect(atA, "lease:changed");
    assert.equal(await atA.lease("job"), true);
    assert.equal(await atB.lease("job"), false);
    assert.equal(await atC.lease("job"), false);
    await until(() => atB.getLease("job").holder?.sessionId === a.sessionId);
    assert.equal(atA.getLease("job").mine, true);
    assert.equal(atB.getLease("job").mine, false);
    const toB = waitForEvent(atB, "lease:changed", (e) => e.mine);
    await atA.releaseLease("job");
    assert.equal((await toB).name, "job");
    await until(() => atA.getLease("job").holder?.sessionId === b.sessionId);
    const toC = waitForEvent(atC, "lease:changed", (e) => e.mine);
    await atB.unsubscribe();
    await toC;
    const none = waitForEvent(atA, "lease:changed", (e) => e.holder === null);
    c.conn!.destroy("connection_lost");
    await none;
    assert.deepEqual(
        seenByA.map((e) => e.holder?.peerId ?? null),
        ["usr_a", "usr_b", "usr_c", null]
    );
    assert.equal(await atA.lease("job"), true, "free again");
});

test("a lease nobody renews expires; the Client renews the ones it holds", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    const atA = await join(a);
    const raw = await rawSocket(port);
    const c = await raw.auth("rw");
    await raw.subscribe("main");
    raw.send({ type: "lease", reqId: 2, channel: "main", name: "raw", ttlMs: 10 }); // clamped to 1 s
    const ack = await raw.next("ack");
    assert.equal(ack.granted, true);
    await until(() => atA.getLease("raw").holder?.sessionId === c.sessionId);
    const expired = waitForEvent(atA, "lease:changed", (e) => e.name === "raw" && !e.holder, 3000);
    const start = Date.now();
    await expired;
    assert.ok(Date.now() - start >= 800, "kept for the clamped minimum");
    assert.equal(await atA.lease("held", { ttlMs: 1000 }), true);
    const lost = collect(atA, "lease:changed");
    await sleep(2500);
    assert.equal(lost.length, 0, "renewed by the Client");
    assert.equal(atA.getLease("held").mine, true);
});

test("late subscribers learn holders; inspectors and non-subscribers are refused", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    const atA = await join(a);
    await atA.lease("thumbs");
    const late = await join(await connectClient(port));
    assert.equal(late.getLease("thumbs").holder?.sessionId, a.sessionId);
    assert.deepEqual(late.getLease("other"), { holder: null, mine: false });
    const tool = await connectClient(port, "admin", { mode: "inspect" });
    const watched = await tool.subscribe("main");
    await assert.rejects(watched.lease("x"), { code: "FORBIDDEN" });
    const raw = await rawSocket(port);
    await raw.auth("rw");
    raw.send({ type: "lease", reqId: 2, channel: "main", name: "x", ttlMs: 1000 });
    assert.equal((await raw.next("error")).code, "NOT_SUBSCRIBED");
    await raw.subscribe("main");
    raw.send({ type: "lease", reqId: 3, channel: "main", name: "", ttlMs: 1000 });
    assert.equal((await raw.next("error")).code, "INVALID_ARGUMENT");
    raw.send({ type: "lease:release", reqId: 4, channel: "main", name: "thumbs" });
    assert.equal((await raw.next("ack")).released, false, "not the holder");
});

test("after a reconnect the Client asks again for the leases it held", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    const atA = await join(a);
    const watcher = await join(await connectClient(port));
    await atA.lease("job");
    const back = waitForEvent(a, "reconnected");
    a.conn!.destroy("connection_lost");
    await back;
    await until(
        () => atA.getLease("job").mine && atA.getLease("job").holder?.sessionId === a.sessionId
    );
    await until(() => watcher.getLease("job").holder?.sessionId === a.sessionId);
});
