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

test("live values show at once, are not stored, and end with the stored write", async () => {
    const { port } = await startServer();
    const a = await join(await connectClient(port));
    const b = await join(await connectClient(port));
    await a.setState("item", { x: 0 });
    await until(() => b.getState("item") !== undefined);
    const atA = collect(a, "state:changed");
    const atB = collect(b, "state:changed");
    for (let x = 1; x <= 3; x++) await a.setState("item", { x }, { ephemeral: true });
    await until(() => (b.getState("item") as any).x === 3);
    assert.ok(atB.every((c) => c.live === true && c.created === false));
    assert.equal(atA.at(-1).live, true);
    assert.equal(atA.at(-1).local, true);
    assert.deepEqual(a.getState("item"), { x: 3 });
    const late = await join(await connectClient(port));
    assert.deepEqual(late.getState("item"), { x: 0 }, "never stored");
    await a.setState("item", { x: 4 });
    await until(() => atB.at(-1)?.live === false);
    assert.deepEqual(b.getState("item"), { x: 4 });
});

test("a live value ends when its writer leaves, or after the expiry", async () => {
    const { port } = await startServer();
    const timing = { liveTtlMs: 150 };
    const aClient = await connectClient(port, "rw", { timing });
    const a = await join(aClient);
    const b = await join(await connectClient(port, "rw", { timing }));
    await a.setState("stored", 1);
    await a.setState("stored", 2, { ephemeral: true });
    await until(() => b.getState("stored") === 2);
    const reverted = waitForEvent(b, "state:changed", (c) => c.key === "stored" && !c.live);
    await a.unsubscribe();
    assert.equal((await reverted).value, 1);
    assert.equal(b.getState("stored"), 1);
    const c = await join(await connectClient(port, "rw", { timing }));
    await c.setState("fresh", "moving", { ephemeral: true });
    await until(() => b.getState("fresh") === "moving");
    const gone = waitForEvent(b, "state:changed", (x) => x.key === "fresh" && !x.live);
    await gone;
    assert.equal(b.getState("fresh"), undefined, "expired without a refresh");
});

test("a stale live value cannot hide the stored write that ended it", async () => {
    const { port } = await startServer();
    const a = await join(await connectClient(port));
    const raw = await rawSocket(port);
    const c = await raw.auth("rw");
    const ack = await raw.subscribe("main");
    raw.send({
        type: "state:set",
        reqId: 2,
        channel: "main",
        key: "k",
        value: "stored",
        version: [ack.clock + 5, c.sessionId],
    });
    await raw.next("ack");
    await until(() => a.getState("k") === "stored");
    const live = collect(a, "state:changed");
    raw.send({
        type: "state:live",
        channel: "main",
        key: "k",
        value: "stale",
        version: [ack.clock + 4, c.sessionId],
    });
    raw.send({ type: "ping" });
    await raw.next("pong");
    await sleep(30);
    assert.equal(live.length, 0);
    assert.equal(a.getState("k"), "stored");
});

test("created and tag on changes, entries and watches", async () => {
    const { port } = await startServer();
    const a = await join(await connectClient(port));
    const bClient = await connectClient(port);
    const b = await join(bClient);
    const monitor = await connectClient(port, "ro", { mode: "inspect" });
    const watch = await monitor.watch("");
    const activity = collect(watch, "activity");
    const changes = collect(b, "state:changed");
    await a.setState("n", 1, { tag: "add" });
    await a.setState("n", 2);
    await a.deleteState("n", { tag: "undo" });
    await a.setStates({ m: 1 }, { tag: "import" });
    await until(() => changes.length === 4 && activity.length === 4);
    assert.deepEqual(
        changes.map((c) => [c.created, c.deleted, c.tag]),
        [
            [true, false, "add"],
            [false, false, undefined],
            [false, true, "undo"],
            [true, false, "import"],
        ]
    );
    assert.deepEqual(
        activity.map((x: any) => [x.change.created, x.change.tag]),
        [
            [true, "add"],
            [false, undefined],
            [false, "undo"],
            [true, "import"],
        ]
    );
    const page = await bClient.peek("main", { keys: ["m"] });
    assert.equal(page.entries.m.tag, "import");
    const cleared = waitForEvent(b, "state:cleared");
    await a.clearState({ tag: "reset" });
    assert.equal((await cleared).tag, "reset");
    await assert.rejects(a.setState("x", 1, { tag: "t".repeat(129) }), {
        code: "INVALID_ARGUMENT",
    });
});

