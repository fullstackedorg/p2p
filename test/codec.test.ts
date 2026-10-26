import test from "node:test";
import assert from "node:assert/strict";
import {
    decodeLinkMessage,
    encodeFrame,
    encodeLinkMessage,
    FrameDecoder,
} from "../src/protocol/codec.ts";
import { compareVersion, applyEntry, isVersion, valueType } from "../src/protocol/lww.ts";
import type { Entry } from "../src/protocol/types.ts";

const frames = [
    { type: "auth", reqId: 1, version: 2, user: "rw", password: "é😀" },
    { type: "broadcast", msgId: "s:1", data: { nested: [1, 2, { x: null }] }, deliveredTo: [] },
    { type: "state:set", key: "k", value: "v", version: [3, "s"], reqId: 9 },
];

test("frames round-trip", () => {
    const decoder = new FrameDecoder(1024);
    for (const f of frames) assert.deepEqual(decoder.push(encodeFrame(f, 1024)), [f]);
});

test("byte-by-byte delivery and many frames in one chunk", () => {
    const bytes = Buffer.concat(frames.map((f) => encodeFrame(f, 1024)));
    const one = new FrameDecoder(1024);
    const out = [];
    for (const b of bytes) out.push(...one.push(Uint8Array.of(b)));
    assert.deepEqual(out, frames);
    assert.equal(one.bufferedBytes, 0);
    assert.deepEqual(new FrameDecoder(1024).push(bytes), frames);
});

test("payload at the limit passes, one byte over fails before buffering", () => {
    const max = 1_048_576;
    const fill = (n: number) => ({ type: "x", d: "a".repeat(n) });
    const overhead = JSON.stringify(fill(0)).length;
    const atLimit = encodeFrame(fill(max - overhead), max);
    assert.equal(new FrameDecoder(max).push(atLimit).length, 1);
    assert.throws(() => encodeFrame(fill(max - overhead + 1), max), { code: "PAYLOAD_TOO_LARGE" });
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, max + 1);
    assert.throws(() => new FrameDecoder(max).push(header), { code: "PAYLOAD_TOO_LARGE" });
});

test("invalid frames: length 0, bad UTF-8, bad JSON, missing type", () => {
    const raw = (payload: Uint8Array) => {
        const out = new Uint8Array(4 + payload.length);
        new DataView(out.buffer).setUint32(0, payload.length);
        out.set(payload, 4);
        return out;
    };
    assert.throws(() => new FrameDecoder(64).push(new Uint8Array(4)), { code: "INVALID_FRAME" });
    assert.throws(() => new FrameDecoder(64).push(raw(Uint8Array.of(0xff, 0xfe))), {
        code: "INVALID_FRAME",
    });
    const enc = (s: string) => raw(new TextEncoder().encode(s));
    assert.throws(() => new FrameDecoder(64).push(enc("{nope")), { code: "INVALID_FRAME" });
    assert.throws(() => new FrameDecoder(64).push(enc("[1]")), { code: "INVALID_FRAME" });
    assert.throws(() => new FrameDecoder(64).push(enc('{"type":1}')), { code: "INVALID_FRAME" });
});

test("link messages round-trip without a prefix", () => {
    for (const f of frames) assert.deepEqual(decodeLinkMessage(encodeLinkMessage(f)), f);
    assert.throws(() => decodeLinkMessage("{}"), { code: "INVALID_FRAME" });
});

test("LWW: clock first, then sessionId, equal versions are one write", () => {
    assert.ok(compareVersion([2, "a"], [1, "z"]) > 0);
    assert.ok(compareVersion([1, "b"], [1, "a"]) > 0);
    assert.equal(compareVersion([1, "a"], [1, "a"]), 0);
    const map = new Map<string, Entry>();
    const e = (clock: number, s: string): Entry => ({
        value: `${clock}${s}`,
        deleted: false,
        version: [clock, s],
        updatedBy: s,
        updatedAt: 0,
    });
    assert.equal(applyEntry(map, "k", e(1, "a")), true);
    assert.equal(applyEntry(map, "k", e(1, "a")), false);
    assert.equal(applyEntry(map, "k", e(1, "b")), true);
    assert.equal(applyEntry(map, "k", e(1, "a")), false);
    assert.equal(map.get("k")!.value, "1b");
    assert.ok(isVersion([1, "a"]) && !isVersion([0, "a"]) && !isVersion([1.5, "a"]));
    assert.deepEqual([null, [], {}, "", 1, true].map(valueType), [
        "null",
        "array",
        "object",
        "string",
        "number",
        "boolean",
    ]);
});

test("three replicas converge whatever the delivery order", () => {
    const writes: Array<[string, Entry]> = [];
    for (let i = 0; i < 30; i++) {
        const key = `k${i % 4}`;
        const clock = 1 + Math.floor(Math.random() * 5);
        const session = `s${i}`; // versions are unique in practice
        writes.push([
            key,
            {
                value: i,
                deleted: i % 7 === 0,
                version: [clock, session],
                updatedBy: session,
                updatedAt: 0,
            },
        ]);
    }
    const replicas = [0, 1, 2].map(() => new Map<string, Entry>());
    replicas.forEach((r, i) => {
        const order = [...writes].sort(() => (i === 0 ? 0 : Math.random() - 0.5));
        for (const [k, e] of order) applyEntry(r, k, e);
    });
    const dump = (m: Map<string, Entry>) => JSON.stringify([...m].sort());
    assert.equal(dump(replicas[0]), dump(replicas[1]));
    assert.equal(dump(replicas[1]), dump(replicas[2]));
});
