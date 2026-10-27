# Wire Protocol Specification

```mermaid
flowchart TD
    subgraph Conn["Control socket (node:net, TCP_NODELAY)"]
        TCP["TCP connect"] --> Pre{"First frame\n(within 10 s)"}
        Pre -->|"health"| Health["health { ok: true }, then close"]
        Pre -->|"auth"| Verify{"Credentials & mode"}
        Pre -->|"other / malformed"| CInvalid["close invalid_frame"]
        Pre -->|"none in 10 s"| CTimeout["close auth_timeout"]
        Verify -->|"server full"| CFull["close server_full"]
        Verify -->|"bad credentials / role disabled"| CAuth["close auth_failed"]
        Verify -->|"ok"| Connected["connected { sessionId, role, peers, channels }\n(global presence, no channel yet)"]
        Connected --> Global["Global frames\n(presence, send, request, reply, signal, link,\nschema, query, ping)"]
        Connected --> Channels["subscribe / unsubscribe channel"]
        Channels --> Scoped["Channel frames\n(channel:presence, broadcast, state:*, media:*)"]
        Global -->|"frame > P2P_MAX_PAYLOAD_BYTES"| CPayload["close payload_too_large"]
        Global -->|"silence > heartbeat timeout"| CHb["close heartbeat_timeout"]
        Global -->|"same peerId + deviceId joins"| CRep["close session_replaced"]
        Global -->|"bye"| CBye["close client_close"]
    end

    subgraph Link["Link (RTCPeerConnection), between devices sharing a channel"]
        Rel["p2p-reliable: ordered"]
        Eph["p2p-ephemeral: unordered, maxRetransmits 0"]
        Media["media tracks (addTrack)"]
    end
```

This document is the normative reference for everything that crosses a network boundary: framing, the handshake, every frame type, error codes, close reasons, limits and timeouts. This is protocol **version 4**. Terms are defined in the [Glossary](glossary.md).

Two scopes:

- **Global**: presence (every connected device, with the channels it is subscribed to), direct messages and requests, signaling, inspection. Every session sees it from the moment it connects.
- **Channel**: shared state, broadcasts (including ephemeral ones such as cursors), per-channel presence and media. Only the channel's subscribers receive them. A session subscribes to the channels it needs and receives nothing from the others.

---

## 1. Framing

Every frame on a control socket is:

```
+----------------------+-------------------------------+
| length: UInt32BE (4) | payload: UTF-8 JSON (length)  |
+----------------------+-------------------------------+
```

- `length` counts payload bytes only. `0` is invalid.
- The payload is one JSON object with a string `type`.
- A frame whose `length` exceeds `P2P_MAX_PAYLOAD_BYTES` (default 1 MiB) is fatal: the Server sends `close { reason: "payload_too_large" }` and ends the socket without reading the payload. The Client checks the encoded size before sending and rejects the call with `PAYLOAD_TOO_LARGE` instead.
- A payload that is not valid JSON, has no string `type`, or has an unknown `type` closes the socket with `invalid_frame`.
- On links, each frame is one DataChannel string message containing the same JSON object, without the length prefix.

The codec is described in [Codec](../3-subsystems/codec.md).

## 2. Handshake

### 2.1 `auth` (Client → Server)

The first frame on a socket, sent within 10 seconds of connecting:

```json
{
    "type": "auth",
    "reqId": 1,
    "version": 4,
    "user": "rw",
    "password": "secret",
    "mode": "peer",
    "peer": {
        "id": "usr_alice",
        "name": "Alice",
        "meta": { "color": "#0080ff", "device": "laptop" }
    },
    "deviceId": "d-7f2c41e9b0",
    "deviceLabel": "MacBook",
    "capabilities": { "webrtc": true, "media": true }
}
```

