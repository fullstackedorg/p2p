import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { Duplex } from "node:stream";
import { P2PClient } from "../src/client/index.ts";
import {
    collect,
    connectClient,
    join,
    sleep,
    startServer,
    until,
    waitForEvent,
} from "./helpers.ts";

test("peek several channels and read stats in one round trip", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const r1 = await join(a, "room:1");
    const r2 = await join(a, "room:2");
    await join(a, "other");
    await r1.setStates({ thumb: "t1", title: "One" });
    await r2.setState("thumb", "t2");
    const reader = await connectClient(port, "ro");
    const pages = await reader.peek(["room:1", "room:2", "missing"], { keys: ["thumb"] });
    assert.deepEqual(Object.keys(pages).sort(), ["room:1", "room:2"]);
    assert.equal(pages["room:1"].entries.thumb.value, "t1");
    assert.deepEqual(Object.keys(pages["room:1"].entries), ["thumb"]);
    assert.equal(pages["room:2"].stats.keyCount, 1);
    const byPrefix = await reader.getChannelStats({ prefix: "room:" });
    assert.deepEqual(Object.keys(byPrefix).sort(), ["room:1", "room:2"]);
    assert.equal(byPrefix["room:1"].keyCount, 2);
    assert.equal(byPrefix["room:1"].lastWriteBy, "usr_a");
    const byIds = await reader.getChannelStats({ ids: ["other", "missing"] });
    assert.deepEqual(Object.keys(byIds), ["other"]);
    assert.equal(Object.keys(await reader.getChannelStats()).length, 3);
});

test("followStats pushes at most once per second per channel and keeps the last write", async () => {
    const { port } = await startServer();
    const a = await connectClient(port, "rw", { peer: { id: "usr_a" } });
    const room = await join(a, "room:1");
    const other = await join(a, "other");
    const b = await connectClient(port);
    const initial = await b.followStats("room:");
    assert.deepEqual(Object.keys(initial), ["room:1"]);
    const pushed = collect(b, "channel:stats");
    const start = Date.now();
    for (let i = 0; i < 5; i++) await room.setState(`k${i}`, i);
    await other.setState("x", 1);
    await until(() => pushed.length >= 1, 500);
    await until(() => pushed.at(-1)?.stats.keyCount === 5, 2000, "the last write reported");
    assert.ok(Date.now() - start >= 900, "coalesced into the next second");
    assert.ok(pushed.length <= 2, `${pushed.length} pushes for 5 writes`);
    assert.ok(pushed.every((p) => p.channel === "room:1"));
    await b.unfollowStats("room:");
    await room.setState("after", 1);
    await sleep(1200);
    assert.equal(pushed.filter((p) => p.stats.keyCount === 6).length, 0);
    await assert.rejects(b.unfollowStats("room:"), { code: "NOT_SUBSCRIBED" });
});

test("followStats is renewed after a reconnect", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    const room = await join(a, "room:1");
    const b = await connectClient(port);
    await b.followStats("");
    const back = waitForEvent(b, "reconnected");
    b.conn!.destroy("connection_lost");
    await back;
    const pushed = waitForEvent(b, "channel:stats");
    await room.setState("k", 1);
    assert.equal((await pushed).channel, "room:1");
});

test("can() answers with the Server's rules", async () => {
    const { port } = await startServer();
    const alice = await connectClient(port, "rw", { peer: { id: "usr_alice" } });
    const bob = await connectClient(port, "rw", { peer: { id: "usr_bob" } });
    const ro = await connectClient(port, "ro");
    const admin = await connectClient(port, "admin");
    await alice.createChannel("a1");
    await until(() => bob.getChannels().length === 1 && ro.getChannels().length === 1);
    await until(() => admin.getChannels().length === 1);
    assert.equal(alice.can("deleteChannel", "a1"), true);
    assert.equal(bob.can("deleteChannel", "a1"), false);
    assert.equal(admin.can("deleteChannel", "a1"), true);
    assert.equal(bob.can("updateChannel", "a1"), true);
    assert.equal(ro.can("updateChannel", "a1"), false);
    assert.equal(ro.can("createChannel"), false);
    assert.equal(bob.can("createChannel"), true);
    assert.equal(alice.can("deleteChannel", "missing"), false);
    assert.equal(alice.can("updateChannel", "missing"), false);
});

test("device labels get a suffix when another device of the user has them", async () => {
    const { port } = await startServer();
    const opts = { peer: { id: "usr_x" }, deviceLabel: "Laptop" };
    const one = await connectClient(port, "rw", opts);
    const two = await connectClient(port, "rw", opts);
    const three = await connectClient(port, "rw", opts);
    const other = await connectClient(port, "rw", { peer: { id: "usr_y" }, deviceLabel: "Laptop" });
    assert.deepEqual(
        [one.deviceLabel, two.deviceLabel, three.deviceLabel, other.deviceLabel],
        ["Laptop", "Laptop 2", "Laptop 3", "Laptop"]
    );
    await until(() => other.getPeer(two.sessionId)?.deviceLabel === "Laptop 2");
    await one.close();
    const four = await connectClient(port, "rw", opts);
    assert.equal(four.deviceLabel, "Laptop", "the smallest free label");
});

test("a connect timeout says whether the socket opened", async () => {
    const silent = net.createServer(() => {}); // accepts, never answers
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const port = (silent.address() as net.AddressInfo).port;
    await assert.rejects(
        P2PClient.connect({ host: "127.0.0.1", port, connectTimeoutMs: 300, reconnect: false }),
        (err: any) => err.code === "TIMEOUT" && err.stage === "handshake"
    );
    silent.close();
    const never = () =>
        Object.assign(new Duplex({ read() {}, write: (_c, _e, cb) => cb() }), {
            connecting: true,
        }) as any;
    await assert.rejects(
        P2PClient.connect({ host: "x", port: 1, connectTimeoutMs: 200, connect: never }),
        (err: any) => err.code === "TIMEOUT" && err.stage === "socket"
    );
});
