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

Normal protocol methods stay on the browser CDP socket. Custom methods are "smuggled" by evaluating a known `globalThis.Custom.*` method inside the extension service worker target. From there, the extension can initiate its own WebSocket connection out to `localhost:9222` and re-enter Chrome through the public CDP port. Custom events come back through `Runtime.addBinding`, which emits `Runtime.bindingCalled` on the service worker CDP connection.

## Flow Diagrams

### 1. Normal CDP Call / Response

```mermaid
flowchart LR
  subgraph Node["Node client"]
    direction LR
    SDK["SDK"]
    WS["WS client"]
    SDK -->|"1. browser.cdp.send(...)"| WS
  end

  subgraph Browser["Browser"]
    direction LR
    CDP["CDP router<br/>localhost:9222"]
    SW["Extension service worker<br/>CDP target / JS context"]
    Page["Page target"]
    CDP -. "can dispatch to target" .-> Page
  end

  Socket["CDP socket"]

  WS <-->|"2. CDP Browser.getVersion<br/>5. response"| Socket
  Socket <-->|"3. Standard CDP request<br/>4. Standard CDP response"| CDP

  classDef idle fill:#f7f7f7,stroke:#bbb,color:#777;
  class SW,Page idle;
```

### 2. Normal CDP Event Listener / Event

```mermaid
flowchart LR
  subgraph Node["Node client"]
    direction LR
    SDK["SDK"]
    WS["WS client"]
    SDK -->|"1. browser.cdp.on(...)"| WS
    SDK -->|"2. browser.cdp.send(...)"| WS
  end

  subgraph Browser["Browser"]
    direction LR
    CDP["CDP router<br/>localhost:9222"]
    SW["Extension service worker<br/>CDP target / JS context"]
    Page["Page target<br/>about:blank"]
    CDP -->|"5. dispatch to page target"| Page
  end

  Socket["CDP socket"]

  WS -->|"3. CDP Target.attachToTarget"| Socket
  Socket -->|"4. Standard CDP"| CDP
  CDP -->|"6. attach session"| Page
  Page -->|"7. Target.attachedToTarget<br/>{sessionId, targetInfo}"| CDP
  CDP -->|"8. Target.attachedToTarget<br/>{sessionId, targetInfo}"| Socket
  Socket -->|"9. Target.attachedToTarget<br/>{sessionId, targetInfo}"| WS
  WS -->|"10. emit('Target.attachedToTarget', {sessionId, targetInfo})"| SDK

  classDef idle fill:#f7f7f7,stroke:#bbb,color:#777;
  class SW idle;
```

### 3. Smuggled Custom Call / Response

```mermaid
flowchart LR
  subgraph Node["Node client"]
    direction LR
    SDK["SDK"]
    WS["WS client"]
    SDK -->|"1. browser.act(...)"| WS
  end

  subgraph Browser["Browser"]
    direction LR
    CDP["CDP router<br/>localhost:9222"]
    SW["Extension service worker<br/>CDP target / JS context<br/>globalThis.Custom"]
    Page["Page target"]
    CDP -->|"4. dispatch Runtime.evaluate(Custom.act)"| SW
    CDP -->|"7. Input.dispatchMouseEvent"| Page
    Page -->|"8. Input.dispatchMouseEvent result"| CDP
    SW -. "<s>chrome.debugger</s><br/>not used" .-> Page
  end

  ClientSocket["client CDP socket.<br/>carries smuggled CDP++ events inside Runtime.evaluate(Custom.*)"]
  LoopbackSocket["loopback CDP socket.<br/>carries standard CDP only"]

  WS -->|"2. Runtime.evaluate(Custom.act)"| ClientSocket
  ClientSocket -->|"3. Runtime.evaluate(Custom.act)"| CDP
  SW -->|"5. WebSocket CDP loopback<br/>out of Browser<br/>Input.dispatchMouseEvent"| LoopbackSocket
  LoopbackSocket -->|"6. Input.dispatchMouseEvent"| CDP
  CDP -->|"9. Input.dispatchMouseEvent result"| LoopbackSocket
  LoopbackSocket -->|"10. Input.dispatchMouseEvent result<br/>back into Browser"| SW
  SW -->|"11. Runtime.evaluate(Custom.act) result"| CDP
  CDP -->|"12. Runtime.evaluate(Custom.act) result"| ClientSocket
  ClientSocket -->|"13. => {ok, action, target}"| WS
```

