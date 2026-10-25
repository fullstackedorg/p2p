# @fullstacked/p2p

The client driver for **FullStacked P2P**: presence, direct messages, request/reply, broadcasts, a persisted shared state and audio/video between the peers of one room. Traffic goes peer-to-peer over WebRTC when both sides support it and through the server's TCP relay otherwise, with no change to your code.

It runs in the **FullStacked runtime** (apps and CLI) and in **Node.js 24+**. It talks to a FullStacked P2P server (Docker image `fullstackedorg/p2p`, see the [repository](https://github.com/fullstackedorg/p2p)).

```bash
npm install @fullstacked/p2p
```

```typescript
import { P2PClient, P2PError } from "@fullstacked/p2p";
```

The package ships TypeScript sources with TSDoc on every export: your editor shows the documentation of each method, option, event and type.

---

## Contents

- [Quick start](#quick-start)
- [Concepts](#concepts)
- [Connecting](#connecting)
- [Presence](#presence)
- [Messaging](#messaging)
- [Shared state](#shared-state)
- [Media](#media)
- [Events](#events)
- [Errors](#errors)
- [Recipes](#recipes)
- [Rules and limits](#rules-and-limits)

---

## Quick start

### In a FullStacked project

The driver connects with `node:net`, which the FullStacked runtime provides in apps and in the CLI: give it the server's host and port. Take the host, port and credentials from your project's configuration; never hardcode them.

```typescript
import { P2PClient } from "@fullstacked/p2p";

const p2p = await P2PClient.connect({
    host, // any host the runtime's node:net can reach
    port, // default 4444
    user, // decides the role (read-write or read-only); omit both on a server with no passwords
    password,
    peer: { id: currentUser.id, name: currentUser.name, meta: { color: "#0080ff" } },
});

p2p.on("peer:joined", (peer) => console.log(peer.name, "joined"));
p2p.on("message", (event) => console.log(event.from.name, event.data));
p2p.on("state:changed", ({ key, value, deleted }) => render(key, deleted ? undefined : value));

await p2p.broadcast({ type: "hello" });
await p2p.setState("doc:title", "Untitled");
```

### In Node.js, against a local server

A server started with no configuration (`docker run -p 4444:4444 fullstackedorg/p2p`) accepts every client with full permissions, so no credentials are needed to tinker and test:

```typescript
import { P2PClient } from "@fullstacked/p2p";

const p2p = await P2PClient.connect({ host: "127.0.0.1", port: 4444 });
const viewer = await P2PClient.connect({ host: "127.0.0.1", port: 4444, user: "ro" }); // read-only
```

Secured servers (live environments) need `user` and `password`.

### Where it runs

| Environment                                | Control socket             | WebRTC links | Media (`shareMedia`) |
| :----------------------------------------- | :------------------------- | :----------- | :------------------- |
| FullStacked app (webview)                  | `node:net` via the runtime | yes          | yes                  |
| FullStacked CLI (`fullstacked -f`)         | `node:net` via the runtime | no           | no (`UNSUPPORTED`)   |
| Node.js 24+                                | native `node:net`          | no           | no (`UNSUPPORTED`)   |
| Plain web browser (no FullStacked runtime) | not supported              |              |                      |

Without WebRTC a client is **socket-only**: everything except media works the same, relayed by the server. `p2p.capabilities` tells you which case you are in.

---

## Concepts

- **One server, one room.** Everyone connected to a server is in the same room. Separate rooms are separate servers.
- **A peer is one device of one user.** `peerId` is the user (set it to your user id); one user signed in on a laptop and a phone is **two peers with the same `peerId`**. `sessionId` identifies one connection (it changes on reconnect); `deviceId` identifies one client instance (kept across reconnects).
- **Roles.** The credentials decide the role: `rw` (read-write), `ro` (spectator: receives everything, publishes nothing) or `admin` (same as `rw`).
- **Transports.** Each peer is reached over `"webrtc"` (a direct link) or `"socket"` (relayed by the server). The driver picks per peer and per message; `transport` on events tells you which one was used.
- **Shared state** is a key-value map every peer holds a copy of. The server persists it, so late joiners get it on connect. Concurrent writes resolve by last-write-wins.

---

## Connecting

```typescript
const p2p = await P2PClient.connect(options);
```

Resolves when the client is in the room, with the peer list and the state already loaded: `getActivePeers()` and `getState()` are usable right away. Rejects with a `P2PError` (`AUTH_FAILED`, `SERVER_FULL`, `TIMEOUT`, `DISCONNECTED`). The first connection is not retried; later drops are (see [reconnecting](#reconnecting-and-credential-refresh)).

| Option             | Default    | Description                                                                                                                                                                                                     |
| :----------------- | :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`             | _required_ | Server host: anything `node:net` can reach.                                                                                                                                                                     |
| `port`             | `4444`     | Server port.                                                                                                                                                                                                    |
| `user`, `password` | none       | Credentials; they decide the role. Optional against a Server with no password configured (open mode: everyone is `rw`, `user: "ro"` gives read-only).                                                           |
| `peer`             | `{}`       | `{ id?, name?, meta? }`. `id`: the user's identity, shared by all their devices (default: the sessionId). `name`: display name. `meta`: this device's presence (any JSON object).                               |
| `deviceId`         | random     | This client instance, kept across its reconnects. Two live clients with the same `peer.id` **and** `deviceId` replace each other: leave the default unless you know each value is used by one client at a time. |
| `webrtc`           | auto       | `false` forces socket-only. `{ iceServers }` overrides the STUN/TURN servers the server provides.                                                                                                               |
| `reconnect`        | `true`     | `false` to disable, or `{ initialDelayMs: 1000, maxDelayMs: 30000 }` (exponential backoff with jitter).                                                                                                         |
| `beforeConnect`    | none       | `async ({ attempt, reason }) => ({ host?, port?, user?, password? })`: called before the first connection and every reconnect; returned fields override the options.                                            |
| `connectTimeoutMs` | `10000`    | Connect plus handshake deadline per attempt.                                                                                                                                                                    |
| `requestTimeoutMs` | `10000`    | Default `request()` timeout.                                                                                                                                                                                    |
| `mode`             | `"peer"`   | `"inspect"`: an invisible session that only runs `getSchema()` and `query()` (tools, data explorers).                                                                                                           |

Properties: `p2p.sessionId`, `p2p.peerId`, `p2p.deviceId`, `p2p.role` (`"admin" | "rw" | "ro"`), `p2p.capabilities` (`{ webrtc, media }`), `p2p.connected`, `p2p.self` (this session's `PeerInfo`).

```typescript
await p2p.close(); // leave cleanly (peers see reason "client_close"); no reconnect
```

---

## Presence

```typescript
p2p.getActivePeers(); // PeerInfo[]: every other peer, one per device (your other devices included)
p2p.getPeers("usr_bob"); // PeerInfo[]: all of Bob's devices
p2p.getPeers(p2p.peerId); // my other devices (never this session)
p2p.getPeer(sessionId); // PeerInfo | undefined
await p2p.updatePresence({ color: "#10b981", tool: "pen" }, { name: "Alice" }); // replaces meta
```

`PeerInfo`:

```typescript
type PeerInfo = {
    peerId: string; // the user
    sessionId: string; // this connection (unique)
    deviceId: string; // this client instance
    name: string;
    meta: Record<string, unknown>; // this device's presence
    role: "admin" | "rw" | "ro";
    capabilities: { webrtc: boolean; media: boolean };
    connectedAt: number; // epoch ms
};
```

Key per-device things (cursors, selections) by `sessionId` and per-user things (avatars, "Alice is here") by `peerId`.

---

## Messaging

`data` is any JSON value. A **target** is a `peerId` string or `{ peerId }` (every device of that user) or `{ sessionId }` (one device).

```typescript
await p2p.broadcast({ type: "stroke-end", id }); // every other peer
await p2p.broadcast({ x, y }, { ephemeral: true }); // high frequency: unordered, may drop, no ack
await p2p.send("usr_bob", { text: "hi" }); // all of Bob's devices
await p2p.send({ sessionId }, { type: "nudge" }); // one device
await p2p.send(p2p.peerId, { type: "draft-saved" }); // my other devices

const answer = await p2p.request("usr_bob", { type: "ping" }, { timeoutMs: 5000 });

p2p.on("message", async (event) => {
    // event: { from, data, msgId, direct, ephemeral, transport, reply? }
    if (event.reply) await event.reply({ pong: true }); // requests only
});
```

| Method                                  | Resolves when                                                         | Rejects with                                                                                             |
| :-------------------------------------- | :-------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------- |
| `broadcast(data, { ephemeral? })`       | Delivered over links and/or acknowledged by the server.               | `READ_ONLY`, `PAYLOAD_TOO_LARGE`, `DISCONNECTED`, `TIMEOUT`                                              |
| `send(target, data, { ephemeral? })`    | Same.                                                                 | `READ_ONLY`, `PEER_NOT_FOUND`, `PAYLOAD_TOO_LARGE`, `DISCONNECTED`                                       |
| `request(target, data, { timeoutMs? })` | The target answered with `event.reply(value)`: resolves with `value`. | `READ_ONLY`, `TARGET_READ_ONLY`, `PEER_NOT_FOUND`, `PEER_LEFT`, `TIMEOUT`, `REPLY_ERROR`, `DISCONNECTED` |

- A `request` to a `peerId` goes to **one** device: that user's most recently connected one. To ask every device, call `request` once per `getPeers(peerId)` entry with `{ sessionId }`.
- A request handler that throws, or calls `event.reply(new Error("..."))`, makes the requester reject with `REPLY_ERROR` (the message is kept).
- Nothing is echoed to the sending session. Your other devices receive your broadcasts like any peer (`event.from.peerId === p2p.peerId`).
- Spectators (`ro`) cannot send, broadcast or request, and cannot be asked (`TARGET_READ_ONLY`).

---

## Shared state

```typescript
p2p.getState(); // { [key]: value } of every live key
p2p.getState("shape:1"); // one value, or undefined

const { applied } = await p2p.setState("shape:1", { x: 10, y: 20 });
await p2p.deleteState("shape:1");
const { count } = await p2p.clearState();

p2p.on("state:changed", ({ key, value, deleted, updatedBy, local, transport }) => {});
p2p.on("state:cleared", ({ updatedBy, local }) => {});
```

- Writes apply locally first (`state:changed` fires with `local: true`), then go to the other peers and to the server, which persists them. The Promise resolves when the server accepted the write.
- `applied: false` means a concurrent newer write won; your copy already shows the winner (another `state:changed` fired).
- Keys are strings of 1–256 characters; values are any JSON value. Use key prefixes for collections (`shape:<id>`).
- On reconnect the copy is rebuilt from the server and `state:changed` fires for every key that changed meanwhile.
- Writes while disconnected reject with `DISCONNECTED`; there is no offline queue.

---

## Media

FullStacked apps only (`p2p.capabilities.media`).

```typescript
const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
await p2p.shareMedia(stream); // one stream per client; calling again replaces it
await p2p.stopMedia();

p2p.on("peer:media", ({ peer, stream, transport }) => {
    videoFor(peer.sessionId).srcObject = stream; // always attach the latest stream per peer
});
p2p.on("peer:media:ended", ({ peer }) => removeVideo(peer.sessionId));
```

Over a link the stream is a real WebRTC track. Peers that cannot link receive it rebuilt from recorded chunks relayed by the server (`transport: "socket"`, about 0.3–0.8 s of latency, 250 kbps). Node.js and FullStacked CLI clients get `UNSUPPORTED` and never receive media.

---

## Events

`p2p.on(event, listener)`: listeners are typed (`P2PClientEvents`).

| Event               | Listener arguments                        | When                                                                                       |
| :------------------ | :---------------------------------------- | :----------------------------------------------------------------------------------------- |
| `peer:joined`       | `(peer: PeerInfo, { replaces?: string })` | A device joined. `replaces`: the sessionId this device had before reconnecting.            |
| `peer:updated`      | `(peer: PeerInfo)`                        | A device called `updatePresence`.                                                          |
| `peer:left`         | `(peer: PeerInfo, reason: CloseReason)`   | A device left (`client_close`, `connection_lost`, `session_replaced`, ...).                |
| `message`           | `(event: MessageEvent)`                   | A `broadcast`, `send` or `request` from another peer.                                      |
| `state:changed`     | `(change: StateChange)`                   | A key changed, locally or remotely.                                                        |
| `state:cleared`     | `({ updatedBy, local })`                  | `clearState` ran (each key also fired `state:changed`).                                    |
| `transport:changed` | `({ peer, transport })`                   | A peer switched between `"webrtc"` and `"socket"`.                                         |
| `peer:media`        | `({ peer, stream, transport })`           | A peer's shared stream is available.                                                       |
| `peer:media:ended`  | `({ peer })`                              | A peer stopped sharing.                                                                    |
| `disconnected`      | `({ reason })`                            | The connection dropped; the client is reconnecting. Pending calls rejected `DISCONNECTED`. |
| `reconnected`       | `({ sessionId })`                         | Back in the room with a new sessionId (same `peerId` and `deviceId`).                      |
| `role:changed`      | `({ role, previous })`                    | A reconnect came back with another role.                                                   |
| `close`             | `({ reason })`                            | Final: `close()` was called or the session cannot continue (e.g. `session_replaced`).      |
| `error`             | `(error: P2PError)`                       | Non-fatal problems with no Promise to reject. Optional to listen to.                       |

---

## Errors

Every rejection is a `P2PError`; switch on `err.code`:

```typescript
try {
    await p2p.setState("doc", value);
} catch (err) {
    if (err instanceof P2PError && err.code === "READ_ONLY") showToast("View-only access");
    else throw err;
}
```

| Code                | Meaning                                                                    |
| :------------------ | :------------------------------------------------------------------------- |
| `READ_ONLY`         | This client is a spectator (`ro`) and the call publishes or writes.        |
| `TARGET_READ_ONLY`  | `request` to a spectator, which cannot reply.                              |
| `PEER_NOT_FOUND`    | No peer matches the target.                                                |
| `PEER_LEFT`         | The target of a pending `request` left.                                    |
| `TIMEOUT`           | No answer in time (`request`, connect, acknowledgement).                   |
| `REPLY_ERROR`       | The other side's request handler failed; `err.message` is its message.     |
| `PAYLOAD_TOO_LARGE` | The message or value exceeds the server's frame limit (1 MiB by default).  |
| `STATE_TOO_LARGE`   | The server's state storage limit would be exceeded.                        |
| `INVALID_ARGUMENT`  | Bad input (e.g. empty key, key over 256 characters, `reply` called twice). |
| `DISCONNECTED`      | Not connected, or the connection dropped before the answer.                |
| `UNSUPPORTED`       | Media in an environment without media APIs.                                |
| `AUTH_FAILED`       | Wrong credentials.                                                         |
| `SERVER_FULL`       | The server has no free connection slot.                                    |
| `SESSION_REPLACED`  | Another client connected with the same `peer.id` and `deviceId`.           |
| `FORBIDDEN`         | An inspector session (`mode: "inspect"`) tried a peer operation.           |
| `CLOSED`            | The client was closed.                                                     |

---

## Recipes

### Live cursors, one per device

```typescript
const cursors = new Map<string, Cursor>();

p2p.on("peer:joined", (peer, { replaces }) => {
    const existing = replaces ? cursors.get(replaces) : undefined;
    if (replaces) cursors.delete(replaces);
    cursors.set(peer.sessionId, existing ?? createCursor(peer)); // same device after a reconnect
});
p2p.on("peer:left", (peer) => {
    cursors.get(peer.sessionId)?.remove();
    cursors.delete(peer.sessionId);
});
p2p.on("message", ({ from, data }) => {
    if ((data as any)?.type === "cursor") cursors.get(from.sessionId)?.move(data);
});

window.addEventListener("pointermove", (e) => {
    if (p2p.role !== "ro")
        p2p.broadcast({ type: "cursor", x: e.clientX, y: e.clientY }, { ephemeral: true });
});
```

### Avatars, one per user

```typescript
function users() {
    const byUser = new Map<string, PeerInfo[]>();
    for (const peer of p2p.getActivePeers()) {
        byUser.set(peer.peerId, [...(byUser.get(peer.peerId) ?? []), peer]);
    }
    return byUser; // peerId -> devices
}
for (const e of ["peer:joined", "peer:left", "peer:updated"] as const)
    p2p.on(e, () => renderAvatars(users()));
```

### A shared document

```typescript
for (const [key, shape] of Object.entries(p2p.getState()))
    if (key.startsWith("shape:")) draw(key, shape);

p2p.on("state:changed", ({ key, value, deleted }) => {
    if (!key.startsWith("shape:")) return;
    deleted ? erase(key) : draw(key, value);
});

async function moveShape(id: string, x: number, y: number) {
    await p2p.setState(`shape:${id}`, { ...(p2p.getState(`shape:${id}`) as object), x, y });
}
```

### Read-only users

```typescript
const readOnly = p2p.role === "ro";
toolbar.disabled = readOnly;
p2p.on("role:changed", ({ role }) => (toolbar.disabled = role === "ro"));
```

### Reconnecting and credential refresh

Drops are retried automatically; pending calls reject with `DISCONNECTED`. When credentials or connection details can change while the app runs (access withdrawn, password rotated, server moved), refresh them before each reconnect:

```typescript
const p2p = await P2PClient.connect({
    host,
    user,
    password,
    peer: { id: userId },
    beforeConnect: async ({ attempt }) => {
        if (attempt === 0) return {};
        const c = await loadCurrentConnection(); // your configuration source
        return { host: c.host, port: c.port, user: c.user, password: c.password };
    },
});
p2p.on("disconnected", () => showBanner("Reconnecting..."));
p2p.on("reconnected", () => hideBanner());
p2p.on("close", ({ reason }) => showBanner(`Disconnected (${reason})`));
```

With `beforeConnect`, a failed authentication on a reconnect is retried too.

### One-off reads and writes (scripts, tools)

```typescript
const tool = await P2PClient.connect({ host, user, password, mode: "inspect" }); // invisible
const schema = await tool.getSchema(); // peers, links, state keys, storage, limits
const page = await tool.query({ operation: "getState", prefix: "shape:", limit: 100 });
await tool.query({ operation: "setState", key: "config:theme", value: "dark" }); // rw/admin only
await tool.close();
```

`query` operations: `peers` (`peerId?`), `getState` (`key?`, `prefix?`, `limit?`, `after?` → `{ entries, next? }`), `setState` (`key`, `value`), `deleteState` (`key`), `clearState` (`prefix?`), `broadcast` (`data`), `send` (`to`, `data`).

---

## Rules and limits

- One `P2PClient` per app instance (per browser tab). Do not share a fixed `deviceId` between tabs.
- Register `message` and `state:changed` listeners right after `connect()`: events that arrive before a listener exists are not replayed (the current state is always readable with `getState()`).
- Messages and state values must be JSON-serializable. The server's frame limit is 1 MiB by default; keep messages small and put large data elsewhere.
- `ephemeral` messages are for values superseded by the next one (cursor positions, live strokes). They may be dropped and arrive out of order; never use them for anything that must arrive.
- Ordering is guaranteed per transport, not across a switch between `"socket"` and `"webrtc"`. If you need strict ordering, add your own sequence numbers; shared state does not need them.
- A message sent over a link that fails at that moment may be lost (`request` then rejects with `TIMEOUT`). State writes always reach the server.
- Spectators (`ro`) receive everything; check `p2p.role` to hide write controls.

Full protocol and server documentation: [github.com/fullstackedorg/p2p](https://github.com/fullstackedorg/p2p).
