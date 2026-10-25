import test from "node:test";
import assert from "node:assert/strict";
import { installFakeRTC, liveConnections } from "./fake-rtc.ts";
import {
    collect,
    connectClient,
    rawSocket,
    sleep,
    startServer,
    until,
    waitForEvent,
} from "./helpers.ts";

const knobs = installFakeRTC();
const timing = { openTimeoutMs: 150, retryDelayMs: 150 };

async function linkedPair(port: number) {
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" }, timing });
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" }, timing });
    await until(
        () => a.getTransport(b.sessionId) === "webrtc" && b.getTransport(a.sessionId) === "webrtc"
    );
    return { a, b };
}

test("two WebRTC-capable peers open a link and report it", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { timing });
    const changed = waitForEvent(a, "transport:changed");
    const b = await connectClient(port, "rw", { timing });
    assert.equal(a.capabilities.webrtc, true);
    const event = await changed;
    assert.equal(event.transport, "webrtc");
    assert.equal(event.peer.sessionId, b.sessionId);
    const tool = await connectClient(port, "admin", { mode: "inspect" });
    await until(() => tool.getActivePeers().length === 0);
    const schema = await tool.getSchema();
    const peerA = schema.peers.find((p: any) => p.sessionId === a.sessionId);
    await until(() => true);
    assert.equal(peerA.links[b.sessionId], "webrtc");
});

test("frames between linked peers bypass the Server; others get deliveredTo relays", async () => {
    const { port, server } = await startServer();
    const { a, b } = await linkedPair(port);
    const atB = collect(b, "message");
    const before = server.room.stats.relayedFrames;
    await a.broadcast("linked only");
    await a.send("usr_b", "direct");
    await until(() => atB.length === 2);
    assert.deepEqual(
        atB.map((m) => m.transport),
        ["webrtc", "webrtc"]
    );
    assert.equal(server.room.stats.relayedFrames, before);
    const c = await connectClient(port, "rw", { webrtc: false, peer: { id: "usr_c" } });
    await until(() => a.getActivePeers().length === 2);
    const atC = collect(c, "message");
    const skipped = server.room.stats.skippedByDeliveredTo;
    await a.broadcast("mixed");
    await until(() => atB.length === 3 && atC.length === 1);
    await sleep(30);
    assert.equal(atB.length, 3, "b got it exactly once");
    assert.equal(atB[2].transport, "webrtc");
    assert.equal(atC[0].transport, "socket");
    assert.equal(server.room.stats.skippedByDeliveredTo, skipped + 1);
    assert.equal(c.getTransport(a.sessionId), "socket");
});

test("state writes travel over links and still reach the Server", async () => {
    const { port, server } = await startServer();
    const { a, b } = await linkedPair(port);
    const changes = collect(b, "state:changed");
    await a.setState("k", 1);
    await until(() => changes.length === 1);
    assert.equal(changes[0].transport, "webrtc");
    assert.equal(server.store.entries.get("k")?.value, 1);
    await a.deleteState("k");
    await until(() => b.getState("k") === undefined);
    await a.setState("x", 1);
    await until(() => b.getState("x") === 1);
    await a.clearState();
    await until(() => b.getState("x") === undefined);
    assert.equal(server.store.entries.get("x")?.deleted, true);
});

test("requests and replies over a link", async () => {
    const { port } = await startServer();
    const { a, b } = await linkedPair(port);
    b.on("message", (e) => e.reply?.({ via: e.transport }));
    assert.deepEqual(await a.request("usr_b", "hi"), { via: "webrtc" });
});

test("ephemeral frames use the unordered channel", async () => {
    const { port } = await startServer();
    const { a, b } = await linkedPair(port);
    const got = waitForEvent(b, "message");
    await a.broadcast({ x: 1 }, { ephemeral: true });
    assert.equal((await got).ephemeral, true);
    const pc = liveConnections().find((p) =>
        p.channels.some((c) => c.label === "p2p-ephemeral" && c.sent > 0)
    );
    assert.ok(pc, "something was sent on p2p-ephemeral");
});

test("frames larger than the link's max message size go over the socket", async () => {
    const { port } = await startServer();
    const { a, b } = await linkedPair(port);
    knobs.maxMessageSize = 64;
    const got = waitForEvent(b, "message");
    await a.send("usr_b", "x".repeat(200));
    assert.equal((await got).transport, "socket");
    knobs.maxMessageSize = 65_536;
});

test("duplicates across transports are delivered once", async () => {
    const { port } = await startServer();
    const { a, b } = await linkedPair(port);
    const atB = collect(b, "message");
    const frame = { type: "broadcast", msgId: `${a.sessionId}:999`, data: 1, ephemeral: false };
    b.onFrame({ ...frame, from: a.sessionId }, "socket");
    b.onFrame(frame, "webrtc", a.sessionId);
    assert.equal(atB.length, 1);
});

