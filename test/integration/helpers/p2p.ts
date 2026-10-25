// The P2P Server for integration tests: embedded, with the spec's real heartbeat. The FullStacked
// runtime runs in the test process and can stall its event loop longer than the unit tests' 1 s.
import { startServer, type TestServer } from "../../helpers.ts";
import type { ServerConfig } from "../../../src/server/config.ts";

export function startP2P(overrides: Partial<ServerConfig> = {}): Promise<TestServer> {
    return startServer({ heartbeatIntervalMs: 10_000, heartbeatTimeoutMs: 30_000, ...overrides });
}
