# Inspection: `schema` & `query`

```mermaid
flowchart LR
    Tool["Inspector session\n(mode: inspect, any role)"] -->|"schema / query"| S["Server"]
    Peer["Visible peer\n(any role)"] -->|"schema / query"| S
    S -->|"ack { result }\nchannel create / delete: rw / admin"| Tool
    S -->|"ack { result }"| Peer
```

`src/server/inspect.ts`. Roles are described in [Auth & Roles](auth.md).

`schema` and `query` let tools look at and edit the Server without taking part in it: a data explorer, an admin console, a CLI, a test. They reach every channel without subscribing, in one round trip each, and run with the caller's own role: an `ro` tool reads and writes existing channels but cannot create or delete one.

---

## 1. Inspector Sessions

A session opened with `mode: "inspect"`, with any role:

- is not a peer: not listed in `peers`, no `peer:joined` / `peer:left`, cannot be the target of `send` or `request`;
- receives no relayed traffic (no presence, channel events, messages, state changes or media); its `connected` frame has `peers: []` and `channels: []`;
- never subscribes and never forms links;
- may only send `schema`, `query`, `ping` and `bye`; any peer frame gets `FORBIDDEN`;
- is attributed as `peer.id` (when given in `auth`) or `inspect:<sessionId>` in the `updatedBy` of its query writes, in `createdBy`, and in the `from` of its query messages. Receivers that cannot resolve the sender's `sessionId` to a listed peer report it as `{ peerId, sessionId, role, inspector: true }`.

Inspector sessions count toward `P2P_MAX_CONNECTIONS`.

Visible peers may run `schema` and `query` too; the rules below are the same for them.

## 2. `schema`

`p2p.getSchema()` sends `schema { reqId }`. Every role may run it. The `ack` carries the Server's overview:

```json
{
    "storageBytes": 18234,
    "maxStateBytes": 67108864,
    "connections": 4,
    "maxConnections": 256,
    "userCount": 2,
    "peerCount": 3,
    "peers": [
        {
            "peerId": "usr_alice",
            "sessionId": "q0sJ3m9xZ2V4yB7nT1uKpA",
            "deviceId": "d-7f2c41e9b0",
            "name": "Alice",
            "role": "rw",
            "capabilities": { "webrtc": true, "media": true },
            "channels": ["board:A"],
            "connectedAt": 1792000000000,
            "links": { "Zb1...": "webrtc", "Kx9...": "socket" },
            "socketWritableBytes": 0
        }
    ],
    "inspectorCount": 1,
    "channelCount": 2,
    "maxChannels": 1024,
    "channels": [
        {
            "id": "board:A",
            "createdAt": 1792000000000,
            "createdBy": "usr_alice",
            "subscriberCount": 2,
            "keyCount": 14,
            "sizeBytes": 9120
        }
    ],
    "stats": {
        "relayedFrames": 1203,
        "skippedByDeliveredTo": 4410,
        "droppedEphemeral": 12,
        "droppedMediaChunks": 0,
        "mediaResyncs": 0
    }
}
```

- `peerCount` counts visible sessions (devices); `userCount` counts distinct `peerId`s.
- `storageBytes` is the snapshot size; `maxStateBytes`, `maxConnections` and `maxChannels` echo the configured limits; `connections` counts every authenticated session, inspectors included.
- `channels` lists every channel in id order with its live key count and serialized size.
- `links` is what each peer reported with `link` frames.

`p2p.getSchema("board:A")` sends `schema { reqId, channel }` and gets one channel's detail (`CHANNEL_NOT_FOUND` when it does not exist):

```json
{
    "id": "board:A",
    "createdAt": 1792000000000,
    "createdBy": "usr_alice",
    "sizeBytes": 9120,
    "subscribers": [{ "sessionId": "q0sJ3m9xZ2V4yB7nT1uKpA", "peerId": "usr_alice", "meta": {} }],
    "keyCount": 14,
    "keys": [
        {
            "key": "stroke:1",
            "type": "object",
            "sizeBytes": 41,
            "updatedBy": "usr_alice",
            "updatedAt": 1792000000000
        }
    ]
}
```

