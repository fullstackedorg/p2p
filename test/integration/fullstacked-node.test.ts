// FullStacked CLI peers (socket-only) connecting to the P2P Server through the runtime's node:net.
import test from "node:test";
import assert from "node:assert/strict";
import { connectClient, createTempDir, join, PASSWORDS, until } from "../helpers.ts";
import { startP2P } from "./helpers/p2p.ts";
import { clientImport, runProgrammatic } from "./helpers/runtime.ts";

type Peer = { id: string; role?: "rw" | "ro" };

/** A CLI script that subscribes to "test", answers requests and runs `body`, then waits for done. */
function cliScript(port: number, peer: Peer, body: string): string {
    const role = peer.role ?? "rw";
    return `
        import { P2PClient } from "${clientImport()}";

        const p2p = await P2PClient.connect({
            host: "127.0.0.1",
            port: ${port},
            user: "${role}",
            password: "${PASSWORDS[role]}",
            peer: { id: "${peer.id}", name: "CLI", meta: { runtime: "cli" } },
            reconnect: false,
        });
        const check = (ok, message) => { if (!ok) throw new Error(message); };
        const ch = await p2p.subscribe("test", { create: p2p.role !== "ro" });
        check(p2p.capabilities.webrtc === false, "the CLI must be socket-only");
        check(p2p.capabilities.media === false, "the CLI has no media");
        const done = new Promise((resolve) => p2p.on("message", (e) => {
            if (e.data?.type === "done") resolve(e.data);
        }));
        p2p.on("message", (e) => e.reply?.({ pong: e.data, transport: e.transport, role: p2p.role }));
        ${body}
        await ch.setState("ready:${peer.id}", true);
        await done;
        await p2p.close();
    `;
}

test("FullStacked CLI peer: presence, messaging, requests and state", { timeout: 180_000 }, async () => {
    const { port } = await startP2P();
    const node = await connectClient(port, "rw", { peer: { id: "usr_node" } });
    const nodeCh = await join(node, "test");
    await nodeCh.setState("seed", "from node");
    node.on("message", (e) => e.reply?.({ transport: e.transport }));
    const hello = new Promise((resolve) =>
        nodeCh.on("message", (e) => (e.data as any)?.hello && resolve(e))
    );
    const cli = runProgrammatic(
        cliScript(
            port,
            { id: "usr_cli" },
            `
            check(p2p.getPeers("usr_node").length === 1, "sees the node peer");
            check(ch.getState("seed") === "from node", "got the state on subscribe");
            await ch.setState("written:by-cli", { ok: true });
            await ch.broadcast({ hello: "from cli" });
            const answer = await p2p.request("usr_node", "ping from cli");
            check(answer.transport === "socket", "replies come over the socket");
            `
        )
    );
    await until(() => nodeCh.getState("ready:usr_cli") === true, 60_000, "cli ready");
    const cliPeer = node.getPeers("usr_cli")[0];
    assert.equal(cliPeer.capabilities.webrtc, false);
    assert.equal(cliPeer.meta.runtime, "cli");
    assert.deepEqual(cliPeer.channels, ["test"]);
    assert.deepEqual(nodeCh.getState("written:by-cli"), { ok: true });
    assert.equal(((await hello) as any).transport, "socket");
    const reply = await node.request("usr_cli", "ping from node");
    assert.deepEqual(reply, { pong: "ping from node", transport: "socket", role: "rw" });
    assert.equal(node.getTransport(cliPeer.sessionId), "socket");
    await node.send("usr_cli", { type: "done" });
    await cli;
    await until(() => node.getPeers("usr_cli").length === 0, 5000, "cli left");
    const late = await join(await connectClient(port, "ro"), "test");
    assert.deepEqual(late.getState("written:by-cli"), { ok: true });
});

test("FullStacked CLI ro peer joins existing channels only and interacts fully", { timeout: 180_000 }, async () => {
    const { port } = await startP2P();
    const node = await connectClient(port, "rw", { peer: { id: "usr_node" } });
    const nodeCh = await join(node, "test");
    await nodeCh.setState("doc", "v1");
    const cli = runProgrammatic(
        cliScript(
            port,
            { id: "usr_viewer", role: "ro" },
            `
            check(p2p.role === "ro", "role ro");
            check(ch.getState("doc") === "v1", "reads state");
            let code = "";
            try { await p2p.subscribe("new-board", { create: true }); } catch (err) { code = err.code; }
            check(code === "FORBIDDEN", "channel creation rejected with FORBIDDEN, got " + code);
            await ch.setState("doc", "edited by ro");
            const seen = await p2p.query({ operation: "getState", channel: "test", key: "doc" });
            check(seen.entries.doc.value === "edited by ro", "query reads work for ro");
            `
        )
    );
    await until(() => nodeCh.getState("ready:usr_viewer") === true, 60_000, "viewer ready");
    const viewer = node.getPeers("usr_viewer")[0];
    assert.equal(viewer.role, "ro");
    assert.equal(nodeCh.getState("doc"), "edited by ro");
    assert.deepEqual(await node.request("usr_viewer", 1), { pong: 1, transport: "socket", role: "ro" });
    await node.send("usr_viewer", { type: "done" });
    await cli;
});

test("FullStacked CLI peer reconnects after the Server restarts", { timeout: 180_000 }, async () => {
    const dataDir = createTempDir(); // kept across both Servers
    const first = await startP2P({ dataDir });
    const { port } = first;
    const node = await connectClient(port, "rw", { peer: { id: "usr_node" } });
    const nodeCh = await join(node, "test");
    const cli = runProgrammatic(`
        import { P2PClient } from "${clientImport()}";
        const p2p = await P2PClient.connect({
            host: "127.0.0.1", port: ${port}, user: "rw", password: "${PASSWORDS.rw}",
            peer: { id: "usr_cli" }, reconnect: { initialDelayMs: 100, maxDelayMs: 500 },
        });
        const ch = await p2p.subscribe("test");
        await ch.setState("before", 1);
        await new Promise((resolve) => p2p.once("reconnected", resolve));
        if (!ch.subscribed) throw new Error("the channel survives the restart");
        await ch.setState("after", 2);
        await new Promise((resolve) => p2p.on("message", (e) => e.data === "done" && resolve(null)));
        await p2p.close();
    `);
    await until(() => nodeCh.getState("before") === 1, 60_000, "cli connected");
    await first.close();
    const second = await startP2P({ dataDir, port });
    const node2 = await connectClient(second.port, "rw", { peer: { id: "usr_node2" } });
    const node2Ch = await join(node2, "test");
    await until(() => node2Ch.getState("after") === 2, 30_000, "cli reconnected");
    assert.equal(node2Ch.getState("before"), 1, "state kept across the restart");
    await node2.send("usr_cli", "done");
    await cli;
});
