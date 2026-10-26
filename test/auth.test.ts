import test from "node:test";
import assert from "node:assert/strict";
import { createAuthenticator } from "../src/server/auth.ts";
import { loadConfig } from "../src/server/config.ts";
import { P2PClient } from "../src/client/index.ts";
import { PASSWORDS, rawSocket, startServer } from "./helpers.ts";

test("roles resolve from configured credentials", () => {
    const auth = createAuthenticator({
        ...loadConfig({}),
        adminPassword: "a",
        rwPassword: "b",
        roPassword: "c",
    });
    assert.equal(auth.openMode, false);
    assert.equal(auth.authenticate("admin", "a"), "admin");
    assert.equal(auth.authenticate("rw", "b"), "rw");
    assert.equal(auth.authenticate("ro", "c"), "ro");
    assert.equal(auth.authenticate("rw", "c"), null);
    assert.equal(auth.authenticate("nobody", "b"), null);
    assert.equal(auth.authenticate("rw", 1), null);
});

test("a role without a password is disabled", () => {
    const auth = createAuthenticator({ ...loadConfig({}), rwPassword: "b" });
    assert.equal(auth.authenticate("ro", ""), null);
    assert.equal(auth.authenticate("admin", ""), null);
    assert.deepEqual(auth.enabledRoles, ["rw"]);
});

test("open mode: everyone is accepted as rw; the ro and admin usernames select those roles", () => {
    const auth = createAuthenticator(loadConfig({}));
    assert.equal(auth.openMode, true);
    assert.deepEqual(auth.enabledRoles, ["admin", "rw", "ro"]);
    assert.equal(auth.authenticate(undefined, undefined), "rw");
    assert.equal(auth.authenticate("", ""), "rw");
    assert.equal(auth.authenticate("alice", "whatever"), "rw");
    assert.equal(auth.authenticate("rw", ""), "rw");
    assert.equal(auth.authenticate("ro", "anything"), "ro");
    assert.equal(auth.authenticate("admin", ""), "admin");
});

test("one password anywhere switches to strict mode", () => {
    const auth = createAuthenticator({ ...loadConfig({}), roPassword: "r" });
    assert.equal(auth.openMode, false);
    assert.equal(auth.authenticate("alice", "whatever"), null);
    assert.equal(auth.authenticate("rw", ""), null);
    assert.equal(auth.authenticate("ro", "r"), "ro");
});

test("a zero-config Server accepts clients without credentials", async () => {
    const { port } = await startServer({
        adminPassword: undefined,
        rwPassword: undefined,
        roPassword: undefined,
    });
    const anonymous = await P2PClient.connect({ host: "127.0.0.1", port });
    assert.equal(anonymous.role, "rw");
    await (await anonymous.subscribe("tinker", { create: true })).setState("tinker", true);
    const spectator = await P2PClient.connect({ host: "127.0.0.1", port, user: "ro" });
    assert.equal(spectator.role, "ro");
    assert.equal((await spectator.subscribe("tinker")).getState("tinker"), true);
    await assert.rejects(spectator.createChannel("x"), { code: "FORBIDDEN" });
    const admin = await P2PClient.connect({ host: "127.0.0.1", port, user: "admin" });
    assert.equal(admin.role, "admin");
    for (const c of [anonymous, spectator, admin]) await c.close();
});

test("wrong password and unknown user close identically with auth_failed", async () => {
    const { port } = await startServer();
    const closes = [];
    for (const user of ["rw", "nobody"]) {
        const raw = await rawSocket(port);
        raw.send({ type: "auth", reqId: 1, version: 2, user, password: "wrong" });
        closes.push(await raw.next("close"));
        await raw.closed;
    }
    assert.deepEqual(closes[0], closes[1]);
    assert.equal(closes[0].reason, "auth_failed");
});

test("connect rejects with AUTH_FAILED and does not retry", async () => {
    const { port } = await startServer();
    await assert.rejects(
        P2PClient.connect({ host: "127.0.0.1", port, user: "rw", password: "nope" }),
        { code: "AUTH_FAILED" }
    );
});

test("handshake rules: version, mode, health, frames before auth", async () => {
    const { port } = await startServer();
    const cases: Array<[Record<string, unknown>, string]> = [
        [{ type: "auth", version: 1, user: "rw", password: PASSWORDS.rw }, "unsupported_version"],
        [
            { type: "auth", version: 2, user: "rw", password: PASSWORDS.rw, mode: "x" },
            "invalid_frame",
        ],
        [{ type: "broadcast", msgId: "x:1" }, "invalid_frame"],
    ];
    for (const [frame, reason] of cases) {
        const raw = await rawSocket(port);
        raw.send(frame as any);
        assert.equal((await raw.next("close")).reason, reason);
    }
    const health = await rawSocket(port);
    health.send({ type: "health" });
    assert.deepEqual(await health.next("health"), { type: "health", ok: true });
    assert.equal((await health.next("close")).reason, "client_close");
    const twice = await rawSocket(port);
    await twice.auth("rw");
    twice.send({ type: "auth", version: 2, user: "rw", password: PASSWORDS.rw });
    assert.equal((await twice.next("close")).reason, "invalid_frame");
});
