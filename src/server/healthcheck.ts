// Docker HEALTHCHECK probe: a health frame answered within 3 s. See docs/2-server/server.md.
import net from "node:net";
import { encodeFrame, FrameDecoder } from "../protocol/codec.ts";

export function probe(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const decoder = new FrameDecoder(64 * 1024);
        const done = (ok: boolean) => {
            clearTimeout(timer);
            socket.destroy();
            resolve(ok);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        socket.on("connect", () => socket.write(encodeFrame({ type: "health" }, 1024)));
        socket.on("data", (chunk) => {
            try {
                if (decoder.push(chunk as Buffer).some((f) => f.type === "health" && f.ok === true))
                    done(true);
            } catch {
                done(false);
            }
        });
        socket.on("error", () => done(false));
    });
}

if (import.meta.main) {
    const port = parseInt(process.env.P2P_PORT || "4444", 10);
    process.exit((await probe("127.0.0.1", port)) ? 0 : 1);
}
