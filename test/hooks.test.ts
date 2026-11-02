import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HookRegistry, loadPlugins } from "../src/server/hooks.ts";
import { connectClient, createTempDir, join, startServer, until } from "./helpers.ts";

test("a bare Server counts nothing: the schema has no relay counters", async () => {
    const { port } = await startServer({}, { bare: true });
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" } });
    await join(b, "room");
    await (await join(a, "room")).broadcast("hello");
    const schema = await (await connectClient(port, "admin", { mode: "inspect" })).getSchema();
    assert.equal("stats" in schema, false);
    assert.equal("recentCloses" in schema, false);
    assert.ok(schema.storageBytes >= 0, "state accounting stays: it enforces P2P_MAX_STATE_BYTES");
});

test("hooks see sessions, relayed frames and every socket byte", async () => {
    const { port, server } = await startServer({}, { bare: true });
    const events: string[] = [];
    const relayed: Array<{ type: string; channel?: string; recipients: number }> = [];
    let bytesIn = 0;
    server.registerHook("session_connected", (socket) => {
        socket.on("data", (chunk: Buffer) => void (bytesIn += chunk.length));
    });
    server.registerHook("session_start", (s) => void events.push(`start ${s.peerId}`));
    server.registerHook("session_end", (s) => void events.push(`end ${s.peerId} ${s.reason}`));
    server.registerHook("frame_relayed", ({ type, channel, recipients, bytes }) => {
        assert.ok(bytes > 0);
        relayed.push({ type, channel, recipients });
    });
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const b = await connectClient(port, "rw", { peer: { id: "usr_b" } });
    await join(b, "room");
    await (await join(a, "room")).broadcast("hello");
    await until(() => relayed.length > 0);
    assert.deepEqual(relayed, [{ type: "broadcast", channel: "room", recipients: 1 }]);
    await b.close();
    await until(() => events.includes("end usr_b client_close"));
    assert.deepEqual(events.slice(0, 2), ["start usr_a", "start usr_b"]);
    assert.ok(bytesIn > 0);
});

test("unknown hooks throw, failing handlers are isolated and handlers can be removed", () => {
    const errors: string[] = [];
    const log = { debug() {}, info() {}, warn() {}, error: (m: string) => void errors.push(m) };
    const hooks = new HookRegistry(log);
    assert.throws(() => hooks.register("nope" as never, (() => {}) as never), /unknown hook: nope/);
    const seen: string[] = [];
    hooks.register("session_start", () => {
        throw new Error("boom");
    });
    const off = hooks.register("session_start", (s) => void seen.push(s.peerId));
    const info = { sessionId: "s", peerId: "usr_a", deviceId: "d", role: "rw", mode: "peer" };
    hooks.run("session_start", info);
    assert.deepEqual(seen, ["usr_a"]);
    assert.deepEqual(errors, ["hook failed"]);
    off();
    hooks.run("session_start", info);
    assert.deepEqual(seen, ["usr_a"]);
    assert.equal(hooks.has("frame_relayed"), false);
});

test("P2P_PLUGINS loads each module's default export", async () => {
    const dir = createTempDir();
    fs.writeFileSync(
        path.join(dir, "count.ts"),
        'export default (server) => server.registerHook("session_start", () => {});\n'
    );
    const plugins = await loadPlugins(" count.ts , ", dir);
    assert.equal(plugins.length, 1);
    const registered: string[] = [];
    plugins[0]!({ registerHook: ((name: string) => void registered.push(name)) as never });
    assert.deepEqual(registered, ["session_start"]);
    fs.writeFileSync(path.join(dir, "bad.ts"), "export const x = 1;\n");
    await assert.rejects(loadPlugins("bad.ts", dir), /no default export function/);
    assert.deepEqual(await loadPlugins(undefined, dir), []);
    fs.rmSync(dir, { recursive: true, force: true });
});
