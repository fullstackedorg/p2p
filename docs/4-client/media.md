# Media (`channel.shareMedia`)

```mermaid
flowchart LR
    subgraph Sender["Sender (FullStacked webview)"]
        Stream["MediaStream"]
        Tracks["pc.addTrack per link"]
        Rec["MediaRecorder\n100 ms slices, 250 kbps"]
    end

    subgraph Server["Server"]
        Relay["media:chunk relay\n(channel subscribers with\ncapabilities.media, minus deliveredTo)"]
    end

    subgraph RecvLink["Receiver with a link"]
        Track["ontrack -> MediaStream"]
    end

    subgraph RecvSock["Receiver on the socket"]
        MSE["MediaSource + SourceBuffer\n<video>.captureStream()"]
    end

    Stream --> Tracks -->|"SRTP"| Track
    Stream --> Rec -->|"media:chunk (base64)"| Relay --> MSE
    Track -->|"media, transport webrtc"| AppA["app"]
    MSE -->|"media, transport socket"| AppB["app"]
```

`src/client/webrtc.ts` (tracks) and `src/client/media-fallback.ts` (recorder and MSE). Requires `capabilities.media`, i.e. a FullStacked webview. Node.js and the FullStacked CLI cannot share or receive media.

Media belongs to a channel: a stream shared in `board:A` reaches only the media-capable subscribers of `board:A`. A Client can share one stream per channel.

---

## 1. Sharing

`channel.shareMedia(stream)`:

1. Rejects with `UNSUPPORTED` without media capability, `NOT_SUBSCRIBED` after the channel closed.
2. For every open link to a subscriber of the channel, sends `media:announce { channel, streamId }` on `p2p-reliable`, then adds every track of `stream` (`pc.addTrack(track, stream)`), renegotiating through `signal` frames. Links that open later, and peers that subscribe later, get the announcement and the tracks then.
3. If any media-capable subscriber is not linked, starts the recorder (below). The recorder starts and stops as subscribers come and go, link and unlink, so it only runs while someone needs it.

When a linked peer unsubscribes, its link's tracks for that stream are removed. `channel.stopMedia()`, `unsubscribe()` and the channel closing remove the tracks from every link, stop the recorder, and send `media:end { channel, streamId }`. The receiver maps incoming tracks to their channel by `MediaStream.id`, which `media:announce` names.

## 2. Socket Fallback (MediaRecorder → MSE)

### Sender

- MIME type: `audio/webm;codecs=opus` for audio-only streams, `video/webm;codecs=vp8,opus` with audio and video, `video/webm;codecs=vp8` for video-only. The first type `MediaRecorder.isTypeSupported` accepts is used.
- `audioBitsPerSecond` / `videoBitsPerSecond` sum to 250 kbps; `recorder.start(100)` emits a blob every 100 ms.
- Each blob becomes `media:chunk { channel, streamId, gen, seq, mime, init, data, deliveredTo }`: `streamId` is fixed per `shareMedia` call, `gen` counts recorder (re)starts, `seq` counts chunks within a generation, `init` is `true` for the first chunk of a generation (it holds the WebM header), `data` is base64, and `deliveredTo` lists the linked subscribers (they have the tracks).
- On `media:resync`, or when a new unlinked media-capable subscriber appears, the sender restarts the recorder: `gen + 1`, a fresh `init` chunk. Restarts are rate-limited to one per second.

### Server

- Relays `media:chunk` only to the channel's subscribers with `capabilities.media`, minus the sender and `deliveredTo`.
- Applies [backpressure](../3-subsystems/channels.md#6-backpressure): drops non-`init` chunks above 64 KiB queued, marks the receiver out of sync until the next `init`, and asks the sender for one `media:resync`. Dropping a WebM chunk would corrupt decoding, so the receiver waits for a clean restart instead of decoding garbage.

### Receiver

- On an `init` chunk for a new `(from, streamId)`, creates a `MediaSource` attached to a hidden, muted `<video>` element, adds a `SourceBuffer` for `mime`, and the channel emits `media { peer, stream: video.captureStream(), transport: "socket" }`.
- On an `init` chunk with a new `gen`, resets the `SourceBuffer` (`abort()`, `remove()`) and appends from the new header.
- Appends chunks in `seq` order; a gap in `seq` within a generation drops the rest of that generation until the next `init`.
- Keeps at most 3 seconds buffered behind the playhead and seeks to the live edge when it falls more than 1 second behind (latency stays low after a stall).
- On `media:end`, `subscriber:left` or `peer:left`, ends the `MediaSource` and the channel emits `media:ended`.

## 3. Switching Paths

When a receiver's link opens, the sender adds it to `deliveredTo` (the Server stops relaying chunks to it) and the receiver's channel emits `media` again with the track stream (`transport: "webrtc"`). When the link fails, the reverse happens after the next recorder restart. Applications should simply attach the latest `media` stream for a peer.

## 4. Limitations

- Fallback latency is roughly 300–800 ms (100 ms slices plus buffering), against ~100 ms on links. It is meant to keep media working, not to match WebRTC.
- Base64 adds 33%: one 250 kbps stream costs about 333 kbps per fallback receiver on the Server.
- Fallback media is limited by `P2P_MAX_PAYLOAD_BYTES` per chunk (a 100 ms slice at 250 kbps is about 3 KiB, far below it).

## 5. Test Contract

Integration only (needs a browser engine): `test/integration/media.test.ts` shares a synthetic stream (`<canvas>.captureStream()` plus a Web Audio oscillator) between two FullStacked webview pages; asserts the channel's `media` event with `transport: "webrtc"` and a live video track; forces one page to `webrtc: false` and asserts `transport: "socket"` with frames advancing (`video.currentTime` grows); asserts a FullStacked CLI peer subscribed to the same channel never receives `media:chunk`, and a page not subscribed to it receives no media (`schema` counters and its own frame log).