| Field          | Required | Description                                                                                                                                                                                          |
| :------------- | :------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`      | yes      | Protocol version. This document is version `4`. Another value closes with `unsupported_version`.                                                                                                     |
| `user`         | no       | Username, matched against the configured users; `""` when omitted. Optional in open mode. See [Auth & Roles](../3-subsystems/auth.md).                                                               |
| `password`     | no       | Password; `""` when omitted. Ignored in open mode.                                                                                                                                                   |
| `mode`         | no       | `"peer"` (default) or `"inspect"` (inspector session, any role). Inspectors ignore `peer.meta`, `deviceId`, `deviceLabel` and `capabilities`; `peer.id` and `peer.name` only attribute their writes. |
| `peer.id`      | no       | `peerId`, 1–128 characters. Shared by every device of the same user. Defaults to the `sessionId`.                                                                                                    |
| `deviceId`     | no       | 1–128 characters, identifies the Client instance. Defaults to the `sessionId` (the session can then never be replaced). `P2PClient` always sends one.                                                |
| `peer.name`    | no       | Display name, up to 128 characters. Defaults to `peerId`.                                                                                                                                            |
| `peer.meta`    | no       | Any JSON object: the device's global presence. Defaults to `{}`.                                                                                                                                     |
| `deviceLabel`  | no       | Up to 128 characters naming the device for people (`"MacBook"`, `"iPhone"`). Defaults to `""`. `P2PClient` sends the detected platform unless told otherwise.                                        |
| `capabilities` | no       | `{ webrtc, media }`, both default `false`.                                                                                                                                                           |

A Client that sends `auth` twice, or any other frame before `auth`, is closed with `invalid_frame`.

### 2.2 `health` (Client → Server, pre-auth only)

`{ "type": "health" }` instead of `auth` gets `{ "type": "health", "ok": true }` and the socket is closed with `client_close`. Used by the [Docker health check](../2-server/server.md#health-check).

### 2.3 `connected` (Server → Client)

```json
{
    "type": "connected",
    "reqId": 1,
    "sessionId": "q0sJ3m9xZ2V4yB7nT1uKpA",
    "peerId": "usr_alice",
    "deviceId": "d-7f2c41e9b0",
    "deviceLabel": "macOS",
    "role": "rw",
    "peers": [
        {
            "peerId": "usr_bob",
            "sessionId": "...",
            "deviceId": "d-3c55a0f2e1",
            "deviceLabel": "iPhone",
            "name": "Bob",
            "meta": {},
            "role": "rw",
            "capabilities": { "webrtc": true, "media": true },
            "channels": ["board:A"],
            "connectedAt": 1792000000000
        }
    ],
    "channels": [
        {
            "id": "board:A",
            "createdAt": 1792000000000,
            "createdBy": "usr_bob",
            "meta": { "title": "Roadmap" }
        }
    ],
    "iceServers": [],
    "limits": { "maxPayloadBytes": 1048576, "maxChannelsPerSession": 16 },
    "heartbeat": { "intervalMs": 10000, "timeoutMs": 30000 }
}
```

- `peers` lists every other visible peer on the Server, including the other devices of the same `peerId` (never the session itself, never inspector sessions), each with the channels it is subscribed to.
- `channels` lists every existing channel as `ChannelInfo` (§5), subscribed or not.
- A new session is subscribed to no channel: it receives global presence, channel events and direct messages only.
- Inspector sessions get the same `peers` and `channels` and receive global presence and channel events from then on, but they are never listed themselves (see [Inspection](../3-subsystems/inspection.md#1-inspector-sessions)).
- `deviceLabel` is the label the Server kept for this session: the one sent in `auth`, with a suffix when another live device of the same `peerId` already uses it (§2.3).
- `iceServers` comes from `P2P_ICE_SERVERS`. A Client-side `webrtc.iceServers` option overrides it.

Identity rules, applied before `connected` is sent (see [Identity](architecture.md#2-identity-users-devices-sessions)):

1. **Replacement.** A visible session with the same `peerId` **and** `deviceId` is closed with `session_replaced` and announced with `peer:left` **before** the new session is announced with `peer:joined { peer, replaces: <old sessionId> }`.
2. **Return after a drop.** When no such session is live but one ended within the last 60 s with any reason other than `client_close`, the new session is announced with `peer:joined { peer, replaces: <that sessionId> }` too.
3. In both cases the new session remembers the channels of the session it replaces: when it subscribes to one of them, `subscriber:joined` carries the same `replaces` (§5.1).
4. Sessions of the same `peerId` with different `deviceId`s coexist, in any number, and never affect each other.
5. **Device labels.** When another live session of the same `peerId` already has the requested `deviceLabel`, the Server appends ` 2`, ` 3`, … (the smallest free number), so two windows on one machine read `macOS` and `macOS 2`. An empty label stays empty.

## 3. Requests, Acknowledgements and Errors

Frames that carry a `reqId` get exactly one answer: `ack` or `error`.

```json
{ "type": "ack", "reqId": 7 }
{ "type": "ack", "reqId": 8, "applied": false, "entry": { "...": "..." } }
{ "type": "error", "reqId": 9, "code": "NOT_SUBSCRIBED", "message": "Not subscribed to channel board:B" }
```

Errors with a `reqId` are not fatal: the session continues. The Client rejects the matching Promise with `P2PError` (`err.code`, `err.message`). A rejected frame that had no `reqId` (`signal`, `reply`, an ephemeral frame) gets an `error` frame without one; the Client emits it as an `error` event.

### 3.1 Error Codes

| Code                                                       | Raised by      | Meaning                                                                                                                                                                                                                                                                 |
| :--------------------------------------------------------- | :------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_CHANNEL`                                          | Server, Client | The channel id does not match `^[A-Za-z0-9._:-]{1,128}$`.                                                                                                                                                                                                               |
| `CHANNEL_NOT_FOUND`                                        | Server         | The channel does not exist and the session cannot create it (role `ro`), or a read targets a channel that does not exist.                                                                                                                                               |
| `NOT_SUBSCRIBED`                                           | Server, Client | A channel frame (`channel:presence`, `broadcast`, `state:*`, `lease*`, `media:*`), `unsubscribe` or `subscribe { replace }` for a channel the session is not subscribed to; `stats:unfollow` for a prefix that is not followed.                                         |
| `CHANNEL_LIMIT`                                            | Server, Client | A peer session is already subscribed to `limits.maxChannelsPerSession` channels, or the Server already holds `P2P_MAX_CHANNELS` channels.                                                                                                                               |
| `FORBIDDEN`                                                | Server, Client | A frame an inspector session may not send (`presence`, `send`, `request`, channel frames, `signal`, `link`); `subscribe { prefix }` from a peer session; role `ro` creating a channel or changing its `meta`; deleting a channel as neither its creator nor an `admin`. |
| `PEER_NOT_FOUND`                                           | Server, Client | The target has no visible peer: an unknown `sessionId`, or a `peerId` with no session other than the sender's.                                                                                                                                                          |
| `PAYLOAD_TOO_LARGE`                                        | Client         | The encoded frame exceeds `limits.maxPayloadBytes`. (On the Server this is a close reason.)                                                                                                                                                                             |
| `STATE_TOO_LARGE`                                          | Server         | Applying the write would make the stored state (all channels) exceed `P2P_MAX_STATE_BYTES`.                                                                                                                                                                             |
| `INVALID_ARGUMENT`                                         | Server, Client | A field has the wrong type or is out of range (e.g. empty key, key over 256 characters, unknown `operation`).                                                                                                                                                           |
| `TIMEOUT`                                                  | Client         | No answer within the deadline (`request` reply, `ack`, connect). A connect timeout says which stage failed in `err.stage`: `"socket"` (the socket never opened) or `"handshake"` (it opened, but no frame came back).                                                   |
| `PEER_LEFT`                                                | Client         | The target of a pending `request` left before replying.                                                                                                                                                                                                                 |
| `DISCONNECTED`                                             | Client         | The control socket is down; the call was not sent or its answer can no longer arrive.                                                                                                                                                                                   |
| `UNSUPPORTED`                                              | Client         | The environment lacks the API (`shareMedia` without media capability).                                                                                                                                                                                                  |
| `REPLY_ERROR`                                              | Client         | The replying peer threw or called `reply` with an error; `err.message` carries its message.                                                                                                                                                                             |
| `AUTH_FAILED`, `SERVER_FULL`, `SESSION_REPLACED`, `CLOSED` | Client         | `connect()` or the session ended with the matching close reason (see §7).                                                                                                                                                                                               |

