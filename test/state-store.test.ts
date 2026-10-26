import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { P2PServer } from "../src/server/server.ts";
import { LEGACY_CHANNEL, StateStore, type StoredChannel } from "../src/server/state-store.ts";
import { LIMITS, type Entry } from "../src/protocol/types.ts";
import { connectClient, createTempDir, join, silentLogger, sleep, startServer } from "./helpers.ts";

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

function channel(s: StateStore, id = "main"): StoredChannel {
    s.create({ id, createdAt: 1, createdBy: "u" });
    return s.get(id)!;
}

test("snapshot format 2, atomic write and reload", async () => {
    const dir = createTempDir();
    const a = store(dir);
    await a.load();
    a.set(channel(a, "board:A"), "k", entry({ x: 1 }, 5));
    channel(a, "board:B");
    await a.flush();
    const file = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf-8"));
    assert.equal(file.format, 2);
    assert.equal(file.clock, 5);
    assert.deepEqual(file.channels["board:A"].entries.k.value, { x: 1 });
    assert.equal(file.channels["board:A"].createdBy, "u");
    assert.deepEqual(file.channels["board:B"].entries, {});
    assert.equal(fs.existsSync(path.join(dir, "state.json.tmp")), false);
    const b = store(dir);
    await b.load();
    assert.equal(b.clock, 5);
    assert.deepEqual(b.get("board:A")!.entries.get("k")!.value, { x: 1 });
    assert.ok(b.get("board:B"));
    assert.equal(b.size, a.size);
});

test("a format 1 snapshot migrates to the default channel", async () => {
    const dir = createTempDir();
    const legacy = { format: 1, savedAt: 7, clock: 3, entries: { k: entry("v", 3) } };
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(legacy));
    const s = store(dir);
    await s.load();
    assert.equal(s.clock, 3);
    assert.equal(s.get(LEGACY_CHANNEL)!.entries.get("k")!.value, "v");
    await s.flush();
    const file = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf-8"));
    assert.equal(file.format, 2);
    assert.equal(file.channels.default.entries.k.value, "v");
});

test("debounce coalesces many writes into few file writes", async () => {
    const dir = createTempDir();
    const s = store(dir, { debounceMs: 30, maxDelayMs: 200 });
    await s.load();
    const c = channel(s);
    await s.flush();
    let renames = 0;
    const watcher = fs.watch(
        dir,
        (event, name) => event === "rename" && name === "state.json" && renames++
    );
    for (let i = 1; i <= 50; i++) s.set(c, "k", entry(i, i));
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
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ format: 9, channels: {} }));
    await assert.rejects(store(dir).load(), /unsupported format/);
});

test("size cap covers every channel; deletes pass; deleting a channel frees its size", async () => {
    const s = store(createTempDir(), { maxStateBytes: 700 });
    await s.load();
    const a = channel(s, "a");
    const b = channel(s, "b");
    s.set(a, "k", entry("x".repeat(200), 1));
    assert.throws(() => s.set(b, "k", entry("y".repeat(400), 2)), { code: "STATE_TOO_LARGE" });
    assert.equal(b.entries.has("k"), false);
    s.set(a, "k", { ...entry(null, 3), deleted: true });
    s.set(b, "k", entry("z".repeat(300), 4));
    const withB = s.size;
    s.delete("b");
    assert.equal(s.size, withB - b.bytes);
    assert.equal(s.get("b"), undefined);
});

test("tombstones older than 24 h are purged at snapshot time", async () => {
    let now = 1_000_000;
    const dir = createTempDir();
    const s = store(dir, { now: () => now });
    await s.load();
    const c = channel(s);
    s.set(c, "old", { ...entry(null, 1), deleted: true, updatedAt: now });
    s.set(c, "live", entry(1, 2));
    now += LIMITS.tombstoneTtlMs + 1;
    s.set(c, "fresh", { ...entry(null, 3), deleted: true, updatedAt: now });
    await s.flush();
    assert.equal(c.entries.has("old"), false);
    assert.equal(c.entries.has("fresh"), true);
    assert.equal(c.entries.has("live"), true);
});

test("clear tombstones only older live entries of the channel, optionally under a prefix", async () => {
    const s = store(createTempDir());
    await s.load();
    const c = channel(s);
    const other = channel(s, "other");
    s.set(c, "a:1", entry(1, 1));
    s.set(c, "a:2", entry(2, 9));
    s.set(c, "b:1", entry(3, 2));
    s.set(other, "a:1", entry(4, 1));
    assert.deepEqual(s.clear(c, [5, "s"], "u", "a:"), ["a:1"]);
    assert.equal(c.entries.get("a:2")!.deleted, false);
    assert.equal(c.entries.get("b:1")!.deleted, false);
    assert.equal(other.entries.get("a:1")!.deleted, false);
});

test("state survives a Server restart", async () => {
    const dataDir = createTempDir();
    const first = await startServer({ dataDir });
    const a = await connectClient(first.port);
    await (await join(a)).setState("persisted", { ok: true });
    await a.close();
    await first.close();
    const second = await startServer({ dataDir });
    const b = await connectClient(second.port);
    assert.deepEqual((await join(b)).getState("persisted"), { ok: true });
});

test("the Server refuses to start on a corrupt snapshot", async () => {
    const dataDir = createTempDir();
    fs.writeFileSync(path.join(dataDir, "state.json"), "nope");
    const { config } = await startServer();
    const server = new P2PServer({ ...config, dataDir, port: 0 }, silentLogger);
    await assert.rejects(server.listen());
});
