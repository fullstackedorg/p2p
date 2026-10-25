// The package: `npm pack` at the repository root (what npm publishes and what a GitHub install
// keeps, both trimmed by .npmignore), installed like an app dependency, imported as
// "@fullstacked/p2p" by a FullStacked CLI script and a FullStacked webview page.
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { connectClient, PASSWORDS, until } from "../helpers.ts";
import { startP2P } from "./helpers/p2p.ts";
import { openPages, runProgrammatic, TMP_DIR } from "./helpers/runtime.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");
const INSTALLED = path.join(TMP_DIR, "node_modules/@fullstacked/p2p");

before(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const out = execFileSync("npm", ["pack", "--pack-destination", TMP_DIR], {
        cwd: ROOT,
        encoding: "utf-8",
    });
    const tarball = path.join(TMP_DIR, out.trim().split("\n").pop()!);
    fs.rmSync(INSTALLED, { recursive: true, force: true });
    fs.mkdirSync(INSTALLED, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "-C", INSTALLED, "--strip-components=1"]);
    fs.rmSync(tarball);
});

test("the tarball holds the driver only, with its README", () => {
    const files = execFileSync("find", [".", "-type", "f"], { cwd: INSTALLED, encoding: "utf-8" })
        .split("\n")
        .filter(Boolean)
        .sort();
    assert.ok(files.includes("./README.md"));
    assert.ok(files.includes("./package.json"));
    assert.ok(files.includes("./src/client/index.ts"));
    assert.ok(files.every((f) => !f.startsWith("./src/server")), "no server code");
    for (const absent of ["./docs", "./test", "./scripts", "./Dockerfile", "./integration"]) {
        assert.ok(files.every((f) => !f.startsWith(absent)), `nothing from ${absent}`);
    }
    const readme = fs.readFileSync(path.join(INSTALLED, "README.md"), "utf-8");
    assert.match(readme, /^# @fullstacked\/p2p/, "the driver guide is the package README");
    assert.match(readme, /P2PClient\.connect/);
    const pkg = JSON.parse(fs.readFileSync(path.join(INSTALLED, "package.json"), "utf-8"));
    assert.equal(pkg.name, "@fullstacked/p2p");
    assert.deepEqual(pkg.exports, { ".": "./src/client/index.ts" });
});

test("a FullStacked CLI script imports @fullstacked/p2p by name", { timeout: 180_000 }, async () => {
    const { port } = await startP2P();
    const node = await connectClient(port, "rw", { peer: { id: "usr_node" } });
    const cli = runProgrammatic(`
        import { P2PClient, P2PError } from "@fullstacked/p2p";
        const p2p = await P2PClient.connect({ host: "127.0.0.1", port: ${port}, user: "rw", password: "${PASSWORDS.rw}", peer: { id: "usr_pkg" }, reconnect: false });
        if (typeof P2PError !== "function") throw new Error("P2PError not exported");
        await p2p.setState("from:package", "cli");
        await new Promise((resolve) => p2p.on("message", (e) => e.data === "done" && resolve(null)));
        await p2p.close();
    `);
    await until(() => node.getState("from:package") === "cli", 60_000, "cli write");
    await node.send("usr_pkg", "done");
    await cli;
});

test("a FullStacked webview page imports @fullstacked/p2p by name", { timeout: 180_000 }, async () => {
    const { port } = await startP2P();
    const node = await connectClient(port, "rw");
    const pages = await openPages(
        `
        import { P2PClient } from "@fullstacked/p2p";
        (async () => {
            const p2p = await P2PClient.connect({ host: "127.0.0.1", port: ${port}, user: "rw", password: "${PASSWORDS.rw}", peer: { id: "usr_page" } });
            await p2p.setState("from:package", "page");
            return p2p.capabilities;
        })().then(
            (r) => { document.body.innerText = JSON.stringify(r); document.body.classList.add("done"); },
            (e) => { document.body.innerText = String(e?.stack || e); document.body.classList.add("error"); }
        );
        `,
        1
    );
    const [caps] = (await pages.results(60_000)).map((t) => JSON.parse(t));
    assert.deepEqual(caps, { webrtc: true, media: true });
    await until(() => node.getState("from:package") === "page", 10_000, "page write");
    await pages.end();
});
