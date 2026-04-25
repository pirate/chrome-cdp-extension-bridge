# Chrome CDP Extension Bridge

Small PoC for using a Chrome extension service worker to implement custom CDP commands (smuggled inside of standard CDP commands).

## Files

- `client.mjs`: launches Chromium, connects to browser CDP, discovers the extension service worker target, sends custom commands, receives custom events, and prints latency.
- `extension/service_worker.js`: implements the custom command/event surface exposed as `globalThis.Custom`.
- `extension/manifest.json`: minimal MV3 extension manifest.

Run:

```sh
node client.mjs
```

Or pass a Chromium executable:

```sh
node client.mjs "/path/to/chromium"
```

## Architecture

```text
external Node client
  -> browser CDP WebSocket
     - normal CDP: browser.cdp.send("Browser.getVersion")
     - normal events: browser.cdp.on("Target.attachedToTarget")

external Node client
  -> extension service worker CDP target
     - custom command: Runtime.evaluate("globalThis.Custom.ping(...)")
     - custom events: Runtime.addBinding("__bbCustomEvent")
```

Normal protocol methods stay on the browser CDP socket. Custom methods are "smuggled" by evaluating a known `globalThis.Custom.*` method inside the extension service worker target. Custom events come back through `Runtime.addBinding`, which emits `Runtime.bindingCalled` on the service worker CDP connection.

## Flow Diagrams

### 1. Normal CDP Call / Response

```mermaid
sequenceDiagram
  box Node process
    participant App as SDK
    participant Cdp as browser.cdp
  end
  box Chrome browser process
    participant CDP as Browser CDP WS / router<br/>localhost:&lt;port&gt;
    participant SW as Extension service worker
    participant Page as Page target
  end

  App->>Cdp: browser.cdp.send("Browser.getVersion")
  Cdp->>CDP: CDP request over browser WS
  Note over CDP: handled by Chrome browser target
  Note over SW,Page: not involved
  CDP-->>Cdp: CDP response
  Cdp-->>App: Promise resolves
```

### 2. Normal CDP Event Listener / Event

```mermaid
sequenceDiagram
  box Node process
    participant App as SDK
    participant Cdp as browser.cdp EventEmitter
  end
  box Chrome browser process
    participant CDP as Browser CDP WS / router<br/>localhost:&lt;port&gt;
    participant SW as Extension service worker
    participant Page as about:blank page target
  end

  App->>Cdp: browser.cdp.on("Target.attachedToTarget", cb)
  Note over Cdp: local listener only<br/>no CDP subscription frame
  App->>Cdp: browser.cdp.send("Target.attachToTarget")
  Cdp->>CDP: CDP request over browser WS
  Note over SW: not involved
  CDP->>Page: attach to page target
  Page-->>CDP: Target.attachedToTarget event
  CDP-->>Cdp: CDP event
  Cdp-->>App: emit("Target.attachedToTarget")
```

### 3. Smuggled Custom Call / Response

```mermaid
sequenceDiagram
  box Node process
    participant App as SDK
    participant WorkerCdp as workerCdp
  end
  box Chrome browser process
    participant CDP as Browser CDP WS / router<br/>localhost:&lt;port&gt;
    participant SW as Extension service worker<br/>globalThis.Custom
    participant Page as Page target
  end

  App->>App: browser.ping("test")
  App->>WorkerCdp: browser.custom("ping", {value})
  WorkerCdp->>CDP: CDP++ smuggled inside CDP<br/>Runtime.evaluate on service_worker target
  CDP->>SW: execute globalThis.Custom.ping({value:"test"})
  Note over SW: benchmark command is SW-local<br/>no localhost loopback or chrome.debugger hop
  Note over Page: not involved
  SW-->>CDP: {value, from}
  CDP-->>WorkerCdp: CDP Runtime.evaluate response
  WorkerCdp-->>App: Promise resolves
```

### 4. Smuggled Custom Event Listener / Event

