import test from "node:test";
import assert from "node:assert/strict";
import { installFakeRTC, liveConnections } from "./fake-rtc.ts";
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

const knobs = installFakeRTC();
const timing = { openTimeoutMs: 150, retryDelayMs: 150, idleCloseMs: 100 };

async function linkedPair(port: number) {
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" }, timing });
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" }, timing });
    const atA = await join(a);
    const atB = await join(b);
    await until(
        () => a.getTransport(b.sessionId) === "webrtc" && b.getTransport(a.sessionId) === "webrtc"
    );
    return { a, b, atA, atB };
}

test("two WebRTC-capable peers sharing a channel open a link and report it", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { timing });
    const changed = waitForEvent(a, "transport:changed");
    const b = await connectClient(port, "rw", { timing });
    assert.equal(a.capabilities.webrtc, true);
    await join(a);
    await sleep(60);
    assert.equal(a.getTransport(b.sessionId), "socket", "no shared channel yet");
    await join(b);
    const event = await changed;
    assert.equal(event.transport, "webrtc");
    assert.equal(event.peer.sessionId, b.sessionId);
    const tool = await connectClient(port, "admin", { mode: "inspect" });
    const schema = await tool.getSchema();
    const peerA = schema.peers.find((p: any) => p.sessionId === a.sessionId);
    await until(() => true);
    assert.equal(peerA.links[b.sessionId], "webrtc");
});

test("a link closes after the idle delay once no channel is shared", async () => {
    const { port } = await startServer();
    const { a, b, atB } = await linkedPair(port);
    const changes = collect(a, "transport:changed");
    await atB.unsubscribe();
    await sleep(timing.idleCloseMs / 3);
    assert.equal(a.getTransport(b.sessionId), "webrtc", "kept during the idle delay");
    await until(() => changes.some((c) => c.transport === "socket"), 2000, "idle close");
    assert.equal(b.getTransport(a.sessionId), "socket");
    await join(b);
    await until(() => a.getTransport(b.sessionId) === "webrtc", 2000, "relink");
});

test("frames between linked peers bypass the Server; others get deliveredTo relays", async () => {
    const { port, server } = await startServer();
    const { a, b, atA, atB } = await linkedPair(port);
    const atBMessages = collect(atB, "message");
    const direct = collect(b, "message");
    const before = server.registry.stats.relayedFrames;
    await atA.broadcast("linked only");
    await a.send("usr_b", "direct");
    await until(() => atBMessages.length === 1 && direct.length === 1);
    assert.equal(atBMessages[0].transport, "webrtc");
    assert.equal(direct[0].transport, "webrtc");
    assert.equal(server.registry.stats.relayedFrames, before);
    const c = await connectClient(port, "rw", { webrtc: false, peer: { id: "usr_c" } });
    const atC = collect(await join(c), "message");
    await until(() => atA.getSubscribers().length === 2);
    const skipped = server.registry.stats.skippedByDeliveredTo;
    await atA.broadcast("mixed");
    await until(() => atBMessages.length === 2 && atC.length === 1);
    await sleep(30);
    assert.equal(atBMessages.length, 2, "b got it exactly once");
    assert.equal(atBMessages[1].transport, "webrtc");
    assert.equal(atC[0].transport, "socket");
    assert.equal(server.registry.stats.skippedByDeliveredTo, skipped + 1);
    assert.equal(c.getTransport(a.sessionId), "socket");
});

test("state writes travel over links and still reach the Server", async () => {
    const { port, server } = await startServer();
    const { atA, atB } = await linkedPair(port);
    const changes = collect(atB, "state:changed");
    await atA.setState("k", 1);
    await until(() => changes.length === 1);
    assert.equal(changes[0].transport, "webrtc");
    const stored = server.store.get("main")!.entries;
    assert.equal(stored.get("k")?.value, 1);
    await atA.deleteState("k");
    await until(() => atB.getState("k") === undefined);
    await atA.setState("x", 1);
    await until(() => atB.getState("x") === 1);
    await atA.clearState();
    await until(() => atB.getState("x") === undefined);
    assert.equal(stored.get("x")?.deleted, true);
});

test("requests and replies over a link", async () => {
    const { port } = await startServer();
    const { a, b } = await linkedPair(port);
    b.on("message", (e) => e.reply?.({ via: e.transport }));
    assert.deepEqual(await a.request("usr_b", "hi"), { via: "webrtc" });
});

test("ephemeral frames use the unordered channel", async () => {
    const { port } = await startServer();
    const { atA, atB } = await linkedPair(port);
    const got = waitForEvent(atB, "message");
    await atA.broadcast({ x: 1 }, { ephemeral: true });
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
    const { a, b, atB: channel } = await linkedPair(port);
    const atB = collect(channel, "message");
    const frame = {
        type: "broadcast",
        channel: "main",
        msgId: `${a.sessionId}:999`,
        data: 1,
        ephemeral: false,
    };
    b.onFrame({ ...frame, from: a.sessionId }, "socket");
    b.onFrame(frame, "webrtc", a.sessionId);
    assert.equal(atB.length, 1);
});

test("a link that never opens stays on the socket, then retries once", async () => {
    const { port } = await startServer();
    knobs.block = true;
    const a = await connectClient(port, "rw", { timing });
    const b = await connectClient(port, "rw", { timing });
    const atA = await join(a);
    const atB = collect(await join(b), "message");
    await sleep(timing.openTimeoutMs + 50);
    assert.equal(a.getTransport(b.sessionId), "socket");
    await atA.broadcast("still works");
    await until(() => atB.length === 1);
    assert.equal(atB[0].transport, "socket");
    knobs.block = false;
    await until(() => a.getTransport(b.sessionId) === "webrtc", 2000, "retry");
});

