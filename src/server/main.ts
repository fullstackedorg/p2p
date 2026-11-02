// CLI / Docker entry point. See docs/2-server/server.md; P2P_PLUGINS: docs/2-server/hooks.md.
import { ConfigError, loadConfig } from "./config.ts";
import { loadPlugins } from "./hooks.ts";
import { P2PServer } from "./server.ts";

let config;
try {
    config = loadConfig(process.env);
} catch (err) {
    console.error(err instanceof ConfigError ? err.message : String(err));
    process.exit(1);
}

const server = new P2PServer(config);
try {
    for (const plugin of await loadPlugins(process.env.P2P_PLUGINS)) plugin(server);
    await server.listen();
} catch (err: any) {
    server.log.error("startup failed", { error: err?.message ?? String(err) });
    process.exit(1);
}

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        if (stopping) process.exit(1);
        stopping = true;
        server.close().then(
            () => process.exit(0),
            () => process.exit(1)
        );
    });
}