`keys` lists up to 1 000 live keys in key order (`keyCount` is the total); `type` is `"object"`, `"array"`, `"string"`, `"number"`, `"boolean"` or `"null"`. Use `query getState` to page further.

## 3. `query`

`p2p.query({ operation, ... })` sends `query { reqId, operation, ... }` and resolves with `ack.result`.

| Operation                                                           | Roles         | Result                                                                                                                                                                                                  |
| :------------------------------------------------------------------ | :------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{ operation: "peers", peerId?, channel? }`                         | all           | `PeerInfo[]` of visible peers, optionally one user's devices and/or one channel's subscribers.                                                                                                          |
| `{ operation: "channels", prefix? }`                                | all           | `ChannelInfo[]` in id order, optionally the ids starting with `prefix`.                                                                                                                                 |
| `{ operation: "createChannel", channel }`                           | `admin`, `rw` | `{ created: boolean, channel: ChannelInfo }`. `created: false` when it already existed.                                                                                                                 |
| `{ operation: "deleteChannel", channel }`                           | `admin`, `rw` | `{ deleted: true }`. Drops the channel's state, unsubscribes its subscribers, sends `channel:deleted`.                                                                                                  |
| `{ operation: "getState", channel, key?, prefix?, after?, limit? }` | all           | `{ entries: { [key]: Entry }, next? }`: live entries in key order. `key` returns at most one; `prefix` filters; `limit` defaults to 100, max 1 000; `next` is the `after` value for the following page. |
| `{ operation: "setState", channel, key, value }`                    | all           | `{ applied: true, entry }`. The Server assigns the version (`[clock + 1, caller sessionId]`).                                                                                                           |
| `{ operation: "deleteState", channel, key }`                        | all           | `{ applied: true, entry }` (the tombstone).                                                                                                                                                             |
| `{ operation: "clearState", channel, prefix? }`                     | all           | `{ applied: true, count }`. With `prefix`, only matching keys.                                                                                                                                          |
| `{ operation: "broadcast", channel, data }`                         | all           | `{ recipients: number }`. Relayed to every subscriber of the channel (no `deliveredTo`).                                                                                                                |
| `{ operation: "send", to, data }`                                   | all           | `{ recipients: number }`. `to` is `{ peerId }` (every device of that user) or `{ sessionId }`; `PEER_NOT_FOUND` when nobody matches.                                                                    |

- Operations that take `channel` fail with `INVALID_CHANNEL` for a malformed id and `CHANNEL_NOT_FOUND` for a missing channel (except `createChannel`). They never create a channel implicitly.
- `ro` sessions get `FORBIDDEN` for `createChannel` and `deleteChannel`.
- An unknown `operation` or a missing field gets `INVALID_ARGUMENT`.
- Query writes go through the same store, relays and limits as peer frames (`STATE_TOO_LARGE`, key rules), and subscribers see them as ordinary `state:changed`, `state:cleared` and `message` events.
- `query` is how a Client reads or writes a channel it is not subscribed to (a script, a CLI, a data explorer, a board list that peeks at one key), in one round trip with no clock bookkeeping.

## 4. Test Contract

`test/inspect-query.test.ts`: inspector sessions of each role are invisible, receive nothing and get `FORBIDDEN` for peer frames; `schema` fields, with and without `channel`; `userCount` vs `peerCount` with one user on several devices; every operation for every role; `CHANNEL_NOT_FOUND` and `INVALID_CHANNEL`; `getState` paging (`limit`, `after`, `next`) and `prefix`; `clearState` with `prefix`; server-assigned versions winning over older Client writes; query writes observed as ordinary events by subscribers with the inspector's attribution, and not by other peers; counters increasing as documented.
