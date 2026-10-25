import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { P2PServer } from "../src/server/server.ts";
import { StateStore } from "../src/server/state-store.ts";
import { LIMITS, type Entry } from "../src/protocol/types.ts";
import { connectClient, createTempDir, silentLogger, sleep, startServer } from "./helpers.ts";

function store(dataDir: string, extra: Partial<ConstructorParameters<typeof StateStore>[0]> = {}) {
    return new StateStore({
        dataDir,
        maxStateBytes: 1_000_000,
        debounceMs: 10,
        maxDelayMs: 50,
        now: Date.now,
        log: silentLogger,
        ...extra,
    });
}

const entry = (value: unknown, clock: number, session = "s"): Entry => ({
    value,
    deleted: false,
    version: [clock, session],
    updatedBy: "u",
    updatedAt: Date.now(),
});

test("snapshot format, atomic write and reload", async () => {
    const dir = createTempDir();
    const a = store(dir);
    await a.load();
    a.set("k", entry({ x: 1 }, 5));
    await a.flush();
    const file = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf-8"));
    assert.equal(file.format, 1);
    assert.equal(file.clock, 5);
    assert.deepEqual(file.entries.k.value, { x: 1 });
    assert.equal(fs.existsSync(path.join(dir, "state.json.tmp")), false);
    const b = store(dir);
    await b.load();
    assert.equal(b.clock, 5);
    assert.deepEqual(b.entries.get("k")!.value, { x: 1 });
    assert.equal(b.size, a.size);
});

test("debounce coalesces many writes into few file writes", async () => {
    const dir = createTempDir();
    const s = store(dir, { debounceMs: 30, maxDelayMs: 200 });
    await s.load();
    let renames = 0;
    const watcher = fs.watch(
        dir,
        (event, name) => event === "rename" && name === "state.json" && renames++
    );
    for (let i = 1; i <= 50; i++) s.set("k", entry(i, i));
    await sleep(120);
    watcher.close();
    assert.ok(renames >= 1 && renames <= 3, `renames=${renames}`);
});

test("a leftover state.json.tmp is ignored and removed; corrupt state.json refuses to start", async () => {
    const dir = createTempDir();
    fs.writeFileSync(path.join(dir, "state.json.tmp"), "partial");
    const s = store(dir);
    await s.load();
    assert.equal(fs.existsSync(path.join(dir, "state.json.tmp")), false);
    fs.writeFileSync(path.join(dir, "state.json"), "{broken");
    await assert.rejects(store(dir).load(), /not valid JSON/);
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ format: 9, entries: {} }));
    await assert.rejects(store(dir).load(), /unsupported format/);
});

test("size cap: writes over it throw STATE_TOO_LARGE, deletes always pass", async () => {
    const s = store(createTempDir(), { maxStateBytes: 500 });
    await s.load();
    s.set("a", entry("x".repeat(100), 1));
    assert.throws(() => s.set("b", entry("y".repeat(500), 2)), { code: "STATE_TOO_LARGE" });
    assert.equal(s.entries.has("b"), false);
    s.set("a", { ...entry(null, 3), deleted: true });
    assert.ok(s.size < 500);
});

test("tombstones older than 24 h are purged at snapshot time", async () => {
    let now = 1_000_000;
    const dir = createTempDir();
    const s = store(dir, { now: () => now });
    await s.load();
    s.set("old", { ...entry(null, 1), deleted: true, updatedAt: now });
    s.set("live", entry(1, 2));
    now += LIMITS.tombstoneTtlMs + 1;
    s.set("fresh", { ...entry(null, 3), deleted: true, updatedAt: now });
    await s.flush();
    assert.equal(s.entries.has("old"), false);
    assert.equal(s.entries.has("fresh"), true);
    assert.equal(s.entries.has("live"), true);
});

test("clear tombstones only older live entries, optionally under a prefix", async () => {
    const s = store(createTempDir());
    await s.load();
    s.set("a:1", entry(1, 1));
    s.set("a:2", entry(2, 9));
    s.set("b:1", entry(3, 2));
    assert.deepEqual(s.clear([5, "s"], "u", "a:"), ["a:1"]);
    assert.equal(s.entries.get("a:2")!.deleted, false);
    assert.equal(s.entries.get("b:1")!.deleted, false);
});

test("state survives a Server restart", async () => {
    const dataDir = createTempDir();
    const first = await startServer({ dataDir });
    const a = await connectClient(first.port);
    await a.setState("persisted", { ok: true });
    await a.close();
    await first.close();
    const second = await startServer({ dataDir });
    const b = await connectClient(second.port);
    assert.deepEqual(b.getState("persisted"), { ok: true });
});

test("the Server refuses to start on a corrupt snapshot", async () => {
    const dataDir = createTempDir();
    fs.writeFileSync(path.join(dataDir, "state.json"), "nope");
    const { config } = await startServer();
    const server = new P2PServer({ ...config, dataDir, port: 0 }, silentLogger);
    await assert.rejects(server.listen());
});
