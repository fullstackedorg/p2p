// One line per event; never payloads, state values or passwords. See docs/2-server/configuration.md.
import type { LogLevel } from "./config.ts";

export type Logger = Record<LogLevel, (message: string, fields?: Record<string, unknown>) => void>;

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function format(level: LogLevel, message: string, fields?: Record<string, unknown>): string {
    const extra = fields
        ? Object.entries(fields)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
              .join(" ")
        : "";
    return `${new Date().toISOString()} ${level.toUpperCase()} ${message}${extra ? " " + extra : ""}`;
}

export function createLogger(level: LogLevel): Logger {
    const make = (at: LogLevel) => (message: string, fields?: Record<string, unknown>) => {
        if (ORDER[at] < ORDER[level]) return;
        const line = format(at, message, fields);
        if (at === "warn" || at === "error") process.stderr.write(line + "\n");
        else process.stdout.write(line + "\n");
    };
    return { debug: make("debug"), info: make("info"), warn: make("warn"), error: make("error") };
}
