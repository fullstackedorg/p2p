import path from "node:path";
import { build } from "esbuild";

// Plain JavaScript for Node.js consumers of @fullstacked/p2p (the "node" export condition):
// Node.js does not strip TypeScript types under node_modules. FullStacked apps bundle the
// TypeScript sources themselves (the "default" condition) and never need this file.
// Runs as `prepare`: before npm pack / npm publish, and in git installs made by npm.

const ROOT = path.resolve(import.meta.dirname, "..");

await build({
    entryPoints: [path.join(ROOT, "src/client/index.ts")],
    outfile: path.join(ROOT, "dist/index.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    legalComments: "none",
    logLevel: "warning",
});
console.log("dist/index.js: built from src/client/index.ts");