## 4. Global Presence

### 4.1 `PeerInfo`

```typescript
type PeerInfo = {
    peerId: string; // the user: shared by all their devices
    sessionId: string; // this connection: unique
    deviceId: string; // this device: unique per peerId
    name: string;
    meta: Record<string, unknown>; // global presence of this device
    role: "admin" | "rw" | "ro";
    deviceLabel: string; // the device for people ("MacBook"), "" when unknown
    capabilities: { webrtc: boolean; media: boolean };
    channels: string[]; // the channels this device is subscribed to, sorted
    connectedAt: number; // epoch ms
};
```

### 4.2 Frames

| Frame                                                  | Direction | Description                                                                                                                                                   |
| :----------------------------------------------------- | :-------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `presence { reqId, meta, name?, merge? }`              | C → S     | Replaces this session's global `meta` (and `name`); other devices of the same `peerId` keep theirs. With `merge: true`, `meta` is a patch (§4.3). Every role. |
| `peer:joined { peer, replaces? }`                      | S → C     | A visible session connected. `replaces` is the `sessionId` of the same device's previous session (§2.3).                                                      |
| `peer:updated { peer }`                                | S → C     | A peer's `meta` / `name` changed, or it subscribed to or unsubscribed from a channel (`peer.channels`).                                                       |
| `peer:left { peer, reason }`                           | S → C     | A peer's session ended. `reason` is its close reason (§7).                                                                                                    |
| `channel:created { channel }`                          | S → C     | A channel was created. `channel` is its `ChannelInfo`.                                                                                                        |
| `channel:updated { channel, by, sessionId, deviceId }` | S → C     | A channel's `meta` changed. `channel` is its new `ChannelInfo`; `by`, `sessionId` and `deviceId` identify the writer.                                         |
| `channel:deleted { channel, by, sessionId, deviceId }` | S → C     | A channel was deleted. `channel` is its id; `by` is the deleter's `peerId`, `sessionId` and `deviceId` its session and device.                                |

Global presence and channel events go to every visible session and every inspector session. They carry channel ids and channel `meta`, never channel contents.

### 4.3 Meta Patches

`presence` and `channel:presence` with `merge: true`, and `query updateChannel`, treat `meta` as a patch: each key of the patch replaces that key, a key set to `null` is removed, and keys the patch does not mention are kept. The result is what peers receive; they never see the patch itself.

