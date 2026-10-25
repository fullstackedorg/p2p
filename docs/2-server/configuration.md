# Configuration Reference

This page is the single source for every Server setting. Other documents link here instead of repeating tables.

## Zero Configuration

Every setting is optional. `node src/server/main.ts` (or `docker run -p 4444:4444 fullstackedorg/p2p`) starts a Server on port 4444, storing state in `./data` (`/data` in the image), in open mode: every client gets full permissions. Add settings only when you need them; set passwords before exposing it.

## Requirements

- **Node.js 24 LTS or newer.** The Server runs its TypeScript sources directly with Node's built-in type stripping (`node src/server/main.ts`). It has no runtime dependencies.

## Sources and Validation

- Settings come from environment variables only. Inside the repository, `P2PServer` (`src/server/server.ts`) takes the same settings as a typed object built by `loadConfig(env)`, which is how the tests embed a Server.
- Every value is validated at startup. An invalid value (non-numeric port, `P2P_HEARTBEAT_TIMEOUT` not greater than `P2P_HEARTBEAT_INTERVAL`, malformed `P2P_ICE_SERVERS`, ...) prints one line naming the variable and exits with code `1`.
- Durations are in seconds.

## Network

| Environment Variable     | Default   | Description                                                                                                                                                                                                                                              |
| :----------------------- | :-------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P2P_HOST`               | `0.0.0.0` | Bind address of the TCP listener.                                                                                                                                                                                                                        |
| `P2P_PORT`               | `4444`    | TCP port for control sockets: handshake, presence, signaling, state and socket relay. `0` picks a free port (tests).                                                                                                                                     |
| `P2P_MAX_CONNECTIONS`    | `256`     | Most concurrent authenticated sessions. The next `auth` is closed with `server_full`. Sockets still in the handshake also count, up to 2 × this value, so a flood of idle sockets cannot exhaust file descriptors.                                       |
| `P2P_MAX_PAYLOAD_BYTES`  | `1048576` | Largest frame payload (1 MiB), in both directions. Sent to Clients in `connected.limits`.                                                                                                                                                                |
| `P2P_MAX_BUFFERED_BYTES` | `8388608` | Most reliable-frame bytes queued for one recipient socket (8 MiB) before it is closed with `slow_consumer`. Bounds the Server's memory per slow Client; see [Sizing](server.md#8-sizing). Must be at least `P2P_MAX_PAYLOAD_BYTES`.                      |
| `P2P_HEARTBEAT_INTERVAL` | `10`      | Seconds of silence after which a Client sends `ping`. Sent to Clients in `connected.heartbeat`.                                                                                                                                                          |
| `P2P_HEARTBEAT_TIMEOUT`  | `30`      | Seconds without receiving anything before the Server closes a session with `heartbeat_timeout`. Must be greater than the interval.                                                                                                                       |
| `P2P_ICE_SERVERS`        | `[]`      | JSON array of `RTCIceServer` objects sent to Clients in `connected.iceServers`, e.g. `[{"urls":"stun:stun.example.com:3478"}]`. Empty means host candidates only: links work on a LAN or loopback, and peers on different networks use the socket relay. |

## Room and State

| Environment Variable  | Default    | Description                                                                                                                                               |
| :-------------------- | :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P2P_DATA_DIR`        | `data`     | Directory holding the snapshot `state.json` (created if missing). The Docker image sets `/data`. Relative paths resolve from the working directory.       |
| `P2P_MAX_STATE_BYTES` | `67108864` | Largest snapshot (64 MiB), measured as the UTF-8 byte length of the serialized snapshot. Writes that would exceed it are rejected with `STATE_TOO_LARGE`. |

## Credentials

| Environment Variable | Default | Description                                         |
| :------------------- | :------ | :-------------------------------------------------- |
| `P2P_ADMIN_USER`     | `admin` | Username for role `admin`.                          |
| `P2P_ADMIN_PASSWORD` | _none_  | Password for role `admin`. Unset disables the role. |
| `P2P_RW_USER`        | `rw`    | Username for role `rw`.                             |
| `P2P_RW_PASSWORD`    | _none_  | Password for role `rw`. Unset disables the role.    |
| `P2P_RO_USER`        | `ro`    | Username for role `ro`.                             |
| `P2P_RO_PASSWORD`    | _none_  | Password for role `ro`. Unset disables the role.    |

The three usernames must be distinct. When **no** password is set at all the Server runs in **open mode**: every client is accepted as `rw` with or without credentials, and the usernames `ro` and `admin` select those roles. Setting any password switches to **strict mode**, where only roles with a password exist. See [Auth & Roles](../3-subsystems/auth.md#2-open-mode).

## Logging

| Environment Variable | Default | Description                                                                                      |
| :------------------- | :------ | :----------------------------------------------------------------------------------------------- |
| `P2P_LOG_LEVEL`      | `info`  | `debug`, `info`, `warn` or `error`. One line per event on stdout (`warn` and `error` on stderr). |

Logs never contain passwords, message payloads or state values. `info` logs startup, shutdown, session open and close (`peerId`, `deviceId`, role, reason); `debug` adds relays, drops and snapshot writes.

## Example

```bash
P2P_PORT=4444 \
P2P_DATA_DIR=./data \
P2P_RW_PASSWORD=change-me \
P2P_RO_PASSWORD=spectate \
P2P_ADMIN_PASSWORD=admin-secret \
P2P_ICE_SERVERS='[{"urls":"stun:stun.example.com:3478"}]' \
node src/server/main.ts
```
