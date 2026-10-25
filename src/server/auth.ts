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
    const users = new Map<string, { role: Role; hash: Buffer | null }>();
    const add = (role: Role, user: string, password: string | undefined) => {
        if (password) users.set(user, { role, hash: digest(password) });
        else if (openMode && role !== "admin") users.set(user, { role, hash: null });
    };
    add("admin", config.adminUser, config.adminPassword);
    add("rw", config.rwUser, config.rwPassword);
    add("ro", config.roUser, config.roPassword);

    return {
        openMode,
        enabledRoles: [...users.values()].map((u) => u.role),
        authenticate(user, password) {
            if (typeof user !== "string" || typeof password !== "string") return null;
            const candidate = digest(password);
            const record = users.get(user);
            if (!record) {
                // same work for unknown users
                crypto.timingSafeEqual(candidate, candidate);
                return null;
            }
            if (record.hash === null) return record.role;
            return crypto.timingSafeEqual(candidate, record.hash) ? record.role : null;
        },
    };
}