### 4. Smuggled Custom Event Listener / Event

```mermaid
flowchart LR
  subgraph Node["Node client"]
    direction LR
    SDK["SDK"]
    WS["WS client"]
    SDK -->|"1. browser.on(...)"| WS
    SDK -->|"6. browser.firecustomevent(...)"| WS
  end

  subgraph Browser["Browser"]
    direction LR
    CDP["CDP router<br/>localhost:9222"]
    SW["Extension service worker<br/>CDP target / JS context<br/>Custom + EventTarget"]
    Page["Page target"]
    CDP -->|"5. dispatch Runtime.evaluate(Custom.on)<br/>8. dispatch Runtime.evaluate(Custom.firecustomevent)"| SW
    CDP -->|"10. Input.dispatchMouseEvent"| Page
    Page -->|"11. Input.dispatchMouseEvent result"| CDP
    SW -. "<s>chrome.debugger</s><br/>not used" .-> Page
  end

  ClientSocket["client CDP socket.<br/>carries smuggled CDP++ events inside Runtime.evaluate(Custom.*)"]
  LoopbackSocket["loopback CDP socket.<br/>carries standard CDP only"]

  WS -->|"2. CDP Runtime.addBinding"| ClientSocket
  WS -->|"3. smuggled subscribe<br/>7. smuggled trigger"| ClientSocket
  ClientSocket <-->|"4. Runtime.evaluate(Custom.on)<br/>8. Runtime.evaluate(Custom.firecustomevent)"| CDP
  SW -->|"9. WebSocket CDP loopback<br/>out of Browser<br/>Input.dispatchMouseEvent"| LoopbackSocket
  LoopbackSocket -->|"9a. Input.dispatchMouseEvent"| CDP
  CDP -->|"12. Input.dispatchMouseEvent result"| LoopbackSocket
  LoopbackSocket -->|"13. Input.dispatchMouseEvent result<br/>service worker emits EventTarget event"| SW
  SW -->|"14. Runtime.bindingCalled<br/>{name:'__bbCustomEvent', payload:'{event:customevent,data:test}'}"| CDP
  CDP -->|"15. Standard CDP event<br/>Runtime.bindingCalled {name:'__bbCustomEvent', payload:'{event:customevent,data:test}'}"| ClientSocket
  ClientSocket -->|"16. Standard CDP event<br/>Runtime.bindingCalled {name:'__bbCustomEvent', payload:'{event:customevent,data:test}'}"| WS
  WS -->|"17. emit('customevent', 'test')"| SDK
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

`browser.ping(value)` calls `Custom.ping` in the extension. The extension performs a cheap loopback `Browser.getVersion` through the public CDP port and returns:

```js
{ value, from: "extension-service-worker", browserProduct: "Chrome/..." }
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
- custom call: `Custom.ping`, including extension -> localhost CDP loopback -> browser
- normal event: `Target.attachedToTarget` on the existing `about:blank` page
- custom event: extension -> localhost CDP loopback -> service-worker `EventTarget` -> `Runtime.addBinding`

```js
latencyMs {
  launchToFirstBrowserGetVersion: 1262.603,
  normalBrowserGetVersionRoundTrip: 0.654,
  smuggledCustomPingRoundTrip: 9.345,
  normalOnSubscribeTriggerEvent: 1.836,
  smuggledCustomOnSubscribeTriggerEvent: 29.592
}
```