```mermaid
sequenceDiagram
  box Node process
    participant App as SDK / EventEmitter
    participant WorkerCdp as workerCdp
  end
  box Chrome browser process
    participant CDP as Browser CDP WS / router<br/>localhost:&lt;port&gt;
    participant SW as Extension service worker<br/>globalThis.Custom + EventTarget
    participant Page as Page target
  end

  App->>WorkerCdp: Runtime.addBinding("__bbCustomEvent")
  WorkerCdp->>CDP: CDP request on service_worker target
  CDP->>SW: install binding in service worker context

  App->>WorkerCdp: CDP++ subscribe inside CDP<br/>Runtime.evaluate Custom.on("customevent")
  WorkerCdp->>CDP: CDP request on service_worker target
  CDP->>SW: Custom.on adds EventTarget listener
  Note over SW: event bus is SW-local<br/>no localhost loopback or chrome.debugger hop
  Note over Page: not involved

  App->>WorkerCdp: CDP++ trigger inside CDP<br/>Runtime.evaluate Custom.firecustomevent("test")
  WorkerCdp->>CDP: CDP request on service_worker target
  CDP->>SW: dispatch EventTarget "customevent"
  SW-->>CDP: Runtime.bindingCalled via __bbCustomEvent(...)
  CDP-->>WorkerCdp: CDP event
  WorkerCdp-->>App: emit("customevent", "test")
```

## Lifecycle

1. `client.mjs` launches Chromium with:
   - `--remote-debugging-port=<free port>`
   - `--remote-allow-origins=*`
   - `--load-extension=./extension`
2. The client reads `/json/version` and connects to the browser WebSocket.
3. The client scans `/json/list` for a `service_worker` target whose URL ends in `/service_worker.js`.
4. The client connects to that service worker target, enables `Runtime`, and installs `Runtime.addBinding("__bbCustomEvent")`.
5. Normal calls go through `browser.cdp.send(...)`.
6. Custom calls go through `browser.custom(...)`, which performs `Runtime.evaluate` in the service worker target.
7. Custom subscriptions call `Custom.on(...)` in the service worker. The service worker stores listeners in a plain `EventTarget`.
8. When extension logic emits an event, the service worker calls `globalThis.__bbCustomEvent(JSON.stringify(...))`; the client receives `Runtime.bindingCalled` and re-emits it through Node `EventEmitter`.

## Demo Surface

```js
const browser = new Browser();
await browser.launch();

console.log(await browser.cdp.send("Browser.getVersion"));

browser.on("Target.attachedToTarget", console.log);
browser.cdp.on("Target.attachedToTarget", console.log);
browser.on("customevent", console.log);

console.log(await browser.ping("test"));
await browser.firecustomevent("test");
```

`browser.ping(value)` calls `Custom.ping` in the extension and returns:

```js
{ value, from: "extension-service-worker" }
```

## Constraints

- This does not add real CDP methods like `Custom.ping` to Chrome. The external client owns the routing convention.
- The service worker target must be visible in `/json/list`; this PoC discovers it by URL suffix rather than extension id.
- `Runtime.evaluate` and `Runtime.addBinding` are used only against the extension service worker target, not page JS.
- Page JavaScript does not see the command surface or custom event binding.
- `--remote-allow-origins=*` is needed so extension-origin WebSockets can connect to the exposed CDP port.

## Alternatives Explored

- `chrome.debugger`: can send CDP commands to targets, but does not expose active remote-debugging clients or their raw request/response streams.
- Connecting the extension directly to `ws://localhost:9222`: the root is not a CDP WebSocket endpoint. The real browser endpoint is discovered from `/json/version`.
- Listening to another CDP client's traffic: separate CDP clients do not see each other's requests or responses.
- WebMCP: page-visible/tool-oriented, so it is not suitable when page JS must not detect the control plane.
- `Extensions.*` storage mailbox: possible in some target contexts but awkward, slower, and more brittle than directly using the extension service worker target.
- Local CDP proxy: clean and powerful, but adds another process and was not needed for this PoC.

## Latency

Latest local run uses only low-overhead local operations:

- normal call: `Browser.getVersion`
- custom call: `Custom.ping`
- normal event: `Target.attachedToTarget` on the existing `about:blank` page
- custom event: service-worker `EventTarget` -> `Runtime.addBinding`

```js
latencyMs {
  launchToFirstBrowserGetVersion: 865.18,
  normalBrowserGetVersionRoundTrip: 0.308,
  smuggledCustomPingRoundTrip: 0.558,
  normalOnSubscribeTriggerEvent: 1.397,
  smuggledCustomOnSubscribeTriggerEvent: 0.978
}
```
