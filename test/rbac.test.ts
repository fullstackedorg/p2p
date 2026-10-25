import test from "node:test";
import assert from "node:assert/strict";
import { READ_ONLY_MESSAGE } from "../src/protocol/errors.ts";
import { collect, connectClient, rawSocket, sleep, startServer, until } from "./helpers.ts";

test("spectators: every publishing call rejects locally with READ_ONLY", async () => {
    const { port } = await startServer();
    const rw = await connectClient(port, "rw", { peer: { id: "usr_rw" } });
    const ro = await connectClient(port, "ro", { peer: { id: "usr_ro" } });
    await until(() => ro.getActivePeers().length === 1);
    const calls: Array<() => Promise<unknown>> = [
        () => ro.broadcast(1),
        () => ro.send("usr_rw", 1),
        () => ro.request("usr_rw", 1),
        () => ro.setState("k", 1),
        () => ro.deleteState("k"),
        () => ro.clearState(),
        () => ro.updatePresence({ x: 1 }),
        () => ro.query({ operation: "setState", key: "k", value: 1 }),
    ];
    for (const call of calls) {
        await assert.rejects(call(), (err: any) => {
            return err.code === "READ_ONLY" && err.message === READ_ONLY_MESSAGE;
        });
    }
    assert.equal(rw.getState("k"), undefined);
});

test("spectators: the Server enforces READ_ONLY for frames a modified client sends", async () => {
    const { port } = await startServer();
    await connectClient(port, "rw", { peer: { id: "usr_rw" } });
    const raw = await rawSocket(port);
    const c = await raw.auth("ro");
    const id = c.sessionId;
    const frames = [
        { type: "broadcast", reqId: 2, msgId: `${id}:1`, data: 1, deliveredTo: [] },
        { type: "send", reqId: 3, msgId: `${id}:2`, to: { peerId: "usr_rw" }, data: 1 },
        { type: "state:set", reqId: 4, key: "k", value: 1, version: [1, id], deliveredTo: [] },
        { type: "presence", reqId: 5, meta: {} },
        { type: "media:chunk", reqId: 6, streamId: "s", data: "", deliveredTo: [] },
    ];
    for (const f of frames) {
        raw.send(f);
        const err = await raw.next("error");
        assert.equal(err.code, "READ_ONLY");
        assert.equal(err.reqId, f.reqId);
    }
});

test("spectators receive broadcasts, state and presence, and reply to requests they get", async () => {
    const { port } = await startServer();
    const rw = await connectClient(port, "rw", { peer: { id: "usr_rw" } });
    const ro = await connectClient(port, "ro", { peer: { id: "usr_ro" } });
    await until(() => rw.getActivePeers().length === 1 && ro.getActivePeers().length === 1);
    const messages = collect(ro, "message");
    await rw.broadcast("hello");
    await rw.setState("k", 1);
    await until(() => messages.length === 1 && ro.getState("k") === 1);
    await assert.rejects(rw.request("usr_ro", 1), { code: "TARGET_READ_ONLY" });
    await rw.send("usr_ro", "direct");
    await until(() => messages.length === 2);
});

test("a spectator can reply only to a request it received", async () => {
    const { port } = await startServer();
    const raw = await rawSocket(port);
    const c = await raw.auth("ro");
    const rw = await connectClient(port, "rw");
    raw.send({
        type: "reply",
        reqId: 7,
        msgId: `${c.sessionId}:1`,
        to: { sessionId: rw.sessionId },
        replyTo: "nope",
        data: 1,
    });
    assert.equal((await raw.next("error")).code, "INVALID_ARGUMENT");
});

test("admin has rw permissions", async () => {
    const { port } = await startServer();
    const admin = await connectClient(port, "admin");
    const rw = await connectClient(port, "rw");
    await until(() => admin.getActivePeers().length === 1);
    await admin.setState("k", "v");
    await admin.broadcast(1);
    await until(() => rw.getState("k") === "v");
    assert.equal(admin.role, "admin");
});

test("inspector sessions of every role are invisible and get FORBIDDEN for peer frames", async () => {
    const { port } = await startServer();
    const peer = await connectClient(port, "rw");
    const joined = collect(peer, "peer:joined");
    for (const role of ["admin", "rw", "ro"] as const) {
        const tool = await connectClient(port, role, { mode: "inspect" });
        assert.deepEqual(tool.getActivePeers(), []);
        assert.deepEqual(tool.getState(), {});
        const raw = await rawSocket(port);
        const c = await raw.auth(role, { mode: "inspect" });
        raw.send({ type: "broadcast", reqId: 2, msgId: `${c.sessionId}:1`, data: 1 });
        assert.equal((await raw.next("error")).code, "FORBIDDEN");
    }
    await peer.broadcast("nobody listening");
    await sleep(30);
    assert.equal(joined.length, 0);
    assert.equal(peer.getActivePeers().length, 0);
});
