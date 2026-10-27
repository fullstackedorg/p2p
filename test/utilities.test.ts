import test from "node:test";
import assert from "node:assert/strict";
import { fromBase64, toBase64 } from "../src/client/media-fallback.ts";
import { linkEligible, randomId } from "../src/client/wiring.ts";
import { createLogger } from "../src/server/log.ts";
import { collect, connectClient, startServer, until } from "./helpers.ts";

test("logger filters by level and never throws on fields", () => {
    const lines: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((s: string) => (lines.push(`out ${s}`), true)) as any;
    process.stderr.write = ((s: string) => (lines.push(`err ${s}`), true)) as any;
    try {
        const log = createLogger("info");
        log.debug("hidden");
        log.info("shown", { peerId: "usr_a", n: 1, skip: undefined });
        log.error("bad");
    } finally {
        process.stdout.write = out;
        process.stderr.write = err;
    }
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^out .* INFO shown peerId=usr_a n=1\n$/);
    assert.match(lines[1], /^err .* ERROR bad\n$/);
});

test("base64 helpers round-trip binary data", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
    assert.equal(toBase64(Uint8Array.of(1, 2, 3)), Buffer.from([1, 2, 3]).toString("base64"));
});

test("device ids are random url-safe strings; link eligibility rules", () => {
    const ids = new Set(Array.from({ length: 100 }, randomId));
    assert.equal(ids.size, 100);
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{16}$/);
    const peer = (role: "rw" | "ro", webrtc = true) => ({
        peerId: "p",
        sessionId: "s",
        deviceId: "d",
        deviceLabel: "",
        name: "p",
        meta: {},
        role,
        capabilities: { webrtc, media: false },
        channels: ["main"],
        connectedAt: 0,
    });
    const caps = { webrtc: true, media: false };
    assert.equal(linkEligible("peer", caps, peer("ro"), true), true);
    assert.equal(linkEligible("peer", caps, peer("rw"), false), false);
    assert.equal(linkEligible("inspect", caps, peer("rw"), true), false);
    assert.equal(linkEligible("peer", caps, peer("rw", false), true), false);
});

test("Server errors without a reqId surface as error events", async () => {
    const { port } = await startServer();
    const a = await connectClient(port);
    const b = await connectClient(port);
    const errors = collect(a, "error");
    a.conn!.send({ type: "signal", to: b.sessionId, signal: { kind: "offer" } }); // b has no webrtc
    await until(() => errors.length === 1);
    assert.equal(errors[0].code, "INVALID_ARGUMENT");
});
