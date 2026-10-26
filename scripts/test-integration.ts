import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Starts the docker-compose.test.yml services, runs the integration tests, then always tears the
// services down (containers, network and anonymous volumes), also on failure or Ctrl-C.
// Pass test files to run a subset; set KEEP_SERVICES=1 to leave the services up between runs.

const ROOT = path.resolve(import.meta.dirname, "..");
const TEST_DIR = path.join(ROOT, "test/integration");
const COMPOSE = ["compose", "-f", "docker-compose.test.yml"];

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): number {
    const res = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", env });
    return res.status ?? 1;
}

// Ctrl-C reaches the test runner too; wait for it to stop, then clean up
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {});

const files = process.argv.slice(2);
const tests = files.length
    ? files
    : fs
          .readdirSync(TEST_DIR)
          .filter((f) => f.endsWith(".test.ts"))
          .map((f) => path.join("test/integration", f));

let code = run("docker", [...COMPOSE, "up", "-d", "--build"]); // the image under test is this checkout
try {
    if (code === 0)
        // one file at a time: every file drives the FullStacked runtime, whose webviews share ports
        code = run(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
            ...process.env,
            TEST: "1",
        });
} finally {
    if (process.env.KEEP_SERVICES !== "1") {
        run("docker", [...COMPOSE, "down", "--volumes", "--remove-orphans", "--timeout", "5"]);
    }
}
process.exit(code);
