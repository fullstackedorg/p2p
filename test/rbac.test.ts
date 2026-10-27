import test from "node:test";
import assert from "node:assert/strict";
import { collect, connectClient, join, rawSocket, sleep, startServer, until } from "./helpers.ts";

test("ro: creating, changing or deleting a channel rejects locally with FORBIDDEN", async () => {
    const { port } = await startServer();
    const rw = await connectClient(port, "rw");
    const ro = await connectClient(port, "ro");
    await join(rw, "exists");
    await until(() => ro.getChannels().length === 1);
    const calls: Array<() => Promise<unknown>> = [
        () => ro.subscribe("new", { create: true }),
        () => ro.createChannel("new"),
        () => ro.updateChannelMeta("exists", { title: "x" }),
        () => ro.deleteChannel("exists"),
    ];
    for (const call of calls) await assert.rejects(call(), { code: "FORBIDDEN" });
    assert.deepEqual(
        rw.getChannels().map((c) => c.id),
        ["exists"]
    );
});

test("ro: the Server enforces FORBIDDEN for channel creation and deletion", async () => {
    const { port } = await startServer();
    const rw = await connectClient(port, "rw");
    await join(rw, "exists");
    const raw = await rawSocket(port);
    await raw.auth("ro");
    const frames = [
        { type: "subscribe", reqId: 2, channel: "new", create: true },
        { type: "query", reqId: 3, operation: "createChannel", channel: "new" },
        { type: "query", reqId: 4, operation: "deleteChannel", channel: "exists" },
        { type: "query", reqId: 6, operation: "updateChannel", channel: "exists", meta: {} },
    ];
    for (const f of frames) {
        raw.send(f);
        const err = await raw.next("error");
        assert.equal(err.code, "FORBIDDEN");
        assert.equal(err.reqId, f.reqId);
    }
    raw.send({ type: "subscribe", reqId: 5, channel: "new" });
    assert.equal((await raw.next("error")).code, "CHANNEL_NOT_FOUND");
});

test("ro fully interacts inside a channel: broadcast, state, presence, requests", async () => {
    const { port } = await startServer();
    const rw = await connectClient(port, "rw", { peer: { id: "usr_rw" } });
    const ro = await connectClient(port, "ro", { peer: { id: "usr_ro" } });
    const atRw = await join(rw);
    const atRo = await join(ro);
    const messages = collect(atRw, "message");
    await atRo.broadcast("from ro");
    await atRo.setState("k", "ro value");
    await atRo.updatePresence({ view: 1 });
    await atRo.deleteState("k");
    await atRo.setState("j", 1);
    await atRo.clearState();
    await until(() => messages.length === 1 && atRw.getSubscribers()[0]?.meta.view === 1);
    await until(() => atRw.getState("j") === undefined);
    ro.on("message", (e) => e.reply?.("ro answers"));
    assert.equal(await rw.request("usr_ro", "q"), "ro answers");
    await ro.send("usr_rw", "direct");
});

test("admin has rw permissions", async () => {
    const { port } = await startServer();
    const admin = await connectClient(port, "admin");
    const rw = await connectClient(port, "rw");
    const atAdmin = await join(admin);
    const atRw = await join(rw);
    await atAdmin.setState("k", "v");
    await until(() => atRw.getState("k") === "v");
    await admin.deleteChannel("main");
    assert.equal(admin.role, "admin");
});

test("inspector sessions of every role are invisible and get FORBIDDEN for publishing", async () => {
    const { port } = await startServer();
    const peer = await connectClient(port, "rw");
    const board = await join(peer);
    const joined = collect(peer, "peer:joined");
    for (const role of ["admin", "rw", "ro"] as const) {
        const tool = await connectClient(port, role, { mode: "inspect" });
        assert.deepEqual(
            tool.getActivePeers().map((p) => p.sessionId),
            [peer.sessionId],
            "inspectors see presence"
        );
        assert.deepEqual(
            tool.getChannels().map((c) => c.id),
            ["main"]
        );
        const atTool = await tool.subscribe("main");
        await assert.rejects(atTool.broadcast("x"), { code: "FORBIDDEN" });
        await assert.rejects(atTool.setState("k", 1), { code: "FORBIDDEN" });
        await assert.rejects(atTool.updatePresence({}), { code: "FORBIDDEN" });
        const raw = await rawSocket(port);
        const c = await raw.auth(role, { mode: "inspect" });
        await raw.subscribe("main", { create: false });
        for (const frame of [
            { type: "presence", reqId: 2, meta: {} },
            {
                type: "send",
                reqId: 3,
                msgId: `${c.sessionId}:1`,
                to: { sessionId: peer.sessionId },
            },
            { type: "broadcast", reqId: 4, channel: "main", msgId: `${c.sessionId}:2`, data: 1 },
            {
                type: "state:set",
                reqId: 5,
                channel: "main",
                key: "k",
                value: 1,
                version: [1, c.sessionId],
            },
            { type: "channel:presence", reqId: 6, channel: "main", meta: {} },
        ]) {
            raw.send(frame);
            assert.equal((await raw.next("error")).code, "FORBIDDEN");
        }
    }
    await board.broadcast("only inspectors listening");
    await sleep(30);
    assert.equal(joined.length, 0);
    assert.equal(peer.getActivePeers().length, 0);
    assert.deepEqual(board.getSubscribers(), []);
});

test("a channel is deleted by its creator (any device) or an admin only", async () => {
    const { port } = await startServer();
    const alice = await connectClient(port, "rw", { peer: { id: "usr_alice" } });
    const alicePhone = await connectClient(port, "rw", { peer: { id: "usr_alice" } });
    const bob = await connectClient(port, "rw", { peer: { id: "usr_bob" } });
    const admin = await connectClient(port, "admin", { peer: { id: "usr_admin" } });
    await alice.createChannel("a1");
    await alice.createChannel("a2");
    await until(() => bob.getChannels().length === 2);
    await assert.rejects(bob.deleteChannel("a1"), { code: "FORBIDDEN" }); // local check
    const raw = await rawSocket(port);
    await raw.auth("rw", { peer: { id: "usr_bob" } });
    raw.send({ type: "query", reqId: 2, operation: "deleteChannel", channel: "a1" });
    assert.equal((await raw.next("error")).code, "FORBIDDEN");
    await alicePhone.deleteChannel("a1");
    await admin.deleteChannel("a2");
    await until(() => bob.getChannels().length === 0);
    const tool = await connectClient(port, "rw", { mode: "inspect", peer: { id: "usr_alice" } });
    await bob.createChannel("b1");
    await assert.rejects(tool.query({ operation: "deleteChannel", channel: "b1" }), {
        code: "FORBIDDEN",
    });
});

test("a creator whose role became ro can no longer delete; legacy channels are admin-only", async () => {
    const { port, server } = await startServer();
    const rw = await connectClient(port, "rw", { peer: { id: "usr_x" } });
    await rw.createChannel("mine");
    const ro = await connectClient(port, "ro", { peer: { id: "usr_x" } });
    await assert.rejects(ro.deleteChannel("mine"), { code: "FORBIDDEN" });
    server.store.create({ id: "legacy", createdAt: 0, createdBy: "", meta: {} });
    const raw = await rawSocket(port);
    await raw.auth("rw", { peer: { id: "" } });
    raw.send({ type: "query", reqId: 2, operation: "deleteChannel", channel: "legacy" });
    assert.equal((await raw.next("error")).code, "FORBIDDEN");
});