test("a link that drops falls back to the socket and is re-established", async () => {
    const { port } = await startServer();
    const { a, b, atA, atB: channel } = await linkedPair(port);
    const changes = collect(a, "transport:changed");
    liveConnections().forEach((pc) => pc.breakLink());
    await until(() => changes.some((c) => c.transport === "socket"));
    const atB = collect(channel, "message");
    await atA.broadcast("during fallback");
    await until(() => atB.length === 1);
    await until(() => a.getTransport(b.sessionId) === "webrtc", 2000, "re-link");
});

test("no links for socket-only or inspector peers; link frames for other channels dropped", async () => {
    const { port } = await startServer();
    const rw = await connectClient(port, "rw", { timing });
    const socketOnly = await connectClient(port, "rw", { webrtc: false, timing });
    await connectClient(port, "admin", { mode: "inspect", timing });
    await join(rw);
    await join(socketOnly);
    await sleep(80);
    assert.equal(rw.getTransport(socketOnly.sessionId), "socket");
    const ro = await connectClient(port, "ro", { timing });
    await join(ro);
    await join(ro, "elsewhere").catch(() => {}); // ro cannot create it
    await until(() => rw.getTransport(ro.sessionId) === "webrtc", 2000, "rw-ro link");
    const board = rw.channel("main")!;
    const messages = collect(board, "message");
    ro.links!.send(
        rw.sessionId,
        { type: "broadcast", channel: "other", msgId: `${ro.sessionId}:1`, data: "elsewhere" },
        false
    );
    ro.links!.send(
        rw.sessionId,
        { type: "broadcast", channel: "main", msgId: `${ro.sessionId}:2`, data: "here" },
        false
    );
    await until(() => messages.length === 1);
    assert.equal(messages[0].data, "here");
});

test("Server backpressure: ephemeral drops above 64 KiB, slow consumers closed", async () => {
    const { port, server } = await startServer({
        maxPayloadBytes: 64 * 1024,
        maxBufferedBytes: 256 * 1024,
    });
    const sender = await connectClient(port, "rw", { webrtc: false });
    const board = await join(sender);
    const slow = await rawSocket(port);
    await slow.auth("rw");
    await slow.subscribe();
    slow.socket.pause();
    const payload = "x".repeat(32 * 1024);
    for (let i = 0; i < 400; i++) await board.broadcast(payload, { ephemeral: true });
    await until(() => server.registry.stats.droppedEphemeral > 0, 5000, "ephemeral drops");
    for (let i = 0; i < 400 && !slow.socket.destroyed; i++) {
        await board.broadcast(payload).catch(() => {});
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
    await sender.subscribe();
    const receiver = await rawSocket(port);
    await receiver.auth("rw", { capabilities: { webrtc: false, media: true } });
    await receiver.subscribe();
    const noMedia = await rawSocket(port);
    await noMedia.auth("rw", { capabilities: { webrtc: false, media: false } });
    await noMedia.subscribe();
    const elsewhere = await rawSocket(port);
    await elsewhere.auth("rw", { capabilities: { webrtc: false, media: true } });
    await elsewhere.subscribe("other");
    receiver.socket.pause();
    const chunk = (seq: number, init: boolean) => ({
        type: "media:chunk",
        channel: "main",
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
    assert.equal(resync.channel, "main");
    assert.ok(server.registry.stats.droppedMediaChunks > 0);
    await sleep(50);
    assert.equal(
        sender.frames.filter((f) => f.type === "media:resync").length,
        0,
        "only one resync"
    );
    assert.equal(noMedia.frames.filter((f) => f.type === "media:chunk").length, 0);
    assert.equal(elsewhere.frames.filter((f) => f.type === "media:chunk").length, 0);
    sender.send({ type: "media:end", channel: "main", streamId: "s1" });
    await sleep(20);
    assert.ok(s.sessionId);
});

test("a write the Server refuses is superseded on linked peers", async () => {
    const { port } = await startServer({ maxStateBytes: 4096 });
    const { atA, atB } = await linkedPair(port);
    await atA.setState("doc", "small");
    await until(() => atB.getState("doc") === "small");
    await assert.rejects(atA.setState("doc", "y".repeat(5000)), { code: "STATE_TOO_LARGE" });
    await until(() => atB.getState("doc") === "small", 2000, "compensation");
    assert.equal(atA.getState("doc"), "small");
});

test("an observed channel sends linked broadcasts through the Server too", async () => {
    const { port, server } = await startServer();
    const { atA, atB } = await linkedPair(port);
    const monitor = await connectClient(port, "ro", { mode: "inspect" });
    const watched = await monitor.subscribe("main");
    await until(() => atA.observed && atB.observed);
    const seen = collect(watched, "message");
    const atBMessages = collect(atB, "message");
    await atA.broadcast("watched", { ephemeral: true });
    await until(() => seen.length === 1 && atBMessages.length === 1);
    assert.equal(atBMessages[0].transport, "webrtc", "still over the link for peers");
    await watched.unsubscribe();
    await until(() => !atA.observed);
    const before = server.registry.stats.relayedFrames;
    const skipped = server.registry.stats.skippedByDeliveredTo;
    await atA.broadcast("unwatched");
    await until(() => atBMessages.length === 2);
    assert.equal(server.registry.stats.relayedFrames, before);
    assert.equal(server.registry.stats.skippedByDeliveredTo, skipped, "never sent to the Server");
});
