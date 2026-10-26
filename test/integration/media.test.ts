// channel.shareMedia between webview pages: tracks on a link, MediaRecorder -> MSE over the socket relay.
import test from "node:test";
import assert from "node:assert/strict";
import { connectClient, join, until } from "../helpers.ts";
import { startP2P } from "./helpers/p2p.ts";
import { pageApp } from "./helpers/page-app.ts";
import { openPages } from "./helpers/runtime.ts";

const MEDIA_BODY = `
    await until(() => p2p.getPeers("usr_page" + (1 - i)).length === 1, "other page");
    const peer = p2p.getPeers("usr_page" + (1 - i))[0];
    if (p2p.capabilities.webrtc && peer.capabilities.webrtc) {
        await until(() => p2p.getTransport(peer.sessionId) === "webrtc", "link");
    }
    if (i === 0) {
        const canvas = document.createElement("canvas");
        canvas.width = 160;
        canvas.height = 120;
        document.body.appendChild(canvas);
        const g = canvas.getContext("2d");
        let n = 0;
        setInterval(() => {
            g.fillStyle = "hsl(" + ((n++ * 15) % 360) + ",80%,50%)";
            g.fillRect(0, 0, 160, 120);
        }, 40);
        const audio = new AudioContext();
        const osc = audio.createOscillator();
        const dest = audio.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        const stream = new MediaStream([
            ...canvas.captureStream(25).getVideoTracks(),
            ...dest.stream.getAudioTracks(),
        ]);
        await ch.shareMedia(stream);
        await until(() => ch.getState("media:ok") === true, "receiver ok", 60000);
        await ch.stopMedia();
        return { shared: true };
    }
    const event = await waitFor(ch, "media", () => true, 60000);
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = event.stream;
    document.body.appendChild(video);
    video.play().catch(() => {});
    await until(() => video.currentTime > 0.5, "frames flowing", 60000);
    const result = {
        transport: event.transport,
        from: event.peer.peerId,
        video: event.stream.getVideoTracks().length,
        live: event.stream.getVideoTracks().every((t) => t.readyState === "live"),
        currentTime: video.currentTime,
    };
    const ended = waitFor(ch, "media:ended", () => true, 30000);
    await ch.setState("media:ok", true);
    await ended;
    return result;
`;

async function room() {
    const { port, server } = await startP2P();
    const nodePeer = await connectClient(port, "rw", { peer: { id: "usr_node" } });
    await join(nodePeer, "test"); // subscribed, but without media capability
    let chunksAtNode = 0;
    nodePeer.conn!.on("frame", (f: any) => f.type === "media:chunk" && chunksAtNode++);
    return { server, port, nodePeer, chunks: () => chunksAtNode };
}

test("media over a link: tracks, the channel's media event with transport webrtc", { timeout: 240_000 }, async () => {
    const r = await room();
    const pages = await openPages(pageApp({ port: r.port, body: MEDIA_BODY }), 2);
    const [, receiver] = (await pages.results(180_000)).map((t) => JSON.parse(t));
    assert.equal(receiver.transport, "webrtc");
    assert.equal(receiver.from, "usr_page0");
    assert.equal(receiver.video, 1);
    assert.equal(receiver.live, true);
    // only the receiver's media:ok state (to the Node peer) and media:end: no media:chunk
    assert.equal(r.server.registry.stats.relayedFrames, 2, "no media chunk relayed: both pages linked");
    assert.equal(r.chunks(), 0, "the Node peer (no media capability) got no chunk");
    await pages.end();
});

test("media over the socket: MediaRecorder chunks rebuilt with MediaSource", { timeout: 240_000 }, async () => {
    const r = await room();
    const pages = await openPages(
        pageApp({
            port: r.port,
            webrtc: "i === 1 ? false : undefined",
            body: MEDIA_BODY,
        }),
        2
    );
    const [, receiver] = (await pages.results(180_000)).map((t) => JSON.parse(t));
    assert.equal(receiver.transport, "socket");
    assert.equal(receiver.video, 1);
    assert.ok(receiver.currentTime > 0.5);
    assert.ok(r.server.registry.stats.relayedFrames > 5, "chunks went through the Server");
    assert.equal(r.chunks(), 0, "the Node peer (no media capability) got no chunk");
    await pages.end();
});