## 5. Channels

A channel is a named scope inside the Server, for example one board of a drawing app. Channel ids match `^[A-Za-z0-9._:-]{1,128}$`. A channel exists from its creation until it is deleted, with or without subscribers, and keeps its shared state in the snapshot ([State Store](../3-subsystems/state-store.md)).

```typescript
type ChannelInfo = {
    id: string;
    createdAt: number; // epoch ms
    createdBy: string; // peerId of the creator
    meta: Record<string, unknown>; // set at creation, changed with query updateChannel
};
```

- **Create:** `rw` and `admin` sessions, with `subscribe { create }` or the `query` operation `createChannel`. Either can set the initial `meta`. Role `ro` subscribes to existing channels only.
- **Change `meta`:** `rw` and `admin` sessions, with `query updateChannel` (a patch, §4.3). `meta` is at most 4 KiB of JSON (`INVALID_ARGUMENT`) and counts toward `P2P_MAX_STATE_BYTES`. Use it for what a channel list shows: a title, a description, a cover color.
- **Delete:** the channel's creator (its `createdBy` `peerId`, from any of that user's devices, unless the role is now `ro`) and `admin` sessions, with `query deleteChannel`. Anyone else gets `FORBIDDEN`. A channel with `createdBy: ""` (migrated from a format 1 snapshot) is deleted by `admin` only.
- Inside a channel every role has the same rights.

See [Inspection](../3-subsystems/inspection.md) for the `query` operations.

### 5.1 Subscribing

| Frame                                                            | Direction | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| :--------------------------------------------------------------- | :-------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscribe { reqId, channel, meta?, create?, replace?, state? }` | C → S     | `ack { channel, created, subscribers, state, clock, observed, leases }`. With `state: false` the ack's `state` is `{}`: the Client starts with an empty replica and learns keys from later changes (§5.3). A missing channel gets `CHANNEL_NOT_FOUND`, unless `create` is `true` or `{ meta }`: then it is created with that channel `meta` (`created: true`, `channel:created` to everyone) for `rw` / `admin`, and role `ro` gets `FORBIDDEN`. Subscribing again replaces `meta` and returns a fresh snapshot. `replace` names a subscribed channel to leave in the same step (§5.1.1). |
| `unsubscribe { reqId, channel }`                                 | C → S     | `ack`. `NOT_SUBSCRIBED` when not subscribed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `channel:presence { reqId?, channel, meta, merge?, ephemeral? }` | C → S     | Replaces this session's `meta` in that channel (e.g. its viewport on a board), or patches it with `merge: true` (§4.3). Seen only by the channel's subscribers. With `ephemeral: true` there is no `reqId` and no `ack`, and the `subscriber:updated` it causes is [dropped under backpressure](#8-backpressure) like an ephemeral broadcast; the Server still keeps the new `meta` for later subscribers.                                                                                                                                                                                |
| `subscriber:joined { channel, sessionId, meta, replaces? }`      | S → C     | To the channel's other subscribers. The subscriber's `PeerInfo` comes from global presence. `replaces` is set when this session replaced the same device's previous session and that session was subscribed to this channel (§2.3).                                                                                                                                                                                                                                                                                                                                                       |
| `subscriber:updated { channel, sessionId, meta }`                | S → C     | A subscriber's channel `meta` changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `subscriber:left { channel, sessionId, reason }`                 | S → C     | `reason` is `"unsubscribed"`, `"channel_deleted"`, or the close reason of its session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

- `ack.subscribers` lists `{ sessionId, meta }` for every other subscriber; `ack.state` holds every entry of the channel, tombstones included (none with `state: false`); `ack.clock` is the Server's clock; `ack.leases` maps each held lease name to its holder's `sessionId` (§5.5).
- Subscribing sends `peer:updated` (with the new `channels`) to every visible session, then `subscriber:joined` to the channel's other subscribers. Unsubscribing sends `subscriber:left`, then `peer:updated`. A Client therefore always knows the `PeerInfo` of a subscriber.
- A session subscribes to at most `limits.maxChannelsPerSession` channels (`P2P_MAX_CHANNELS_PER_SESSION`, default 16), and the Server holds at most `P2P_MAX_CHANNELS` channels (default 1 024), else `CHANNEL_LIMIT`.
- Inspector sessions do not count toward that limit (§5.1.2).
- When a session closes, its channels get `subscriber:left` with the close reason, then everyone gets `peer:left`.
- Deleting a channel drops its state, sends `channel:deleted` to every visible session, then `peer:updated` for each former subscriber. Former subscribers get no `subscriber:left`; their Clients close the channel on `channel:deleted`.

#### 5.1.1 Switching Channels

`subscribe { channel: "b", replace: "a" }` leaves `a` and subscribes to `b` in one step, so nobody sees the device in neither channel. Everything is checked before anything changes (`NOT_SUBSCRIBED` when the session is not in `a`; `b` as for any subscribe). Then:

1. `subscriber:left { reason: "unsubscribed" }` to `a`'s other subscribers;
2. **one** `peer:updated` with `a` removed and `b` added;
3. `subscriber:joined` to `b`'s other subscribers.

`replace` equal to `channel` is `INVALID_ARGUMENT`.

#### 5.1.2 Inspector Subscriptions

Inspector sessions may subscribe too, without appearing anywhere: they are not in `ack.subscribers`, `subscriber:*` frames, `PeerInfo.channels` or `schema` subscriber lists, and they do not count toward `limits.maxChannelsPerSession`. They receive and never send channel frames; they write through `query`.

| Frame                           | Direction | Notes                                                                                                                                                                                                                  |
| :------------------------------ | :-------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscribe { reqId, channel }`  | C → S     | Same `ack` as for a peer. The session then receives every channel frame of that channel except media.                                                                                                                  |
| `subscribe { reqId, prefix }`   | C → S     | Watches every channel whose id starts with `prefix` (`""`: all), including channels created later. `ack { prefix, channels: [{ id, subscribers }] }` lists the matching channels and their subscribers, without state. |
| `unsubscribe { reqId, prefix }` | C → S     | Stops that watch. `NOT_SUBSCRIBED` when there is none.                                                                                                                                                                 |