test("a link that never opens stays on the socket, then retries once", async () => {
    const { port } = await startServer();
    knobs.block = true;
    const a = await connectClient(port, "rw", { timing });
    const b = await connectClient(port, "rw", { timing });
    await sleep(timing.openTimeoutMs + 50);
    assert.equal(a.getTransport(b.sessionId), "socket");
    const atB = collect(b, "message");
    await a.broadcast("still works");
    await until(() => atB.length === 1);
    assert.equal(atB[0].transport, "socket");
    knobs.block = false;
    await until(() => a.getTransport(b.sessionId) === "webrtc", 2000, "retry");
});

test("a link that drops falls back to the socket and is re-established", async () => {
    const { port } = await startServer();
    const { a, b } = await linkedPair(port);
    const changes = collect(a, "transport:changed");
    liveConnections().forEach((pc) => pc.breakLink());
    await until(() => changes.some((c) => c.transport === "socket"));
    const atB = collect(b, "message");
    await a.broadcast("during fallback");
    await until(() => atB.length === 1);
    await until(() => a.getTransport(b.sessionId) === "webrtc", 2000, "re-link");
});

test("no links for socket-only, inspector or spectator pairs; spectator frames dropped on links", async () => {
    const { port } = await startServer();
    const ro1 = await connectClient(port, "ro", { timing });
    const ro2 = await connectClient(port, "ro", { timing });
    const socketOnly = await connectClient(port, "rw", { webrtc: false, timing });
    await connectClient(port, "admin", { mode: "inspect", timing });
    await sleep(80);
    assert.equal(ro1.getTransport(ro2.sessionId), "socket");
    assert.equal(ro1.getTransport(socketOnly.sessionId), "socket");
    const rw = await connectClient(port, "rw", { timing });
    await until(() => rw.getTransport(ro1.sessionId) === "webrtc", 2000, "rw-ro link");
    const errors = collect(rw, "error");
    const messages = collect(rw, "message");
    ro1.links!.send(
        rw.sessionId,
        { type: "broadcast", msgId: `${ro1.sessionId}:1`, data: "sneaky" },
        false
    );
    await until(() => errors.length === 1);
    assert.equal(messages.length, 0);
    assert.equal(errors[0].code, "READ_ONLY");
});

test("Server backpressure: ephemeral drops above 64 KiB, slow consumers closed", async () => {
    const { port, server } = await startServer({
        maxPayloadBytes: 64 * 1024,
        maxBufferedBytes: 256 * 1024,
    });
    const sender = await connectClient(port, "rw", { webrtc: false });
    const slow = await rawSocket(port);
    await slow.auth("rw");
    slow.socket.pause();
    const payload = "x".repeat(32 * 1024);
    for (let i = 0; i < 400; i++) await sender.broadcast(payload, { ephemeral: true });
    await until(() => server.room.stats.droppedEphemeral > 0, 5000, "ephemeral drops");
    for (let i = 0; i < 400 && !slow.socket.destroyed; i++) {
        await sender.broadcast(payload).catch(() => {});
        if (slow.frames.some((f) => f.type === "close")) break;
    }
    slow.socket.resume();
    await until(
        () => slow.frames.some((f) => f.type === "close" && f.reason === "slow_consumer"),
        5000,
        "slow_consumer"
    );
});

test("media chunks: out-of-sync receivers skip until init, sender gets one resync", async () => {
    const { port, server } = await startServer({ maxBufferedBytes: 64 * 1024 * 1024 });
    const sender = await rawSocket(port);
    const s = await sender.auth("rw", { capabilities: { webrtc: false, media: true } });
    const receiver = await rawSocket(port);
    await receiver.auth("rw", { capabilities: { webrtc: false, media: true } });
    const noMedia = await rawSocket(port);
    await noMedia.auth("rw", { capabilities: { webrtc: false, media: false } });
    receiver.socket.pause();
    const chunk = (seq: number, init: boolean) => ({
        type: "media:chunk",
        streamId: "s1",
        gen: 1,
        seq,
        mime: "video/webm",
        init,
        data: "A".repeat(48 * 1024),
        deliveredTo: [],
    });
    sender.send(chunk(0, true));
    for (let i = 1; i < 300; i++) sender.send(chunk(i, false));
    const resync = await sender.next("media:resync", 5000);
    assert.equal(resync.streamId, "s1");
    assert.ok(server.room.stats.droppedMediaChunks > 0);
    await sleep(50);
    assert.equal(
        sender.frames.filter((f) => f.type === "media:resync").length,
        0,
        "only one resync"
    );
    assert.equal(noMedia.frames.filter((f) => f.type === "media:chunk").length, 0);
    sender.send({ type: "media:end", streamId: "s1" });
    await sleep(20);
    assert.ok(s.sessionId);
});

test("a write the Server refuses is superseded on linked peers", async () => {
    const { port } = await startServer({ maxStateBytes: 4096 });
    const { a, b } = await linkedPair(port);
    await a.setState("doc", "small");
    await until(() => b.getState("doc") === "small");
    await assert.rejects(a.setState("doc", "y".repeat(5000)), { code: "STATE_TOO_LARGE" });
    await until(() => b.getState("doc") === "small", 2000, "compensation");
    assert.equal(a.getState("doc"), "small");
});
