import fs from "node:fs";
import path from "node:path";

// Copies the client driver sources into driver/src before `npm pack` / `npm publish` (prepack).
// The npm package @fullstacked/p2p ships src/client and src/protocol only; the Server stays out.

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "driver/src");

fs.rmSync(OUT, { recursive: true, force: true });
for (const dir of ["client", "protocol"]) {
    fs.cpSync(path.join(ROOT, "src", dir), path.join(OUT, dir), { recursive: true });
}
console.log(`driver/src: copied src/client and src/protocol`);
