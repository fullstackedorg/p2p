# Hooks & Plugins

The Server is **un-metered by default**: it provides the P2P features (presence, messaging, channels, shared state, media relay, inspection) and counts nothing about its own traffic. It keeps no byte or frame counters, times no sessions, persists no usage and sends nothing anywhere. Anything an operator wants on top of that (bandwidth accounting, quotas, metrics, audit) is a plugin built on the hooks below.

What the Server does measure is what its features need: the size of each channel's shared state, which enforces `P2P_MAX_STATE_BYTES` and is reported as `storageBytes` / `sizeBytes` by [`schema`](../3-subsystems/inspection.md), and the per-channel [stats](../4-client/client-api.md) apps read (key count, last write).

## 1. Registering Hooks

```typescript
import type { P2PServer } from "../src/server/server.ts";

export default function plugin(server: P2PServer) {
    const off = server.registerHook("frame_relayed", ({ channel, recipients, bytes }) => {
        // count recipients * bytes for `channel`
    });
    // off() removes the handler
}
```

- `server.registerHook(name, handler)` returns a function that removes the handler. An unknown name throws.
- Hooks belong to one Server instance: two Servers in one process (tests) never see each other's traffic.
- Handlers run **synchronously, in registration order**, on the Server's event loop. They cannot deny or change anything except the `schema_done` result. Keep them cheap; defer heavy work (flushing totals to a database) to a timer.
- A handler that throws is logged (`hook failed`, `hook=<name>`) and skipped; the Server and the other handlers carry on.
- When a hook has no handler the Server does not even build its argument: an un-extended Server pays nothing.

## 2. Catalog

| Hook                | Argument                                                          | When                                                                                                                                                                                           |
| :------------------ | :---------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_connected` | the `net.Socket`                                                  | A TCP connection is accepted, before any byte is read. Attach `data` listeners (bytes in) and read `bytesWritten` (bytes out) here.                                                            |
| `session_start`     | `{ sessionId, peerId, deviceId, role, mode }`                     | A session completed its handshake (peers and inspectors).                                                                                                                                      |
| `session_end`       | the same, plus `reason` (a close reason)                          | An authenticated session ended.                                                                                                                                                                |
| `frame_relayed`     | `{ type, channel?, from?, delivery, recipients, bytes }`          | A peer frame was written to `recipients` sessions; `bytes` is its encoded size, written once per recipient. Presence and system frames (`peer:joined`, `channel:stats`, ...) are not reported. |
| `frame_skipped`     | `{ sessionId, from? }`                                            | A recipient was not written because the sender listed it in `deliveredTo` (already reached over a WebRTC link).                                                                                |
| `frame_dropped`     | `{ sessionId, type, channel?, delivery: "ephemeral" \| "media" }` | A frame was dropped for one recipient under [backpressure](../3-subsystems/channels.md#6-backpressure).                                                                                        |
| `media_resync`      | `{ sessionId, from, channel? }`                                   | A media stream went out of sync for `sessionId` and its sender `from` was asked to resync.                                                                                                     |
| `schema_done`       | the `schema` overview object                                      | Before the inspector `schema` overview is sent: add fields to expose a plugin's figures to inspector tools.                                                                                    |

Traffic between peers over WebRTC links never reaches the Server, so no hook sees it.

## 3. Loading Plugins

A plugin is a module whose default export takes the Server and registers its hooks. The Docker image and `node src/server/main.ts` load every module listed in `P2P_PLUGINS` (comma-separated paths, relative to the working directory) before listening; a module without a default export function stops startup.

```bash
docker run -p 4444:4444 \
    -v ./plugins:/plugins:ro -e P2P_PLUGINS=/plugins/bandwidth.ts \
    fullstackedorg/p2p
```

Plugins run inside the Server with its privileges and see every session; load only code you trust. In-process embedders call `plugin(server)` themselves before `listen()`.

## 4. Example: Relay Diagnostics

[`examples/relay-stats.ts`](../../examples/relay-stats.ts) rebuilds the relay counters on hooks: `relayedFrames`, `relayedBytes`, `skippedByDeliveredTo`, `droppedEphemeral`, `droppedMediaChunks`, `mediaResyncs`, `closeReasons` and the last 50 closes. Through `schema_done` it adds them to the inspector `schema` overview as `stats` and `recentCloses`. Totals are per process and start at zero with it.

The test suites load it into every test Server (`relayOf(server)` in `test/helpers.ts`) to prove that frames between linked peers bypass the Server; `startServer({}, { bare: true })` starts one without it.

## 5. Test Contract

`test/hooks.test.ts`: a bare Server's `schema` has no relay counters while `storageBytes` stays; hooks see session start and end, relayed frames and the socket's bytes; unknown names throw, a throwing handler is isolated, a removed handler is no longer called; `P2P_PLUGINS` loads each module's default export and refuses a module without one.
