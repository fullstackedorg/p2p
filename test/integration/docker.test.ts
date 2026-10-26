// The Docker image (fullstackedorg/p2p) from docker-compose.test.yml, started by scripts/test-integration.ts.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { P2PClient } from "../../src/client/index.ts";
import { probe } from "../../src/server/healthcheck.ts";
import { until } from "../helpers.ts";
import { CREDENTIALS, PORTS } from "./helpers/env.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

function compose(...args: string[]): string {
    return execFileSync("docker", ["compose", "-f", "docker-compose.test.yml", ...args], {
        cwd: ROOT,
        encoding: "utf-8",
    }).trim();
}

function health(): string {
    const id = compose("ps", "-q", "p2p");
    return execFileSync("docker", ["inspect", "--format", "{{.State.Health.Status}}", id], {
        encoding: "utf-8",
    }).trim();
}

async function waitHealthy(timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (health() !== "healthy") {
        if (Date.now() > deadline) throw new Error(`container not healthy: ${health()}`);
        await new Promise((r) => setTimeout(r, 500));
    }
}

function connect(role: keyof typeof CREDENTIALS = "rw", extra = {}) {
    return P2PClient.connect({
        host: "127.0.0.1",
        port: PORTS.p2p,
        ...CREDENTIALS[role],
        reconnect: { initialDelayMs: 200, maxDelayMs: 1000 },
        ...extra,
    });
}

before(async () => {
    const deadline = Date.now() + 60_000;
    while (!(await probe("127.0.0.1", PORTS.p2p, 1000))) {
        if (Date.now() > deadline) {
            throw new Error("the p2p container is not running: use npm run test:integration");
        }
        await new Promise((r) => setTimeout(r, 500));
    }
});

test("the container becomes healthy and applies its env credentials", { timeout: 90_000 }, async () => {
    await waitHealthy();
    const rw = await connect("rw");
    assert.equal(rw.role, "rw");
    const ro = await connect("ro");
    assert.equal(ro.role, "ro");
    await assert.rejects(P2PClient.connect({ host: "127.0.0.1", port: PORTS.p2p, user: "rw", password: "nope" }), {
        code: "AUTH_FAILED",
    });
    await rw.close();
    await ro.close();
});

test("state survives docker compose restart", { timeout: 120_000 }, async () => {
    const writer = await connect("rw");
    const board = await writer.subscribe("docker", { create: true });
    await board.setState("docker:persisted", { at: Date.now() });
    const value = board.getState("docker:persisted");
    await writer.close();
    await new Promise((r) => setTimeout(r, 1200)); // past the 1 s snapshot delay
    compose("restart", "p2p");
    await waitHealthy();
    const reader = await connect("ro");
    assert.deepEqual((await reader.subscribe("docker")).getState("docker:persisted"), value);
    await reader.close();
});

test("docker compose stop sends server_shutdown; clients reconnect on start", { timeout: 120_000 }, async () => {
    const client = await connect("rw");
    const reasons: string[] = [];
    client.on("disconnected", (e) => reasons.push(e.reason));
    const reconnected = new Promise((r) => client.once("reconnected", r));
    compose("stop", "p2p");
    await until(() => reasons.length === 1, 30_000, "disconnected");
    assert.equal(reasons[0], "server_shutdown");
    compose("start", "p2p");
    await reconnected;
    assert.equal(client.connected, true);
    await client.close();
});
