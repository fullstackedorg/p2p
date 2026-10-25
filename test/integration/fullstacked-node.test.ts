// FullStacked CLI peers (socket-only) connecting to the P2P Server through the runtime's node:net.
import test from "node:test";
import assert from "node:assert/strict";
import { connectClient, createTempDir, PASSWORDS, until } from "../helpers.ts";
import { startP2P } from "./helpers/p2p.ts";
import { clientImport, runProgrammatic } from "./helpers/runtime.ts";

type Peer = { id: string; role?: "rw" | "ro" };

/** A CLI script that joins the room, answers requests and runs `body`, then waits for done. */
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
        check(p2p.capabilities.webrtc === false, "the CLI must be socket-only");
        check(p2p.capabilities.media === false, "the CLI has no media");
        const done = new Promise((resolve) => p2p.on("message", (e) => {
            if (e.data?.type === "done") resolve(e.data);
        }));
        p2p.on("message", (e) => e.reply?.({ pong: e.data, transport: e.transport, role: p2p.role }));
        ${body}
        await p2p.setState("ready:${peer.id}", true).catch(() => {});
        await done;
        await p2p.close();
    `;
}

test("FullStacked CLI peer: presence, messaging, requests and state", { timeout: 180_000 }, async () => {
    const { port } = await startP2P();
    const node = await connectClient(port, "rw", { peer: { id: "usr_node" } });
    await node.setState("seed", "from node");
    node.on("message", (e) => e.reply?.({ transport: e.transport }));
    const hello = new Promise((resolve) =>
        node.on("message", (e) => (e.data as any)?.hello && resolve(e))
    );
    const cli = runProgrammatic(
        cliScript(
            port,
            { id: "usr_cli" },
            `
            check(p2p.getPeers("usr_node").length === 1, "sees the node peer");
            check(p2p.getState("seed") === "from node", "got the state on connect");
            await p2p.setState("written:by-cli", { ok: true });
            await p2p.broadcast({ hello: "from cli" });
            const answer = await p2p.request("usr_node", "ping from cli");
            check(answer.transport === "socket", "replies come over the socket");
            `
        )
    );
    await until(() => node.getState("ready:usr_cli") === true, 60_000, "cli ready");
    const cliPeer = node.getPeers("usr_cli")[0];
    assert.equal(cliPeer.capabilities.webrtc, false);
    assert.equal(cliPeer.meta.runtime, "cli");
    assert.deepEqual(node.getState("written:by-cli"), { ok: true });
    assert.equal(((await hello) as any).transport, "socket");
    const reply = await node.request("usr_cli", "ping from node");
    assert.deepEqual(reply, { pong: "ping from node", transport: "socket", role: "rw" });
    assert.equal(node.getTransport(cliPeer.sessionId), "socket");
    await node.send("usr_cli", { type: "done" });
    await cli;
    await until(() => node.getPeers("usr_cli").length === 0, 5000, "cli left");
    const late = await connectClient(port, "ro");
    assert.deepEqual(late.getState("written:by-cli"), { ok: true });
});

test("FullStacked CLI spectator gets READ_ONLY and still sees everything", { timeout: 180_000 }, async () => {
    const { port } = await startP2P();
    const node = await connectClient(port, "rw", { peer: { id: "usr_node" } });
    await node.setState("doc", "v1");
    const cli = runProgrammatic(
        cliScript(
            port,
            { id: "usr_viewer", role: "ro" },
            `
            check(p2p.role === "ro", "role ro");
            check(p2p.getState("doc") === "v1", "reads state");
            let code = "";
            try { await p2p.setState("doc", "hacked"); } catch (err) { code = err.code; }
            check(code === "READ_ONLY", "write rejected with READ_ONLY, got " + code);
            const seen = await p2p.query({ operation: "getState", key: "doc" });
            check(seen.entries.doc.value === "v1", "query reads work for spectators");
            `
        )
    );
    await until(() => node.getPeers("usr_viewer").length === 1, 60_000, "viewer joined");
    const viewer = node.getPeers("usr_viewer")[0];
    assert.equal(viewer.role, "ro");
    await node.setState("doc", "v2");
    await assert.rejects(node.request("usr_viewer", 1), { code: "TARGET_READ_ONLY" });
    await node.send("usr_viewer", { type: "done" });
    await cli;
    assert.equal(node.getState("doc"), "v2");
});

test("FullStacked CLI peer reconnects after the Server restarts", { timeout: 180_000 }, async () => {
    const dataDir = createTempDir(); // kept across both Servers
    const first = await startP2P({ dataDir });
    const { port } = first;
    const node = await connectClient(port, "rw", { peer: { id: "usr_node" } });
    const cli = runProgrammatic(`
        import { P2PClient } from "${clientImport()}";
        const p2p = await P2PClient.connect({
            host: "127.0.0.1", port: ${port}, user: "rw", password: "${PASSWORDS.rw}",
            peer: { id: "usr_cli" }, reconnect: { initialDelayMs: 100, maxDelayMs: 500 },
        });
        await p2p.setState("before", 1);
        await new Promise((resolve) => p2p.once("reconnected", resolve));
        await p2p.setState("after", 2);
        await new Promise((resolve) => p2p.on("message", (e) => e.data === "done" && resolve(null)));
        await p2p.close();
    `);
    await until(() => node.getState("before") === 1, 60_000, "cli connected");
    await first.close();
    const second = await startP2P({ dataDir, port });
    const node2 = await connectClient(second.port, "rw", { peer: { id: "usr_node2" } });
    await until(() => node2.getState("after") === 2, 30_000, "cli reconnected");
    assert.equal(node2.getState("before"), 1, "state kept across the restart");
    await node2.send("usr_cli", "done");
    await cli;
});
