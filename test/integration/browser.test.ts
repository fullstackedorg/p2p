// FullStacked webview pages: real WebRTC links over loopback, control sockets through the runtime's node:net.
import test from "node:test";
import assert from "node:assert/strict";
import { connectClient, until } from "../helpers.ts";
import { startP2P } from "./helpers/p2p.ts";
import { pageApp } from "./helpers/page-app.ts";
import { openPages } from "./helpers/runtime.ts";

test("two webview pages open a link and stop using the Server for their traffic", { timeout: 180_000 }, async () => {
    const { port, server } = await startP2P();
    const observer = await connectClient(port, "admin", { mode: "inspect" });
    const pages = await openPages(
        pageApp({
            port,
            body: `
            const other = "usr_page" + (1 - i);
            await until(() => p2p.getPeers(other).length === 1, "other page");
            const peer = p2p.getPeers(other)[0];
            await until(() => p2p.getTransport(peer.sessionId) === "webrtc", "link", 30000);
            const got = [];
            const record = (e) => {
                got.push({ data: e.data, transport: e.transport, ephemeral: e.ephemeral });
                e.reply?.({ pong: e.data, transport: e.transport });
            };
            p2p.on("message", record);
            ch.on("message", record);
            const changes = [];
            ch.on("state:changed", (c) => c.key === "shape" && changes.push(c.transport));
            await ch.setState("linked:" + i, true);
            await until(() => ch.getState("linked:" + (1 - i)) === true, "both linked");
            let reply = null;
            if (i === 0) {
                await ch.broadcast({ n: 1 });
                await ch.broadcast({ cursor: true }, { ephemeral: true });
                await p2p.send(other, { n: 2 });
                reply = await p2p.request(other, "ping");
                await ch.setState("shape", { by: 0 });
                await until(() => ch.getState("done:1") === true, "page 1 done");
            } else {
                await until(() => got.length >= 4 && ch.getState("shape"), "page 0 traffic");
                await ch.setState("done:1", true);
            }
            return {
                capabilities: p2p.capabilities,
                transport: p2p.getTransport(peer.sessionId),
                got,
                reply,
                changes,
            };
        `,
        }),
        2
    );
    const [page0, page1] = (await pages.results(120_000)).map((t) => JSON.parse(t));
    assert.deepEqual(page0.capabilities, { webrtc: true, media: true });
    assert.equal(page0.transport, "webrtc");
    assert.deepEqual(page0.reply, { pong: "ping", transport: "webrtc" });
    assert.deepEqual(
        page1.got.map((g: any) => [g.transport, g.ephemeral]),
        [
            ["webrtc", false],
            ["webrtc", true],
            ["webrtc", false],
            ["webrtc", false],
        ]
    );
    assert.ok(page1.changes.includes("webrtc"), `state arrived over the link: ${JSON.stringify(page1)}`);
    const schema = await observer.getSchema();
    for (const p of schema.peers) assert.deepEqual(Object.values(p.links), ["webrtc"]);
    assert.equal(server.registry.stats.relayedFrames, 0, "no message was relayed by the Server");
    assert.ok(server.registry.stats.skippedByDeliveredTo >= 1);
    const stored = server.store.get("test")!.entries.get("shape");
    assert.deepEqual(stored?.value, { by: 0 }, "state still persisted");
    await pages.end();
});

test("a page with webrtc: false stays on the socket while the others link", { timeout: 180_000 }, async () => {
    const { port } = await startP2P();
    const pages = await openPages(
        pageApp({
            port,
            webrtc: "i === 2 ? false : undefined",
            body: `
            await until(() => p2p.getActivePeers().length === 2, "all pages");
            const others = p2p.getActivePeers();
            if (i !== 2) {
                const linked = others.find((p) => p.capabilities.webrtc);
                await until(() => p2p.getTransport(linked.sessionId) === "webrtc", "link");
            }
            await sleep(500);
            const transports = Object.fromEntries(others.map((p) => [p.meta.page, p.getTransport ? "" : p2p.getTransport(p.sessionId)]));
            const got = [];
            ch.on("message", (e) => got.push([e.from.meta.page, e.transport]));
            await ch.setState("ready:" + i, true);
            await until(() => [0, 1, 2].every((n) => ch.getState("ready:" + n)), "all ready");
            await ch.broadcast("from " + i);
            await until(() => got.length === 2, "two broadcasts");
            await sleep(200);
            return { webrtc: p2p.capabilities.webrtc, transports, got: got.sort() };
        `,
        }),
        3
    );
    const results = (await pages.results(120_000)).map((t) => JSON.parse(t));
    assert.equal(results[2].webrtc, false);
    assert.deepEqual(results[0].transports, { 1: "webrtc", 2: "socket" });
    assert.deepEqual(results[2].transports, { 0: "socket", 1: "socket" });
    assert.deepEqual(results[0].got, [[1, "webrtc"], [2, "socket"]], "each broadcast once");
    assert.deepEqual(results[2].got, [[0, "socket"], [1, "socket"]]);
    await pages.end();
});

test("pages that share no channel never link and receive nothing from each other", { timeout: 180_000 }, async () => {
    const { port } = await startP2P();
    const pages = await openPages(
        pageApp({
            port,
            body: `
            const other = "usr_page" + (1 - i);
            await until(() => p2p.getPeers(other).length === 1, "other page");
            const peer = p2p.getPeers(other)[0];
            await until(() => p2p.getTransport(peer.sessionId) === "webrtc", "link over test", 30000);
            const own = await p2p.subscribe("board:" + i, { create: true });
            const got = [];
            own.on("message", (e) => got.push(e.data));
            await ch.unsubscribe();
            await until(() => p2p.getPeer(peer.sessionId).channels.join() === "board:" + (1 - i), "other board");
            await until(() => p2p.getTransport(peer.sessionId) === "socket", "link released", 30000);
            await own.broadcast("only on board " + i);
            await own.setState("mine", i);
            await sleep(1000);
            return { got, transport: p2p.getTransport(peer.sessionId), keys: Object.keys(own.getState()) };
        `,
        }),
        2
    );
    const results = (await pages.results(120_000)).map((t) => JSON.parse(t));
    for (const r of results) {
        assert.deepEqual(r.got, []);
        assert.equal(r.transport, "socket");
        assert.deepEqual(r.keys, ["mine"]);
    }
    await pages.end();
});
