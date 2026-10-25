// Credentials to role. See docs/3-subsystems/auth.md.
import crypto from "node:crypto";
import type { Role } from "../protocol/types.ts";
import type { ServerConfig } from "./config.ts";

export type Authenticator = {
    openMode: boolean;
    enabledRoles: Role[];
    authenticate(user: unknown, password: unknown): Role | null;
};

function digest(value: string): Buffer {
    return crypto.createHash("sha256").update(value, "utf-8").digest();
}

export function createAuthenticator(config: ServerConfig): Authenticator {
    const openMode = !config.adminPassword && !config.rwPassword && !config.roPassword;
    const users = new Map<string, { role: Role; hash: Buffer }>();
    const add = (role: Role, user: string, password: string | undefined) => {
        if (password) users.set(user, { role, hash: digest(password) });
    };
    add("admin", config.adminUser, config.adminPassword);
    add("rw", config.rwUser, config.rwPassword);
    add("ro", config.roUser, config.roPassword);

    return {
        openMode,
        enabledRoles: openMode ? ["admin", "rw", "ro"] : [...users.values()].map((u) => u.role),
        authenticate(user, password) {
            if (openMode) {
                // zero config: everyone gets in with full permissions; the ro/admin usernames
                // still select those roles so spectators and admins stay testable
                if (user === config.roUser) return "ro";
                if (user === config.adminUser) return "admin";
                return "rw";
            }
            if (typeof user !== "string" || typeof password !== "string") return null;
            const candidate = digest(password);
            const record = users.get(user);
            if (!record) {
                // same work for unknown users
                crypto.timingSafeEqual(candidate, candidate);
                return null;
            }
            return crypto.timingSafeEqual(candidate, record.hash) ? record.role : null;
        },
    };
}
