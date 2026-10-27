# @fullstacked/p2p

The client driver for **FullStacked P2P**: presence of every connected device, direct messages and request/reply, and channels that carry broadcasts, a persisted shared state, channel presence and audio/video to their subscribers only. Traffic goes peer-to-peer over WebRTC when both sides support it and through the server's TCP relay otherwise, with no change to your code.

> **This README documents the client driver**, the package your app installs. The complete documentation of FullStacked P2P (the server and its Docker image `fullstackedorg/p2p`, configuration, the wire protocol, architecture, development and testing) is in [`docs/`](https://github.com/fullstackedorg/p2p/blob/main/docs/README.md).

It runs in the **FullStacked runtime** (apps and CLI) and in **Node.js 24+**, and talks to a FullStacked P2P server.

```bash
npm install github:fullstackedorg/p2p   # straight from GitHub (main branch)
npm install @fullstacked/p2p            # from npm, once published
```

In a FullStacked project, list it in `package.json` and let the usual install, bundle, run flow fetch it:

```json
{ "dependencies": { "@fullstacked/p2p": "github:fullstackedorg/p2p" } }
```

```typescript
import { P2PClient, P2PError } from "@fullstacked/p2p";
```

The package ships its TypeScript sources with TSDoc on every export (your editor shows the documentation of each method, option, event and type), which FullStacked apps bundle directly, plus a plain JavaScript build (`dist/index.js`) that Node.js loads.

---

## Contents

- [Quick start](#quick-start)
- [Concepts](#concepts)
- [Connecting](#connecting)
- [Presence](#presence)
- [Channels](#channels)
- [Direct messages](#direct-messages)
- [Shared state](#shared-state)
- [Media](#media)
- [Events](#events)
- [Errors](#errors)
- [Recipes](#recipes) (including [monitors and bots](#monitors-and-bots))
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
    user, // decides the role; omit both on a server with no passwords
    password,
    peer: { id: currentUser.id, name: currentUser.name, meta: { color: "#0080ff" } },
});

p2p.on("peer:joined", (peer) => console.log(peer.name, "joined"));
p2p.getChannels(); // every channel, e.g. one per board: nothing is streamed yet

const board = await p2p.subscribe("board:A", { create: true });
board.on("message", (event) => console.log(event.from.name, event.data));
board.on("state:changed", ({ key, value, deleted }) => render(key, deleted ? undefined : value));

await board.broadcast({ type: "hello" });
await board.setState("title", "Untitled");
```

### In Node.js, against a local server

A server started with no configuration (`docker run -p 4444:4444 fullstackedorg/p2p`) accepts every client with full permissions, so no credentials are needed to tinker and test:

```typescript
import { P2PClient } from "@fullstacked/p2p";

const p2p = await P2PClient.connect({ host: "127.0.0.1", port: 4444 });
const viewer = await P2PClient.connect({ host: "127.0.0.1", port: 4444, user: "ro" }); // cannot create channels
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

- **Global presence.** Every client sees every device connected to the server, with the channels each one is subscribed to, and can message any of them directly.
- **Channels scope the streaming.** A channel (one board, one document, one call) holds a shared state, broadcasts, channel presence and media, and only its subscribers receive them. Subscribe to what is on screen: a list of boards subscribes to nothing and still shows every board and who is on it; an open board streams only that board.
- **A peer is one device of one user.** `peerId` is the user (set it to your user id); one user signed in on a laptop and a phone is **two peers with the same `peerId`**. `sessionId` identifies one connection (it changes on reconnect); `deviceId` identifies one client instance (kept across reconnects).
- **Roles.** The credentials decide the role. `rw` and `admin` create and delete channels; `ro` subscribes to existing channels only. Inside a channel everyone has the same rights.
- **Transports.** Each peer is reached over `"webrtc"` (a direct link, between devices that share a channel) or `"socket"` (relayed by the server). The driver picks per peer and per message; `transport` on events tells you which one was used.
- **Shared state** is a key-value map per channel that every subscriber holds a copy of. The server persists it, so late subscribers get it when they subscribe. Concurrent writes resolve by last-write-wins.

---

## Connecting

```typescript
const p2p = await P2PClient.connect(options);
```

Resolves when the client is connected, with the peer list and the channel list already loaded: `getActivePeers()` and `getChannels()` are usable right away. Rejects with a `P2PError` (`AUTH_FAILED`, `SERVER_FULL`, `TIMEOUT`, `DISCONNECTED`). The first connection is not retried; later drops are (see [reconnecting](#reconnecting-and-credential-refresh)).

| Option             | Default    | Description                                                                                                                                                                                                     |
| :----------------- | :--------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`             | _required_ | Server host: anything `node:net` can reach.                                                                                                                                                                     |
| `port`             | `4444`     | Server port.                                                                                                                                                                                                    |
| `user`, `password` | none       | Credentials; they decide the role. Optional against a Server with no password configured (open mode: everyone is `rw`, `user: "ro"` gives the role that cannot create channels).                                |
| `peer`             | `{}`       | `{ id?, name?, meta? }`. `id`: the user's identity, shared by all their devices (default: the sessionId). `name`: display name. `meta`: this device's global presence (any JSON object).                        |
| `deviceId`         | random     | This client instance, kept across its reconnects. Two live clients with the same `peer.id` **and** `deviceId` replace each other: leave the default unless you know each value is used by one client at a time. |
| `deviceLabel`      | detected   | A name people understand for this device (`"MacBook"`); default: the detected platform (`"macOS"`, `"iOS"`, `"Android"`, ...).                                                                                  |
| `webrtc`           | auto       | `false` forces socket-only. `{ iceServers }` overrides the STUN/TURN servers the server provides.                                                                                                               |
| `reconnect`        | `true`     | `false` to disable, or `{ initialDelayMs: 1000, maxDelayMs: 30000 }` (exponential backoff with jitter).                                                                                                         |
| `beforeConnect`    | none       | `async ({ attempt, reason }) => ({ host?, port?, user?, password? })`: called before the first connection and every reconnect; returned fields override the options.                                            |
| `connectTimeoutMs` | `10000`    | Connect plus handshake deadline per attempt.                                                                                                                                                                    |
| `requestTimeoutMs` | `10000`    | Default `request()` timeout.                                                                                                                                                                                    |
| `mode`             | `"peer"`   | `"inspect"`: an invisible session for tools and monitors: sees presence, subscribes and watches channels without appearing anywhere, writes through `query()`. See [monitors](#monitors-and-bots).              |

Properties: `p2p.sessionId`, `p2p.peerId`, `p2p.deviceId`, `p2p.deviceLabel`, `p2p.role` (`"admin" | "rw" | "ro"`), `p2p.capabilities` (`{ webrtc, media }`), `p2p.connected`, `p2p.self` (this session's `PeerInfo`).

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
p2p.getSubscribers("board:A"); // PeerInfo[]: the other devices subscribed to board:A
p2p.getSubscribers("board:A", { includeSelf: true }); // ... and this one, when subscribed
await p2p.updatePresence({ status: "busy" }, { name: "Alice" }); // replaces this device's meta
await p2p.updatePresence({ typing: true }, { merge: true }); // patches it (null removes a key)
```

`PeerInfo`:

```typescript
type PeerInfo = {
    peerId: string; // the user
    sessionId: string; // this connection (unique)
    deviceId: string; // this client instance
    deviceLabel: string; // "MacBook", "iPhone"... ("" when unknown)
    name: string;
    meta: Record<string, unknown>; // this device's global presence
    role: "admin" | "rw" | "ro";
    capabilities: { webrtc: boolean; media: boolean };
    channels: string[]; // the channels this device is subscribed to
    connectedAt: number; // epoch ms
};
```

- Global presence reaches everyone: keep `meta` small and slow-changing (a color, a status). Per-channel information (a viewport, a selection) goes in [channel presence](#channels).
- Key per-device things (cursors, selections) by `sessionId` and per-user things (avatars, "Alice is here") by `peerId`.
- `peer:updated` fires when a device changes its `meta` or `name`, or subscribes to or leaves a channel.
- **Who is in which room** needs no subscription: `peer.channels` lists each device's channels and `p2p.getSubscribers(id)` filters by channel. That is all a room list with live occupancy needs (see the [recipe](#a-list-of-boards-then-one-board)).
- After a network drop the same device comes back with a new `sessionId`: `peer:joined` then carries `{ replaces }`, the old one, so you can move what you keyed by it.

---

## Channels

```typescript
p2p.getChannels(); // ChannelInfo[]: { id, createdAt, createdBy, meta }, every channel on the server
p2p.on("channel:created", (info) => {});
p2p.on("channel:updated", ({ channel, by }) => {}); // channel: the new ChannelInfo
p2p.on("channel:deleted", ({ channel, by, sessionId, deviceId }) => {});

await p2p.createChannel("board:B", { meta: { title: "Roadmap" } }); // rw / admin
await p2p.updateChannelMeta("board:B", { title: "Roadmap 2027" }); // rw / admin; a patch
await p2p.deleteChannel("board:B"); // its creator or an admin; state and meta are gone
const { entries, stats } = await p2p.peek("board:A", { keys: ["thumb"] }); // read without subscribing

const board = await p2p.subscribe("board:A", { meta: { view: [0, 0, 800, 600] } });
await p2p.subscribe("board:C", { create: { meta: { title: "Ideas" } } }); // create when missing
const other = await p2p.subscribe("board:D", { replace: "board:A" }); // switch in one step
p2p.channel("board:D"); // the subscribed Channel, or undefined
await other.unsubscribe(); // stop receiving anything from board:D
```

`subscribe` resolves once the channel's subscribers and state are loaded, and rejects with `CHANNEL_NOT_FOUND` (missing, and no `create`), `FORBIDDEN` (`create` with `ro`), `CHANNEL_LIMIT` (16 channels per client by default), `INVALID_CHANNEL` (ids are 1–128 of `A-Z a-z 0-9 . _ : -`), `NOT_SUBSCRIBED` (`replace` names a channel you are not in). Subscribing to a channel already subscribed returns the same `Channel`.

- A channel's `meta` (up to 4 KiB of JSON) is for what a list shows: title, description, color. It lives and dies with the channel, so no separate directory is needed.
- `peek` returns one page of live entries (`keys`, `prefix`, `after`, `limit`) and the channel's `stats`: `keyCount`, `stateBytes`, `subscriberCount`, `lastWriteAt`, `lastWriteBy` ("edited 3 min ago"). It does not count toward the channel limit.
- `replace` leaves the old channel and joins the new one with a single `peer:updated`, so nobody sees you "nowhere" in between.

A `Channel`:

```typescript
board.id; // "board:A"
board.getSubscribers(); // Subscriber[]: { peer: PeerInfo, meta } for every other subscriber
board.getSubscribers({ includeSelf: true }); // ... and this device
await board.updatePresence({ view: [100, 0, 900, 600] }); // channel presence: subscribers only
await board.updatePresence({ tool: "pen" }, { merge: true }); // patch: keeps view
board.updatePresence({ cursor: [x, y] }, { merge: true, ephemeral: true }); // fast, no ack, may drop
await board.broadcast({ type: "stroke-end", id }); // every other subscriber
await board.broadcast({ x, y }, { ephemeral: true }); // high frequency: unordered, may drop, no ack

board.on("subscriber:joined", ({ peer, meta }, { replaces }) => {}); // replaces: same device, back
board.on("subscriber:updated", ({ peer, meta }) => {});
board.on("subscriber:left", ({ peer }, reason) => {});
board.on("message", (event) => {}); // broadcasts in this channel
board.on("closed", ({ reason, by }) => {}); // "unsubscribed" or "channel_deleted"
```

- While subscribed the channel survives reconnects: the client subscribes again on its own and fires events for whatever changed. If the channel was deleted meanwhile, `closed` fires with `"channel_deleted"`.
- Ephemeral presence is for values that change constantly (a cursor, a viewport while dragging): subscribers get it as fast as possible, a congested one may miss some, and the server keeps the latest for anyone who subscribes later. Send one regular `updatePresence` when the value settles so everyone ends with it.
- `subscriber:left` then `subscriber:joined` with `replaces` is the same device after a network drop, not a new arrival.
- Channels are about not receiving what you do not need, not about access control: any client can subscribe to any existing channel.

---

## Direct messages

`data` is any JSON value. A **target** is a `peerId` string or `{ peerId }` (every device of that user) or `{ sessionId }` (one device). Direct messages reach any peer, whatever its channels.

```typescript
await p2p.send("usr_bob", { text: "hi" }); // all of Bob's devices
await p2p.send({ sessionId }, { type: "nudge" }); // one device
await p2p.send(p2p.peerId, { type: "draft-saved" }); // my other devices

const answer = await p2p.request("usr_bob", { type: "ping" }, { timeoutMs: 5000 });

p2p.on("message", async (event) => {
    // event: { from, data, msgId, direct, ephemeral, transport, reply? }
    if (event.reply) await event.reply({ pong: true }); // requests only
});
```

| Method                                    | Resolves when                                                         | Rejects with                                                            |
| :---------------------------------------- | :-------------------------------------------------------------------- | :---------------------------------------------------------------------- |
| `channel.broadcast(data, { ephemeral? })` | Delivered over links and/or acknowledged by the server.               | `NOT_SUBSCRIBED`, `PAYLOAD_TOO_LARGE`, `DISCONNECTED`, `TIMEOUT`        |
| `send(target, data, { ephemeral? })`      | Same.                                                                 | `PEER_NOT_FOUND`, `PAYLOAD_TOO_LARGE`, `DISCONNECTED`                   |
| `request(target, data, { timeoutMs? })`   | The target answered with `event.reply(value)`: resolves with `value`. | `PEER_NOT_FOUND`, `PEER_LEFT`, `TIMEOUT`, `REPLY_ERROR`, `DISCONNECTED` |

- A `request` to a `peerId` goes to **one** device: that user's most recently connected one. To ask every device, call `request` once per `getPeers(peerId)` entry with `{ sessionId }`.
- A request handler that throws, or calls `event.reply(new Error("..."))`, makes the requester reject with `REPLY_ERROR` (the message is kept).
- Nothing is echoed to the sending session. Your other devices receive your sends and, in the channels they are subscribed to, your broadcasts like any peer (`event.from.peerId === p2p.peerId`).

---

## Shared state

Each channel has its own state.

```typescript
board.getState(); // { [key]: value } of every live key
board.getState("shape:1"); // one value, or undefined

const { applied } = await board.setState("shape:1", { x: 10, y: 20 });
await board.deleteState("shape:1");
await board.setStates({ "shape:2": { x: 1 }, "shape:3": { x: 2 } }); // one frame, up to 1 000 keys
await board.deleteStates(["shape:2", "shape:3"]);
const { count } = await board.clearState(); // or clearState({ prefix: "shape:" })

board.on("state:changed", ({ key, value, deleted, updatedBy, sessionId, deviceId, local }) => {});
board.on("state:cleared", ({ updatedBy, sessionId, deviceId, prefix, local }) => {});
```

- Writes apply locally first (`state:changed` fires with `local: true`), then go to the other subscribers and to the server, which persists them. The Promise resolves when the server accepted the write.
- `applied: false` means a concurrent newer write won; your copy already shows the winner (another `state:changed` fired).
- `updatedBy` is the writer's `peerId`; `sessionId` and `deviceId` tell its devices apart.
- `setStates` / `deleteStates` are applied by the server whole or not at all, then each key by last-write-wins: they resolve with `{ [key]: { applied } }`.
- Keys are strings of 1–256 characters; values are any JSON value. Use key prefixes for collections (`shape:<id>`).
- On reconnect the copy is rebuilt from the server and `state:changed` fires for every key that changed meanwhile.
- Writes while disconnected reject with `DISCONNECTED`; there is no offline queue.

---

## Media

FullStacked apps only (`p2p.capabilities.media`). Media is shared in a channel, with its subscribers.

```typescript
const call = await p2p.subscribe("call:standup", { create: true });
const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
await call.shareMedia(stream); // one stream per channel; calling again replaces it
await call.stopMedia();

call.on("media", ({ peer, stream, transport }) => {
    videoFor(peer.sessionId).srcObject = stream; // always attach the latest stream per peer
});
call.on("media:ended", ({ peer }) => removeVideo(peer.sessionId));
```

Over a link the stream is a real WebRTC track. Subscribers that cannot link receive it rebuilt from recorded chunks relayed by the server (`transport: "socket"`, about 0.3–0.8 s of latency, 250 kbps). Node.js and FullStacked CLI clients get `UNSUPPORTED` and never receive media.

---

## Events

`p2p.on(event, listener)` and `channel.on(event, listener)`: listeners are typed (`P2PClientEvents`, `ChannelEvents`).

On the client:

| Event               | Listener arguments                        | When                                                                                       |
| :------------------ | :---------------------------------------- | :----------------------------------------------------------------------------------------- |
| `peer:joined`       | `(peer: PeerInfo, { replaces?: string })` | A device connected. `replaces`: the sessionId this device had before reconnecting.         |
| `peer:updated`      | `(peer: PeerInfo)`                        | A device changed its presence or its channels.                                             |
| `peer:left`         | `(peer: PeerInfo, reason: CloseReason)`   | A device left (`client_close`, `connection_lost`, `session_replaced`, ...).                |
| `channel:created`   | `(info: ChannelInfo)`                     | A channel was created.                                                                     |
| `channel:updated`   | `({ channel, by, sessionId, deviceId })`  | A channel's `meta` changed (`channel` is the new `ChannelInfo`).                           |
| `channel:deleted`   | `({ channel, by, sessionId, deviceId })`  | A channel was deleted.                                                                     |
| `message`           | `(event: MessageEvent)`                   | A `send` or `request` from another peer.                                                   |
| `transport:changed` | `({ peer, transport })`                   | A peer switched between `"webrtc"` and `"socket"`.                                         |
| `disconnected`      | `({ reason })`                            | The connection dropped; the client is reconnecting. Pending calls rejected `DISCONNECTED`. |
| `reconnected`       | `({ sessionId })`                         | Back with a new sessionId (same `peerId` and `deviceId`), channels subscribed again.       |
| `role:changed`      | `({ role, previous })`                    | A reconnect came back with another role.                                                   |
| `close`             | `({ reason })`                            | Final: `close()` was called or the session cannot continue (e.g. `session_replaced`).      |
| `error`             | `(error: P2PError)`                       | Non-fatal problems with no Promise to reject. Optional to listen to.                       |

On a channel:

| Event                | Listener arguments                  | When                                                       |
| :------------------- | :---------------------------------- | :--------------------------------------------------------- |
| `subscriber:joined`  | `(sub, { replaces? })`              | A device subscribed (`replaces`: it is back after a drop). |
| `subscriber:updated` | `(sub: Subscriber)`                 | A subscriber changed its channel presence.                 |
| `subscriber:left`    | `(sub: Subscriber, reason: string)` | `"unsubscribed"` or the close reason of its connection.    |
| `message`            | `(event: MessageEvent)`             | A broadcast in this channel (`event.channel` is its id).   |
| `state:changed`      | `(change: StateChange)`             | A key changed, locally or remotely.                        |
| `state:cleared`      | `(info: StateCleared)`              | `clearState` ran (each key also fired `state:changed`).    |
| `media`              | `({ peer, stream, transport })`     | A subscriber's shared stream is available.                 |
| `media:ended`        | `({ peer })`                        | A subscriber stopped sharing.                              |
| `closed`             | `({ reason, by? })`                 | `"unsubscribed"`, or `"channel_deleted"` (by `by`).        |

---

## Errors

Every rejection is a `P2PError`; switch on `err.code`:

```typescript
try {
    await p2p.createChannel("board:new");
} catch (err) {
    if (err instanceof P2PError && err.code === "FORBIDDEN") showToast("You cannot create boards");
    else throw err;
}
```

| Code                | Meaning                                                                                                                                           |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHANNEL_NOT_FOUND` | The channel does not exist (subscribe without `create`, or a query).                                                                              |
| `NOT_SUBSCRIBED`    | The channel is no longer subscribed (unsubscribed, or deleted).                                                                                   |
| `INVALID_CHANNEL`   | The channel id is not 1–128 characters of `A-Z a-z 0-9 . _ : -`.                                                                                  |
| `CHANNEL_LIMIT`     | Too many channels: subscribed by this client, or on the server.                                                                                   |
| `FORBIDDEN`         | `ro` creating a channel or changing its meta, deleting a channel you did not create (and not `admin`), or an inspector session trying to publish. |
| `PEER_NOT_FOUND`    | No peer matches the target.                                                                                                                       |
| `PEER_LEFT`         | The target of a pending `request` left.                                                                                                           |
| `TIMEOUT`           | No answer in time (`request`, connect, acknowledgement).                                                                                          |
| `REPLY_ERROR`       | The other side's request handler failed; `err.message` is its message.                                                                            |
| `PAYLOAD_TOO_LARGE` | The message or value exceeds the server's frame limit (1 MiB by default).                                                                         |
| `STATE_TOO_LARGE`   | The server's state storage limit would be exceeded.                                                                                               |
| `INVALID_ARGUMENT`  | Bad input (e.g. empty key, key over 256 characters, `reply` called twice).                                                                        |
| `DISCONNECTED`      | Not connected, or the connection dropped before the answer.                                                                                       |
| `UNSUPPORTED`       | Media in an environment without media APIs.                                                                                                       |
| `AUTH_FAILED`       | Wrong credentials.                                                                                                                                |
| `SERVER_FULL`       | The server has no free connection slot.                                                                                                           |
| `SESSION_REPLACED`  | Another client connected with the same `peer.id` and `deviceId`.                                                                                  |
| `CLOSED`            | The client was closed.                                                                                                                            |

---

## Recipes

### A list of boards, then one board

```typescript
// list screen: subscribed to nothing
function renderList() {
    const boards = p2p.getChannels().filter((c) => c.id.startsWith("board:"));
    showBoards(
        boards.map((c) => ({
            id: c.id,
            title: c.meta.title ?? c.id,
            people: p2p.getSubscribers(c.id, { includeSelf: true }),
        }))
    );
}
for (const e of [
    "channel:created",
    "channel:updated",
    "channel:deleted",
    "peer:joined",
    "peer:updated",
    "peer:left",
] as const)
    p2p.on(e, renderList);

// board screen: stream that board only
async function openBoard(id: string) {
    const board = await p2p.subscribe(id);
    for (const [key, shape] of Object.entries(board.getState())) draw(key, shape);
    board.on("state:changed", ({ key, value, deleted }) =>
        deleted ? erase(key) : draw(key, value)
    );
    board.on("closed", () => backToList());
    return () => board.unsubscribe(); // when leaving the screen
}
```

### Live cursors in a channel, one per device

```typescript
const cursors = new Map<string, Cursor>();

for (const { peer } of board.getSubscribers()) cursors.set(peer.sessionId, createCursor(peer));
board.on("subscriber:joined", ({ peer }) => cursors.set(peer.sessionId, createCursor(peer)));
board.on("subscriber:left", ({ peer }) => {
    cursors.get(peer.sessionId)?.remove();
    cursors.delete(peer.sessionId);
});
board.on("subscriber:updated", ({ peer, meta }) => cursors.get(peer.sessionId)?.move(meta.cursor));

window.addEventListener("pointermove", (e) => {
    // fast path while moving; late joiners still get the last position
    board.updatePresence({ cursor: [e.clientX, e.clientY] }, { merge: true, ephemeral: true });
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

### Users who cannot create channels

```typescript
newBoardButton.hidden = p2p.role === "ro";
p2p.on("role:changed", ({ role }) => (newBoardButton.hidden = role === "ro"));
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

### Monitors and bots

An inspector session sees everything a peer sees and never shows up in anyone's presence: nobody has to filter it out.

```typescript
const monitor = await P2PClient.connect({ host, user, password, mode: "inspect" });
const rooms = await monitor.watch("room:"); // every room:* channel, now and later
rooms.on("activity", (a) => {
    if (a.type === "subscriber:joined") log(a.channel, a.subscriber.peer.name, "joined");
    if (a.type === "state:changed") log(a.channel, a.change.key, "by", a.change.deviceId);
    if (a.type === "message") log(a.channel, a.event.data);
});
const lobby = await monitor.subscribe("lobby"); // a full Channel (state, subscribers), read-only
```

Watches and subscriptions of an inspector are not limited to 16 and are renewed after reconnects. A watch carries no state: read it with `peek`. An inspector writes through `query`.

### One-off reads and writes (scripts, tools)

```typescript
const tool = await P2PClient.connect({ host, user, password, mode: "inspect" }); // invisible
const schema = await tool.getSchema(); // peers, channels, storage, limits, counters
const board = await tool.getSchema("board:A"); // one channel: subscribers, keys
const page = await tool.query({
    operation: "getState",
    channel: "board:A",
    prefix: "shape:",
    limit: 100,
});
await tool.query({ operation: "setState", channel: "settings", key: "theme", value: "dark" });
await tool.close();
```

`query` runs on any session, inspector or peer. Operations: `peers` (`peerId?`, `channel?`), `channels` (`prefix?`), `createChannel` (`channel`, `meta?`; rw / admin), `updateChannel` (`channel`, `meta`; rw / admin), `deleteChannel` (`channel`; creator / admin), `getState` (`channel`, `key?`, `keys?`, `prefix?`, `limit?`, `after?` → `{ entries, next?, stats }`), `setState` (`channel`, `key`, `value`), `deleteState` (`channel`, `key`), `clearState` (`channel`, `prefix?`), `broadcast` (`channel`, `data`), `send` (`to`, `data`).

---

## Rules and limits

- One `P2PClient` per app instance (per browser tab). Do not share a fixed `deviceId` between tabs.
- Register channel listeners right after `subscribe()`: events that arrive before a listener exists are not replayed (the current state is always readable with `getState()`).
- Unsubscribe from channels the user left: a subscribed channel keeps streaming.
- Messages and state values must be JSON-serializable. The server's frame limit is 1 MiB by default; keep messages small and put large data elsewhere.
- `ephemeral` messages are for values superseded by the next one (cursor positions, live strokes). They may be dropped and arrive out of order; never use them for anything that must arrive.
- Ordering is guaranteed per transport, not across a switch between `"socket"` and `"webrtc"`. If you need strict ordering, add your own sequence numbers; shared state does not need them.
- A message sent over a link that fails at that moment may be lost (`request` then rejects with `TIMEOUT`). State writes always reach the server.

Server, configuration, protocol and development: [docs/](https://github.com/fullstackedorg/p2p/blob/main/docs/README.md).
