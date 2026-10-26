import test from "node:test";
import assert from "node:assert/strict";
import { collect, connectClient, join, rawSocket, sleep, startServer, until } from "./helpers.ts";

test("ro: creating or deleting a channel rejects locally with FORBIDDEN", async () => {
    const { port } = await startServer();
    const rw = await connectClient(port, "rw");
    const ro = await connectClient(port, "ro");
    await join(rw, "exists");
    await until(() => ro.getChannels().length === 1);
    const calls: Array<() => Promise<unknown>> = [
        () => ro.subscribe("new", { create: true }),
        () => ro.createChannel("new"),
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

test("inspector sessions of every role are invisible and get FORBIDDEN for peer frames", async () => {
    const { port } = await startServer();
    const peer = await connectClient(port, "rw");
    const board = await join(peer);
    const joined = collect(peer, "peer:joined");
    for (const role of ["admin", "rw", "ro"] as const) {
        const tool = await connectClient(port, role, { mode: "inspect" });
        assert.deepEqual(tool.getActivePeers(), []);
        assert.deepEqual(tool.getChannels(), []);
        await assert.rejects(tool.subscribe("main"), { code: "FORBIDDEN" });
        const raw = await rawSocket(port);
        const c = await raw.auth(role, { mode: "inspect" });
        for (const frame of [
            { type: "presence", reqId: 2, meta: {} },
            {
                type: "send",
                reqId: 3,
                msgId: `${c.sessionId}:1`,
                to: { sessionId: peer.sessionId },
            },
        ]) {
            raw.send(frame);
            assert.equal((await raw.next("error")).code, "FORBIDDEN");
        }
    }
    await board.broadcast("nobody listening");
    await sleep(30);
    assert.equal(joined.length, 0);
    assert.equal(peer.getActivePeers().length, 0);
});
