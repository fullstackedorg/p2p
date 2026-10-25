// Drives the FullStacked runtime from the fullstacked submodule: CLI scripts and webview pages.
process.env.TEST = "1";

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import child_process from "node:child_process";
import { fileURLToPath } from "node:url";
import { after } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
export const TMP_DIR = path.resolve(__dirname, "../tmp");
const RUNTIME_DIR = path.join(ROOT, "integration/fullstacked");
const BUILD_STAMP = path.join(RUNTIME_DIR, "core/bin/.integration-build");
const BUILD_LOCK = path.join(RUNTIME_DIR, "core/bin/.integration-build.lock");

/** How scripts written to TMP_DIR (or one level below) import the client driver. */
export function clientImport(fromDir = TMP_DIR): string {
    const rel = path.relative(fromDir, path.join(ROOT, "src/client/index.ts"));
    return rel.startsWith(".") ? rel : `./${rel}`;
}

let fullstacked: any = null;
let stopRuntime: (() => void) | null = null;
const browsers = new Set<{ end(): Promise<unknown> }>();

export function stopFullStackedRuntime() {
    stopRuntime?.();
    stopRuntime = null;
}

after(async () => {
    await Promise.all([...browsers].map((b) => b.end().catch(() => {})));
    stopFullStackedRuntime();
});

function runtimeSourceState(): string | null {
    try {
        const git = (args: string[]) =>
            child_process.execFileSync("git", ["-C", RUNTIME_DIR, ...args], { encoding: "utf-8" });
        const head = git(["rev-parse", "HEAD"]).trim();
        const diff = git(["diff", "HEAD", "--", "core", "platform/node", "types", "version.ts"]);
        return `${head} ${crypto.createHash("sha256").update(diff).digest("hex")}`;
    } catch {
        return null;
    }
}

/** Rebuilds the runtime's core and node binding when they don't match its source (once, locked). */
async function ensureRuntimeBuilt() {
    const state = runtimeSourceState();
    const built = () => (fs.existsSync(BUILD_STAMP) ? fs.readFileSync(BUILD_STAMP, "utf-8") : "");
    if (!state || built() === state) return;
    fs.mkdirSync(path.dirname(BUILD_LOCK), { recursive: true });
    for (const deadline = Date.now() + 10 * 60_000; ; ) {
        try {
            fs.mkdirSync(BUILD_LOCK);
            break;
        } catch {
            if (built() === state) return;
            if (Date.now() > deadline) throw new Error(`Timed out waiting for ${BUILD_LOCK}`);
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
    try {
        if (built() === state) return;
        console.log(`[integration] building the FullStacked runtime for ${state.slice(0, 12)}`);
        child_process.execSync("npm run build && npm run build -w platform/node", {
            cwd: RUNTIME_DIR,
            stdio: "inherit",
        });
        fs.writeFileSync(BUILD_STAMP, state);
    } finally {
        fs.rmSync(BUILD_LOCK, { recursive: true, force: true });
    }
}

async function runtime(): Promise<any> {
    if (fullstacked) return fullstacked;
    fs.mkdirSync(TMP_DIR, { recursive: true });
    await ensureRuntimeBuilt();
    const node = (await import(
        "../../../integration/fullstacked/platform/node/src/index.ts" as any
    )) as any;
    stopRuntime = node.stop;
    const mod = (await import(
        "../../../integration/fullstacked/core/internal/bundle/lib/fullstacked/index.ts" as any
    )) as any;
    fullstacked = mod.default || mod;
    return fullstacked;
}

/** Runs a script in the FullStacked CLI (`fullstacked -f`); rejects on a non-zero exit. */
export async function runProgrammatic(script: string): Promise<string> {
    const fs_ = await runtime();
    const id = crypto.randomBytes(6).toString("hex");
    const scriptPath = path.join(TMP_DIR, `script-${Date.now()}-${id}.ts`);
    fs.writeFileSync(scriptPath, script, "utf-8");
    let output = "";
    const sink = {
        write: (msg: string) => void (output += msg),
        writeln: (msg: string) => void (output += msg + "\n"),
    };
    try {
        const code = await fs_.execute(["fullstacked", "-f", path.relative(process.cwd(), scriptPath)], {
            stdio: [null, sink, sink],
        });
        if (code !== 0) throw new Error(`FullStacked CLI script failed (exit ${code}):\n${output}`);
        return output;
    } finally {
        fs.rmSync(scriptPath, { force: true });
        fs.rmSync(`${scriptPath}.js`, { force: true });
    }
}

export type Pages = {
    /** Resolves with each page's final body text once every page is done (rejects on an error page). */
    results(timeoutMs?: number): Promise<string[]>;
    evaluate<T>(index: number, fn: string): Promise<T>;
    end(): Promise<void>;
};

/** Bundles `script` as one app and opens it in `count` pages of one headless Chromium. */
export async function openPages(script: string, count: number): Promise<Pages> {
    await runtime();
    const appDir = path.join(TMP_DIR, `app-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "index.ts"), script.replaceAll("@client", clientImport(appDir)));
    const base = "../../../integration/fullstacked";
    const bundle = ((await import(`${base}/core/internal/bundle/lib/bundle/index.ts`)) as any).default;
    const run = ((await import(`${base}/core/internal/bundle/lib/run/index.ts`)) as any).default;
    const { createWebView } = (await import(`${base}/platform/node/src/index.ts`)) as any;
    const { launchBrowser } = (await import(`${base}/test/browser.ts`)) as any;
    const result = await bundle.bundle(path.relative(process.cwd(), path.join(appDir, "index.ts")));
    if (result.Errors?.length) throw new Error(`Bundling failed: ${JSON.stringify(result.Errors)}`);
    // one runtime context and webview per page, like one app per device: a context streams
    // socket data to a single page
    const webviews: any[] = [];
    for (let i = 0; i < count; i++) {
        const ctx = await run({ directory: path.relative(process.cwd(), appDir) });
        webviews.push(await createWebView(ctx, { quiet: true }));
    }
    const show = !!process.env.SHOW_BROWSER;
    const browser = await launchBrowser({
        headless: !show,
        devtools: show,
        args: ["--disable-features=WebRtcHideLocalIpsWithMdns", "--autoplay-policy=no-user-gesture-required"],
    });
    const pages: any[] = [];
    for (let i = 0; i < count; i++) {
        const page = await browser.newPage();
        page.on("pageerror", (err: any) => console.error(`[page ${i} error]`, err?.message ?? err));
        if (process.env.DEBUG_PAGES) page.on("console", (m: any) => console.log(`[page ${i}]`, m.text()));
        await page.goto(`http://localhost:${webviews[i].port}/?i=${i}`);
        pages.push(page);
    }
    let ended = false;
    const handle: Pages = {
        async results(timeoutMs = 60_000) {
            const done = `document.body.classList.contains("done") || document.body.classList.contains("error")`;
            return Promise.all(
                pages.map(async (page, i) => {
                    await page.waitForFunction(done, { timeout: timeoutMs, polling: 100 }); // rAF never fires in background tabs
                    const failed = await page.evaluate(() => document.body.classList.contains("error"));
                    const text = await page.evaluate(() => document.body.innerText);
                    if (failed) throw new Error(`page ${i} failed: ${text}`);
                    return text;
                })
            );
        },
        evaluate: (index, fn) => pages[index].evaluate(fn),
        async end() {
            if (ended) return;
            ended = true;
            browsers.delete(handle);
            for (const webview of webviews) webview.close();
            await browser.close();
            fs.rmSync(appDir, { recursive: true, force: true });
        },
    };
    browsers.add(handle);
    return handle;
}
