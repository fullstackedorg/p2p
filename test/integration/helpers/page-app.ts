// The app every webview page runs: connects to the P2P Server through the runtime's node:net, then
// runs a scenario body that sees `p2p`, `i` (page index), `check`, `waitFor` and `until`, and
// returns a JSON result.
import { PASSWORDS } from "../../helpers.ts";

export type PageAppOptions = {
    /** The P2P Server port on 127.0.0.1. */
    port: number;
    role?: (i: number) => "rw" | "ro";
    /** JS expression with `i` in scope, e.g. `i === 2 ? false : undefined`. */
    webrtc?: string;
    peerId?: string;
    body: string;
};

export function pageApp(o: PageAppOptions): string {
    const roles = [0, 1, 2, 3, 4, 5].map((i) => (o.role ? o.role(i) : "rw"));
    return `
        import { P2PClient } from "@client";

        const i = Number(new URLSearchParams(location.search).get("i"));
        const roles = ${JSON.stringify(roles)};
        const passwords = ${JSON.stringify(PASSWORDS)};
        const check = (ok, message) => { if (!ok) throw new Error(message); };
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        async function until(test, label, timeoutMs = 30000) {
            const deadline = Date.now() + timeoutMs;
            while (!test()) {
                if (Date.now() > deadline) throw new Error("timed out: " + label);
                await sleep(20);
            }
        }
        function waitFor(emitter, event, predicate = () => true, timeoutMs = 30000) {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("timed out: " + event)), timeoutMs);
                const listener = (...args) => {
                    if (!predicate(...args)) return;
                    clearTimeout(timer);
                    emitter.off(event, listener);
                    resolve(args[0]);
                };
                emitter.on(event, listener);
            });
        }

        async function run() {
            const role = roles[i];
            const p2p = await P2PClient.connect({
                host: "127.0.0.1",
                port: ${o.port},
                user: role,
                password: passwords[role],
                peer: { id: ${o.peerId ?? "`usr_page${i}`"}, name: "page " + i, meta: { page: i } },
                webrtc: ${o.webrtc ?? "undefined"},
                reconnect: false,
            });
            window.p2p = p2p;
            ${o.body}
        }

        run().then(
            (result) => {
                document.body.innerText = JSON.stringify(result ?? null);
                document.body.classList.add("done");
            },
            (err) => {
                document.body.innerText = "Error: " + (err?.stack || err?.message || String(err));
                document.body.classList.add("error");
            }
        );
    `;
}