Visible subscribers learn whether a channel is observed, never by whom: `ack.observed` on subscribe, then `channel:observed { channel, observed }` (S → C) whenever it changes. A Client skips the Server for a broadcast only when every recipient is linked **and** the channel is not observed, so inspectors receive broadcasts exchanged over links too.

A watched channel delivers the same frames as an exact subscription (`subscriber:*`, `broadcast` including ephemeral ones, `state:*`), but no state snapshot: read it with `query getState`. A frame reaches an inspector once even when several of its subscriptions match.

### 5.2 Broadcasts

| Frame                                                                 | Direction | Notes                                                                                                                 |
| :-------------------------------------------------------------------- | :-------- | :-------------------------------------------------------------------------------------------------------------------- |
| `broadcast { reqId?, channel, msgId, data, ephemeral?, deliveredTo }` | C → S → C | Relayed to every subscriber of the channel except the sender and `deliveredTo`, including the sender's other devices. |

`reqId` is omitted for ephemeral frames (no `ack`). Ephemeral broadcasts are subject to [drop-on-backpressure](#8-backpressure).

### 5.3 Shared State

| Frame                                                                          | Direction | Notes                                                                                                                       |
| :----------------------------------------------------------------------------- | :-------- | :-------------------------------------------------------------------------------------------------------------------------- |
| `state:set { reqId, channel, key, value, version, tag?, deliveredTo }`         | C → S     | `ack { applied, entry? }`. `entry` is the winning entry when `applied` is `false`.                                          |
| `state:delete { reqId, channel, key, version, tag?, deliveredTo }`             | C → S     | Stores a tombstone. Same `ack` as `state:set`.                                                                              |
| `state:clear { reqId, channel, version, prefix?, tag?, deliveredTo }`          | C → S     | Tombstones every live entry of the channel (with `prefix`: whose key starts with it) whose version is lower than `version`. |
| `state:batch { reqId, channel, version, ops, tag? }`                           | C → S     | Several writes in one frame (§5.3.1). `ack { results: [{ applied, entry? }] }`, one per op.                                 |
| `state:live { channel, key, value, version, tag?, deliveredTo }`               | C → S → C | A live value (§5.3.2): ephemeral, never stored.                                                                             |
| `state:changed { channel, from, key, entry, created }`                         | S → C     | A `state:set` / `state:delete` that won, to the channel's subscribers not in `deliveredTo`.                                 |
| `state:changes { channel, from, changes }`                                     | S → C     | The ops of one `state:batch` that won: `changes` is `[{ key, entry, created }]`.                                            |
| `state:cleared { channel, from, version, prefix?, tag?, updatedBy, deviceId }` | S → C     | Relayed `state:clear`.                                                                                                      |

`created` is `true` when the key had no live value on the Server before this write and has one after it.

`tag` is an optional string of 1–128 characters that says why a write happened (`"undo"`, `"erase"`, `"import"`). It is stored in the entry and delivered with the change; it never affects last-write-wins.

Over links the sender uses the same `state:set`, `state:delete`, `state:clear` and `state:live` frames (with `channel`) without `reqId` and `deliveredTo`. `state:batch` never goes over links: the Server relays it. `key` is a non-empty string of at most 256 characters. `version` must be `[clock, <sender sessionId>]`, with `clock` from the sender's Lamport clock. The Server raises its clock to `clock`.

Every entry records its writer:

```typescript
type Entry = {
    value: unknown; // null for tombstones
    deleted: boolean;
    version: [clock: number, sessionId: string]; // version[1] is the writer's session
    updatedBy: string; // the writer's peerId
    deviceId: string; // the writer's deviceId ("" for entries written before protocol 3)
    updatedAt: number; // epoch ms
    tag?: string; // why it was written, when the writer said
};
```

#### 5.3.1 Batches

`ops` is a list of `{ key, value }` (a write) or `{ key, deleted: true }` (a delete), at most 1 000, each key at most once (`INVALID_ARGUMENT`). Every op uses the batch's `version`. The Server validates the whole batch, including the size limit (`STATE_TOO_LARGE`), before applying any op: either no op is applied, or each op is resolved by last-write-wins on its own key. One `state:changes` frame carries the winners to the channel's other subscribers. A batch's `tag` applies to every op.

#### 5.3.2 Live Values

A live value is what a key looks like while someone is still changing it (an item being dragged, a stroke being drawn). It reaches the subscribers at once and is never stored; the writer finishes with an ordinary `state:set`, which is what persists.

- `state:live` goes over links and, for unlinked subscribers, through the Server, in both cases as an ephemeral frame: unordered, no `ack`, [dropped under backpressure](#8-backpressure). The Server checks the subscription, the key and the version, and relays it with `from`; it keeps nothing.
- `version` is `[clock, <sender sessionId>]` where `clock` is the sender's **current** clock, not incremented. A receiver ignores a live value whose version is not newer than the key's stored entry, so a late live value can never hide the write that ended it.
- A receiver shows the newest live value of a key over its stored value until one of: a stored write of that key is applied; the sender leaves the channel or disconnects; or no live value for the key arrived for 10 s.

### 5.4 Leases

A lease gives one session of a channel a named job (making thumbnails, autosaving, running a bot) so the others do not do it too. Leases are kept in the Server's memory only.

| Frame                                          | Direction | Notes                                                                                                                                                                                                                                                             |
| :--------------------------------------------- | :-------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lease { reqId, channel, name, ttlMs, wait? }` | C → S     | `ack { granted, holder }`. Free, or already held by this session: granted (or renewed) for `ttlMs`. Held by another session: `granted: false`, and with `wait: true` this session joins the queue for that name. `holder` is the holder's `sessionId`, or `null`. |
| `lease:release { reqId, channel, name }`       | C → S     | `ack { released }`. Releases the lease (the holder) or leaves the queue (a waiting session).                                                                                                                                                                      |
| `lease:changed { channel, name, holder }`      | S → C     | To the channel's subscribers (and inspectors) whenever the holder changes; `holder` is a `sessionId` or `null`.                                                                                                                                                   |

- `name` is 1–128 characters; `ttlMs` is clamped to 1 s–10 min.
- A lease ends when its holder releases it, does not renew it within `ttlMs`, unsubscribes or disconnects. The Server then grants it to the first session still waiting in the queue (with the `ttlMs` it asked for) and sends one `lease:changed` with the new holder, or `null` when nobody waits.
- A session waits at most once per name; waiting ends when it is granted, releases, unsubscribes or disconnects.
- Inspector sessions cannot hold or wait for leases (`FORBIDDEN`); they receive `lease:changed`.

### 5.5 Media

| Frame                                                                        | Direction | Notes                                                                                                                                                                           |
| :--------------------------------------------------------------------------- | :-------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `media:chunk { channel, streamId, gen, seq, mime, init, data, deliveredTo }` | C → S → C | `data` is base64 of one `MediaRecorder` blob. `init: true` marks the first chunk of a recorder generation. Relayed only to the channel's subscribers with `capabilities.media`. |
| `media:resync { channel, streamId, from }`                                   | S → C     | Sent to the stream's sender when the Server dropped a chunk for a receiver; the sender restarts its recorder (new `gen`).                                                       |
| `media:end { channel, streamId }`                                            | C → S → C | The sender stopped sharing in that channel.                                                                                                                                     |

Over a link, the sender announces which channel its tracks belong to with `media:announce { channel, streamId }` (the `MediaStream.id`) on `p2p-reliable` before adding the tracks. See [Media](../4-client/media.md).

## 6. Global Frames

The Server adds `from` (the sender's `sessionId`) to every frame it relays and drops any `from` a Client sends. Frames sent by an inspector session (through `query`) also carry `sender: { peerId, role }`, since inspectors are not listed peers. `msgId` must start with the sender's own `sessionId` followed by `:`, else `INVALID_ARGUMENT`.

### 6.1 Direct Messages and Requests

| Frame                                                        | Direction | Notes                                                                                                                                                            |
| :----------------------------------------------------------- | :-------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send { reqId?, msgId, to, data, ephemeral?, deliveredTo? }` | C → S → C | `to` is `{ peerId }` (every session of that user except the sender and `deliveredTo`) or `{ sessionId }` (one session). Reaches any peer, whatever its channels. |
| `request { reqId, msgId, to, data, timeoutMs }`              | C → S → C | `to` is `{ sessionId }`: the Client picks one device when the caller targets a `peerId`. `ack` means routed.                                                     |
| `reply { msgId, to, replyTo, data?, error? }`                | C → S → C | `to` is the requester's `sessionId`; `replyTo` is the request's `msgId`. `error` is `{ message }`. Only to a session that sent this one a request.               |

### 6.2 Link Signaling

| Frame                   | Direction | Notes                                                                                                                                                                                |
| :---------------------- | :-------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal { to, signal }` | C → S → C | `signal` is `{ kind: "offer" \| "answer", sdp, gen }` or `{ kind: "ice", candidate, gen }`. Rejected with `INVALID_ARGUMENT` when either side lacks `webrtc`. `to` is a `sessionId`. |
| `link { to, mode }`     | C → S     | `mode` is `"webrtc"` or `"socket"`. Informational: reported by `schema`, never used for routing.                                                                                     |

Clients open links only between devices that share at least one channel ([Transports](../4-client/transports.md)).

### 6.3 Inspection

| Frame                                       | Direction | Notes                                                                                                                                   |
| :------------------------------------------ | :-------- | :-------------------------------------------------------------------------------------------------------------------------------------- |
| `schema { reqId, channel? }`                | C → S     | All roles. Without `channel`: the Server (presence, channels). With `channel`: that channel. `ack` carries it.                          |
| `query { reqId, operation, channel?, ... }` | C → S     | All roles; creating a channel or changing its `meta` needs `rw` / `admin`, deleting one its creator or `admin`. `ack` carries `result`. |

See [Inspection](../3-subsystems/inspection.md).

### 6.4 Channel Stats

Stats summarize a channel without reading it: `{ keyCount, stateBytes, subscriberCount, lastWriteAt, lastWriteBy }` (`lastWriteAt` / `lastWriteBy` are `null` for a channel never written).

| Frame                              | Direction | Notes                                                                                                                                                                                                                              |
| :--------------------------------- | :-------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stats:follow { reqId, prefix }`   | C → S     | `ack { prefix, channels: { [id]: stats } }` for the channels whose id starts with `prefix` (`""`: all). From then on the session receives `channel:stats` for those channels, including channels created later. Any role and mode. |
| `stats:unfollow { reqId, prefix }` | C → S     | Stops it. `NOT_SUBSCRIBED` when that prefix is not followed.                                                                                                                                                                       |
| `channel:stats { channel, stats }` | S → C     | After a stored write (or clear) in a followed channel, at most once per second per channel: the last write of a burst is always reported, up to 1 s later.                                                                         |

Nothing is pushed to sessions that do not follow; `query stats` reads them once ([Inspection](../3-subsystems/inspection.md)).

### 6.5 Keep-Alive and Closing

| Frame                        | Direction | Notes                                                                                               |
| :--------------------------- | :-------- | :-------------------------------------------------------------------------------------------------- |
| `ping`                       | C → S     | Sent by the Client when it has sent nothing for `heartbeat.intervalMs`.                             |
| `pong`                       | S → C     | Answer to `ping`.                                                                                   |
| `bye`                        | C → S     | Clean close (`p2p.close()`): the Server removes the session immediately with reason `client_close`. |
| `close { reason, message? }` | S → C     | Sent before the Server ends a socket. Always the last frame.                                        |

## 7. Close Reasons

Every socket the Server ends gets a `close` frame with one of these reasons, and `peer:left` (and `subscriber:left` in each of its channels) carries the same reason. A socket that drops without a `close` frame (network loss) is reported as `connection_lost`.

| Reason                | Client error code  | Reconnects?               | Cause                                                                    |
| :-------------------- | :----------------- | :------------------------ | :----------------------------------------------------------------------- |
| `client_close`        | `CLOSED`           | No                        | `bye` received, or after `health`.                                       |
| `connection_lost`     | `DISCONNECTED`     | Yes                       | The socket closed without a `close` frame.                               |
| `heartbeat_timeout`   | `DISCONNECTED`     | Yes                       | Nothing received for `P2P_HEARTBEAT_TIMEOUT`.                            |
| `auth_timeout`        | `TIMEOUT`          | Yes                       | No `auth` within 10 s.                                                   |
| `auth_failed`         | `AUTH_FAILED`      | Only with `beforeConnect` | Unknown user, wrong password, or disabled role.                          |
| `unsupported_version` | `CLOSED`           | No                        | `auth.version` is not `4`.                                               |
| `server_full`         | `SERVER_FULL`      | Yes                       | `P2P_MAX_CONNECTIONS` authenticated sessions already open.               |
| `payload_too_large`   | `CLOSED`           | Yes                       | Frame length over `P2P_MAX_PAYLOAD_BYTES`.                               |
| `slow_consumer`       | `DISCONNECTED`     | Yes                       | Over `P2P_MAX_BUFFERED_BYTES` of reliable frames queued for this socket. |
| `invalid_frame`       | `CLOSED`           | No                        | Malformed frame, unknown `type`, or a frame before `auth`.               |
| `session_replaced`    | `SESSION_REPLACED` | No                        | A new session authenticated with the same `peerId` and `deviceId`.       |
| `server_shutdown`     | `DISCONNECTED`     | Yes                       | `SIGINT` / `SIGTERM`.                                                    |

"Reconnects?" is the Client's behavior when `reconnect` is enabled; a reconnecting Client subscribes again to its channels. Arbitrary error text is logged, never sent as a reason.

## 8. Backpressure

For each relayed ephemeral frame (ephemeral `send` / `broadcast`, and `media:chunk` with `init: false`), the Server checks the recipient's `socket.writableLength`:

- At or below 65 536 bytes: written.
- Above: dropped for that recipient. For `media:chunk`, the recipient is marked out of sync for that `streamId`: every later chunk is dropped for it until a chunk with `init: true`, and the sender gets one `media:resync`.

Reliable frames are never dropped; they queue in the socket buffer. A recipient whose `writableLength` exceeds `P2P_MAX_BUFFERED_BYTES` (default 8 MiB) cannot keep up and is closed with `slow_consumer`; its Client reconnects and subscribes again. See [Presence & Channels](../3-subsystems/channels.md#slow-consumers).

## 9. Deduplication and Ordering

- Every Client keeps, per sender `sessionId`, the last 1 024 `msgId`s it delivered and drops repeats. A frame can arrive twice when a link opens or closes while it is in flight.
- State frames need no `msgId`: re-applying an entry with the same version is a no-op.
- Reliable frames are ordered per transport. When a pair switches transport, a frame sent over the new transport can overtake one still in the old; applications that need strict ordering across a switch must sequence their own payloads. Shared state is unaffected (LWW).
- Reliable frames sent on a link that fails before delivery are not retransmitted on the socket (at-most-once). `request` reports this as `TIMEOUT`; shared state is unaffected because every write also reaches the Server.

## 10. Timeouts and Limits

| Name                   | Value                                 | Where                                                              |
| :--------------------- | :------------------------------------ | :----------------------------------------------------------------- |
| Auth deadline          | 10 s                                  | Server: first frame after TCP connect.                             |
| Connect timeout        | `connectTimeoutMs` (10 s)             | Client: TCP connect + `connected`.                                 |
| Ack timeout            | 10 s                                  | Client: any frame with `reqId`.                                    |
| Request timeout        | `timeoutMs` (default 10 s, max 120 s) | Client: `request()` reply.                                         |
| Heartbeat interval     | `P2P_HEARTBEAT_INTERVAL` (10 s)       | Client sends `ping` when idle for this long.                       |
| Heartbeat timeout      | `P2P_HEARTBEAT_TIMEOUT` (30 s)        | Server closes; Client treats the socket as lost.                   |
| Link open deadline     | 15 s                                  | Client: offer to `p2p-reliable` open.                              |
| Link retry             | once, after 30 s, fresh negotiation   | Initiator only.                                                    |
| Link idle close        | 10 s without a shared channel         | Client.                                                            |
| Max frame              | `P2P_MAX_PAYLOAD_BYTES` (1 MiB)       | Both sides.                                                        |
| Max state              | `P2P_MAX_STATE_BYTES` (64 MiB)        | Server: all channels together.                                     |
| Channels per session   | `P2P_MAX_CHANNELS_PER_SESSION` (16)   | Server, then `CHANNEL_LIMIT`.                                      |
| Channels per Server    | `P2P_MAX_CHANNELS` (1 024)            | Server, then `CHANNEL_LIMIT`.                                      |
| Channel id             | `^[A-Za-z0-9._:-]{1,128}$`            | Both sides.                                                        |
| Channel `meta`         | 4 KiB of JSON                         | Server, then `INVALID_ARGUMENT`.                                   |
| Batch size             | 1 000 ops                             | Both sides, then `INVALID_ARGUMENT`.                               |
| Replacement window     | 60 s                                  | Server: a session ended this long ago can still be `replaces`.     |
| Live value expiry      | 10 s without a refresh                | Client.                                                            |
| Lease `ttlMs`          | 1 s – 10 min (Client default 30 s)    | Server clamps.                                                     |
| Write `tag`            | 128 characters                        | Both sides, then `INVALID_ARGUMENT`.                               |
| `channel:stats`        | at most 1 per second per channel      | Server.                                                            |
| Key length             | 256 characters                        | Both sides.                                                        |
| Snapshot debounce      | 100 ms, at most 1 s delay             | Server.                                                            |
| Tombstone retention    | 24 h                                  | Server: purged at snapshot time; Clients drop them on resubscribe. |
| Dedup window           | 1 024 `msgId`s per sender             | Client.                                                            |
| Backpressure threshold | 65 536 bytes                          | Server, per recipient socket.                                      |
| Reliable buffer        | `P2P_MAX_BUFFERED_BYTES` (8 MiB)      | Server, per recipient socket, then `slow_consumer`.                |
