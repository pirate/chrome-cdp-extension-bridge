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
    participant App as Browser SDK
    participant Cdp as Cdp WebSocket client
  end
  box Chrome browser process
    participant BrowserWS as Browser CDP WS<br/>/devtools/browser/...
    participant BrowserDomain as Browser domain
  end

  App->>Cdp: browser.cdp.send("Browser.getVersion")
  Cdp->>BrowserWS: CDP request
  BrowserWS->>BrowserDomain: dispatch Browser.getVersion
  BrowserDomain-->>BrowserWS: result
  BrowserWS-->>Cdp: CDP response
  Cdp-->>App: Promise resolves
```

### 2. Normal CDP Event Listener / Event

```mermaid
sequenceDiagram
  box Node process
    participant App as Browser SDK
    participant Cdp as Cdp EventEmitter
  end
  box Chrome browser process
    participant BrowserWS as Browser CDP WS
    participant TargetDomain as Target domain
    participant Page as about:blank page target
  end

  App->>Cdp: browser.cdp.on("Target.attachedToTarget", cb)
  Note over Cdp: local listener only<br/>no CDP subscription frame
  App->>Cdp: browser.cdp.send("Target.attachToTarget")
  Cdp->>BrowserWS: CDP request
  BrowserWS->>TargetDomain: attach to page target
  TargetDomain->>Page: create attached session
  TargetDomain-->>BrowserWS: Target.attachedToTarget event
  BrowserWS-->>Cdp: CDP event
  Cdp-->>App: emit("Target.attachedToTarget")
```

### 3. Smuggled Custom Call / Response

```mermaid
sequenceDiagram
  box Node process
    participant App as Browser SDK
    participant WorkerCdp as Cdp client for extension SW
  end
  box Chrome browser process
    participant WorkerWS as Service worker CDP WS
  end
  box Extension service worker
    participant Runtime as Runtime domain
    participant Custom as globalThis.Custom
  end

  App->>App: browser.ping("test")
  App->>WorkerCdp: browser.custom("ping", {value})
  WorkerCdp->>WorkerWS: CDP request: Runtime.evaluate(...)
  WorkerWS->>Runtime: evaluate in extension SW context
  Runtime->>Custom: Custom.ping({value:"test"})
  Custom-->>Runtime: {value, from}
  Runtime-->>WorkerWS: Runtime.evaluate result
  WorkerWS-->>WorkerCdp: CDP response
  WorkerCdp-->>App: Promise resolves
```

### 4. Smuggled Custom Event Listener / Event

```mermaid
sequenceDiagram
  box Node process
    participant App as Browser SDK / EventEmitter
    participant WorkerCdp as Cdp client for extension SW
  end
  box Chrome browser process
    participant WorkerWS as Service worker CDP WS
  end
  box Extension service worker
    participant Runtime as Runtime domain
    participant Custom as globalThis.Custom
    participant Bus as EventTarget bus
  end

  App->>WorkerCdp: CDP request: Runtime.addBinding("__bbCustomEvent")
  App->>WorkerCdp: CDP++ smuggled subscribe: Custom.on("customevent")
  WorkerCdp->>WorkerWS: CDP request: Runtime.evaluate(...)
  WorkerWS->>Runtime: evaluate in extension SW context
  Runtime->>Custom: Custom.on({eventName})
  Custom->>Bus: addEventListener("customevent")

  App->>WorkerCdp: CDP++ smuggled trigger: Custom.firecustomevent("test")
  WorkerCdp->>WorkerWS: CDP request: Runtime.evaluate(...)
  Runtime->>Custom: Custom.firecustomevent(...)
  Custom->>Bus: dispatchEvent("customevent")
  Bus->>Runtime: __bbCustomEvent(JSON.stringify(...))
  Runtime-->>WorkerWS: Runtime.bindingCalled
  WorkerWS-->>WorkerCdp: CDP event
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
