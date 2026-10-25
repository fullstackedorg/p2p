// Every runtime in one room: two webview pages, a FullStacked CLI peer and a Node.js peer.
// The CLI and page 0 share a peerId: one user on two devices.
import test from "node:test";
import assert from "node:assert/strict";
import { collect, connectClient, PASSWORDS, until } from "../helpers.ts";
import { startP2P } from "./helpers/p2p.ts";
import { pageApp } from "./helpers/page-app.ts";
import { clientImport, openPages, runProgrammatic } from "./helpers/runtime.ts";

/** Shared by pages and the CLI: wait for everyone, race on one key, collect messages. */
const SCENARIO = `
    const got = [];
    p2p.on("message", (e) => got.push({ data: e.data, from: e.from.peerId, transport: e.transport }));
    await until(() => p2p.getActivePeers().length === 3, "all four peers", 60000);
    if (p2p.capabilities.webrtc) {
        const linkable = () => p2p.getActivePeers().filter((p) => p.capabilities.webrtc);
        await until(() => linkable().every((p) => p2p.getTransport(p.sessionId) === "webrtc"), "links", 30000);
    }
    const transports = Object.fromEntries(
        p2p.getActivePeers().map((p) => [p.meta.label, p2p.getTransport(p.sessionId)])
    );
    await p2p.setState("ready:" + label, true);
    await until(() => ["page0", "page1", "cli", "node"].every((l) => p2p.getState("ready:" + l)), "all ready", 60000);
    await p2p.setState("race", label);
    if (label === "page0") await p2p.broadcast("hello from page0");
    await until(() => p2p.getState("finish") === true, "finish", 60000);
    const result = { label, got, race: p2p.getState("race"), transports };
`;

test("pages link, everything else relays; one user on two devices", { timeout: 240_000 }, async () => {
    const { port, server } = await startP2P();
    const node = await connectClient(port, "rw", { peer: { id: "usr_node", meta: { label: "node" } } });
    const nodeGot = collect(node, "message");
    const pages = await openPages(
        pageApp({
            port,
            peerId: 'i === 0 ? "usr_alice" : "usr_bob"',
            body: `
                const label = "page" + i;
                await p2p.updatePresence({ label });
                ${SCENARIO}
                return result;
            `,
        }),
        2
    );
    const cli = runProgrammatic(`
        import { P2PClient } from "${clientImport()}";
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        async function until(test, label, timeoutMs) {
            const deadline = Date.now() + timeoutMs;
            while (!test()) {
                if (Date.now() > deadline) throw new Error("timed out: " + label);
                await sleep(20);
            }
        }
        const p2p = await P2PClient.connect({
            host: "127.0.0.1", port: ${port}, user: "rw", password: "${PASSWORDS.rw}",
            peer: { id: "usr_alice", meta: { label: "cli" } }, reconnect: false,
        });
        const label = "cli";
        ${SCENARIO}
        const fromPage0 = got.filter((g) => g.data === "hello from page0");
        if (fromPage0.length !== 1) throw new Error("cli got page0's broadcast " + fromPage0.length + " times");
        if (!got.some((g) => g.data === "to alice")) throw new Error("cli missed the message to usr_alice");
        if (Object.values(transports).some((t) => t !== "socket")) throw new Error("cli must be socket-only");
        await p2p.close();
    `);
    await until(() => node.getActivePeers().length === 3, 120_000, "all peers");
    await node.setState("ready:node", true);
    await until(() => node.getState("race") !== undefined, 60_000, "race");
    await node.setState("race", "node");
    await until(() => nodeGot.some((m) => m.data === "hello from page0"), 30_000, "broadcast");
    await node.send("usr_alice", "to alice");
    await until(() => node.getPeers("usr_alice").length === 2);
    await new Promise((r) => setTimeout(r, 500));
    await node.setState("finish", true);
    const results = (await pages.results(120_000)).map((t) => JSON.parse(t));
    await cli;
    const race = node.getState("race");
    for (const r of results) assert.equal(r.race, race, `${r.label} converged`);
    assert.equal(server.store.entries.get("race")?.value, race);
    const [page0, page1] = results;
    assert.deepEqual(page0.transports, { page1: "webrtc", cli: "socket", node: "socket" });
    assert.deepEqual(page1.transports, { page0: "webrtc", cli: "socket", node: "socket" });
    assert.equal(page1.got.filter((g: any) => g.data === "hello from page0").length, 1);
    assert.equal(page1.got.find((g: any) => g.data === "hello from page0").transport, "webrtc");
    assert.equal(nodeGot.filter((m) => m.data === "hello from page0").length, 1);
    assert.ok(page0.got.some((g: any) => g.data === "to alice"), "page0 is usr_alice too");
    assert.ok(!page1.got.some((g: any) => g.data === "to alice"));
    await pages.end();
});