test("subscribe with state: false starts empty and fills from changes", async () => {
    const { port } = await startServer();
    const a = await join(await connectClient(port));
    await a.setStates({ old: 1, other: 2 });
    const c = await (await connectClient(port)).subscribe("main", { state: false });
    assert.deepEqual(c.getState(), {});
    await a.setState("new", 3);
    await until(() => c.getState("new") === 3);
    assert.deepEqual(c.getState(), { new: 3 });
    await c.setState("mine", 4); // writes work: the clock came with the ack
    await until(() => a.getState("mine") === 4);
});

test("pacing: throttled ephemeral presence, then one settled update", async () => {
    const { port } = await startServer();
    const a = await join(await connectClient(port));
    const b = await join(await connectClient(port));
    const updates = collect(b, "subscriber:updated");
    const pace = { merge: true, ephemeral: true, throttleMs: 50, settleMs: 120 } as const;
    for (let x = 1; x <= 40; x++) {
        a.updatePresence({ x }, pace);
        await sleep(5);
    }
    await sleep(400);
    assert.ok(updates.length < 15, `throttled (${updates.length} updates for 40 calls)`);
    assert.deepEqual(updates.at(-1).meta, { x: 40 });
    const late = await join(await connectClient(port));
    assert.equal(late.getSubscribers().find((s) => s.meta.x !== undefined)?.meta.x, 40);
});

test("pacing: broadcasts keep the latest data per stream and settle reliably", async () => {
    const { port } = await startServer();
    const a = await join(await connectClient(port));
    const b = await join(await connectClient(port));
    const got = collect(b, "message");
    const pace = { ephemeral: true, throttleMs: 40, settleMs: 100 } as const;
    for (let i = 1; i <= 20; i++) {
        a.broadcast({ s: "one", i }, { ...pace, stream: "one" });
        a.broadcast({ s: "two", i }, { ...pace, stream: "two" });
        await sleep(4);
    }
    await sleep(350);
    for (const s of ["one", "two"]) {
        const mine = got.filter((m) => (m.data as any).s === s);
        assert.ok(mine.length < 10, `${s} throttled`);
        assert.deepEqual(mine.at(-1)!.data, { s, i: 20 });
        assert.equal(mine.at(-1)!.ephemeral, false, "the settled one is reliable");
    }
    await assert.rejects(a.broadcast("x", { throttleMs: 10 }), { code: "INVALID_ARGUMENT" });
});

test("nothing is emitted by a channel once unsubscribe() is called", async () => {
    const { port } = await startServer();
    const aClient = await connectClient(port);
    const a = await join(aClient);
    const b = await join(await connectClient(port));
    const after: string[] = [];
    const errors = collect(aClient, "error");
    const pending = a.setState("k", 1);
    a.updatePresence({ x: 1 }, { ephemeral: true, throttleMs: 50, settleMs: 50 });
    a.updatePresence({ x: 2 }, { ephemeral: true, throttleMs: 50, settleMs: 50 });
    const left = a.unsubscribe();
    for (const e of ["state:changed", "subscriber:joined", "subscriber:updated", "message"])
        a.on(e as any, () => after.push(e));
    await pending.catch(() => {});
    await left;
    await b.setState("k", 2);
    await b.broadcast("hi");
    await sleep(200);
    assert.deepEqual(after, []);
    assert.deepEqual(errors, []);
});
