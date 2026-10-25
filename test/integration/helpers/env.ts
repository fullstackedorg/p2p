process.env.TEST = "1";

export const PORTS = {
    p2p: parseInt(process.env.TEST_P2P_PORT || "4444", 10),
} as const;

/** Credentials of the Docker image under test (docker-compose.test.yml). */
export const CREDENTIALS = {
    rw: { user: "rw", password: "secret" },
    ro: { user: "ro", password: "spectate" },
    admin: { user: "admin", password: "admin" },
} as const;
