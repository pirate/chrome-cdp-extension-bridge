# MagicCDP

CDP is powerful but it's been stretched to many use-cases beyond its initial audience. It is difficult for agents and humans to use without a harness library, because:

- lacks the ability to use it statelessly without maintaining mappings of sessionIds, targetIds, frameIds, execution context IDs, backendNodeId ownership, and event listeners

- lacks the ability to register custom CDP commands, abstractions, and events

- lacks the ability to easily call chrome.\* extension APIs for things like `chrome.tabs.query({ active: true })`

- _lacks the ability to reference pages and elements with stable references across browser runs, such as XPath, URL, and frame index, instead of unstable identifiers like sessionId, targetId, frameId, backendNodeId_ (unrealistic dream? maybe not)

While I had high hopes for WebDriver BiDi, unfortunately it solves almost none of these issues.

MagicCDP does not aim to solve all of these issues directly either. Instead it solves a simpler problem: allowing us to customize and extend CDP with new commands.
Then we use those basic primitives to fix the shortcomings in CDP by implementing our own custom events (all sent over a normal CDP websocket to a stock Chromium browser).

| Primitive                | What it does                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `Magic.evaluate`         | Run an expression in the MagicCDP extension service worker, with `chrome.*` and a `cdp` bridge in scope |
| `Magic.addCustomCommand` | Register a `Custom.*` method handler that lives in the SW                                               |
| `Magic.addCustomEvent`   | Register a `Custom.*` event your SW handlers can `emit()`                                               |
| `Magic.addMiddleware`    | Intercept service-worker-routed requests, responses, or events by name or `*`                           |

Instead of inventing yet another browser driver library, MagicCDP fixes the issue at the root.

It's perfectly compatible with playwright, puppeteer, etc. with no modifications. You can do things like `patchright` does, but generically at the CDP layer instead of having to patch libraries.

You can send `Magic.*`, `Custom.*`, etc. through standard Playwright/Puppeteer/other-driver-managed CDP sessions; `client/js/demo.ts`, `client/python/demo.py`, and `client/go/demo.go` demonstrate the flow in each language.

## Use it

```ts
import { MagicCDPClient } from "./dist/client/js/MagicCDPClient.js";
import { z } from "zod";

// In stock Google Chrome, visit chrome://inspect/#remote-debugging first to
// expose the current browser at localhost:9222. Passing cdp_url is optional
// when that endpoint is live.
const cdp_url = "http://127.0.0.1:9222"; // ws://... URLs work too
const cdp = new MagicCDPClient({
  cdp_url,
  routes: { "Target.getTargets": "service_worker" },
  server: { loopback_cdp_url: cdp_url, routes: { "*.*": "loopback_cdp" } },
});
await cdp.connect();

// use it like a normal CDP connection, send normal CDP, register for normal CDP events
console.log(await cdp.Browser.getVersion());
cdp.on(cdp.Target.targetInfoChanged, console.log);

// run extension code with chrome.* in scope
const tab = await cdp.Magic.evaluate({
  expression: "(await chrome.tabs.query({ active: true }))[0]",
});

// ✨ register and use custom CDP commands
await cdp.Magic.addCustomCommand({
  name: "Custom.tabIdFromTargetId",
  paramsSchema: { targetId: cdp.types.zod.Target.TargetID },
  resultSchema: { tabId: z.number().nullable() },
  expression: `async ({ targetId }) => ({
    tabId: (await chrome.debugger.getTargets()).find(t => t.id === targetId)?.tabId ?? null
  })`,
});
const { targetInfos } = await cdp.Target.getTargets();
const pageTarget = targetInfos.find((targetInfo) => targetInfo.type === "page");
console.log(await cdp.send("Custom.tabIdFromTargetId", { targetId: pageTarget.targetId })); // -> { tabId: 22352432 }

// ✨ set up new custom CDP events to fire + receive them just like normal CDP
// this example sets up a truly accurate "foreground focus" tracking event,
// which CDP doesn't have natively https://issues.chromium.org/issues/497896141
const PageForegroundPageChanged = z
  .object({
    targetId: cdp.types.zod.Target.TargetID.nullable(),
    tabId: z.number(),
  })
  .passthrough()
  .meta({ id: "Page.foregroundPageChanged" });

await cdp.Magic.addCustomEvent({
  name: PageForegroundPageChanged,
  eventSchema: PageForegroundPageChanged,
});
await cdp.Magic.evaluate({
  expression: `chrome.tabs.onActivated.addListener(async ({ tabId }) =>
    cdp.emit("Page.foregroundPageChanged", {
      tabId,
      targetId: (await chrome.debugger.getTargets()).find(t => t.tabId === tabId)?.id ?? null
    })
  )`,
});
cdp.on(PageForegroundPageChanged, console.log);

// ✨ Intercept, modify, and extend existing CDP commands/results/events on the wire
await cdp.Magic.addMiddleware({
  name: cdp.Target.getTargets,
  phase: cdp.RESPONSE,
  expression: `async (payload, next) => {
    for (const targetInfo of payload.targetInfos) {
      const { tabId } = await cdp.send("Custom.tabIdFromTargetId", {
        targetId: targetInfo.targetId,
      });
      targetInfo.tabId = tabId;
    }
    return next(payload);
  }`,
});
console.log(await cdp.Target.getTargets()); // TargetInfo entries now include tabId

// typed + zod-enforced imperative aliases are generated for standard CDP too
const created = await cdp.Target.createTarget({ url: "https://example.com" });
await cdp.Target.activateTarget({ targetId: created.targetId }); // triggers Page.foregroundPageChanged
console.log(created);
```

## Run the demos

Each demo launches Chrome with the extension loaded, headful on macOS and `--headless=new` on Linux, then exercises every primitive in the chosen mode:

```sh
pnpm run demo:js                    # defaults to --loopback; also supports --direct / --debugger
python3 -m pip install websocket-client
pnpm run demo:python
pnpm run demo:go
```

## Transparent Proxy

Upgrade any vanilla CDP client like Stagehand, Playwright, or Puppeteer transparently with support for `Magic.*` / `Custom.*` commands and events.

```sh
pnpm run proxy -- --upstream http://127.0.0.1:9222 --port 9223
# const browser = await playwright.chromium.connectOverCDP("http://127.0.0.1:9223")
# const session = await browser.contexts()[0].newCDPSession(page)
# await session.send("Magic.evaluate", { expression: "1 + 1" }) // -> 2
# ✨ All Magic CDP commands now work through playwright! you can modify/extend playwright behavior to your heart's content
```

## Routing modes

`Magic.*` and `Custom.*` always go through the extension service worker. Routing only changes how _standard_ CDP methods (`Browser.*`, `Page.*`, `DOM.*`, …) are serviced:

| Demo CLI Flag | Standard CDP path                                                  | Use when                                                                        |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `--loopback`  | client → SW → SW dials its own WS back to localhost:9222 → CDP     | Default. You need the SW to intercept/inspect/rewrite normal traffic.           |
| `--debugger`  | client → SW → `chrome.debugger.sendCommand` against the active tab | The browser exposes no remote CDP port and you only have extension permissions. |
| `--direct`    | client → sends non-Magic CDP commands to browser CDP directly      | You already have a CDP endpoint and don't need extension interception.          |

Pass via `routes: { "*.*": "direct_cdp" | "service_worker" }` on the client and `server: { routes: { "*.*": "loopback_cdp" | "chrome_debugger" } }` for the SW side. The demos default to `--loopback` (the most powerful mode).

## Repository layout

```
extension/                MV3 extension; service worker registers MagicCDPServer
  manifest.json
  service_worker.ts
  MagicCDPServer.ts
bridge/
  translate.ts           Pure stateless wrap/unwrap (used by both Node + SW)
  launcher.ts            Find chrome/chromium binary, spawn with CDP enabled
  injector.ts            Discover existing SW or Extensions.loadUnpacked it
  proxy.ts               Local CDP proxy (upgrades any vanilla CDP client)
client/
  js/MagicCDPClient.ts + demo.ts
  python/MagicCDPClient.py + demo.py
  go/MagicCDPClient.go + demo.go
dist/                     Built JS output used by the extension and Node CLI scripts
```

## Requirements

- Stock Google Chrome can be used without relaunch flags: visit `chrome://inspect/#remote-debugging` to expose the current browser at `http://127.0.0.1:9222`, and load/install the MagicCDP extension in that profile. If no `cdp_url` is passed, the JS client probes that endpoint before auto-launching a test browser.
- Automated/test browsers can still preload the extension with `--load-extension=<path>`. `Extensions.loadUnpacked` is used as a fallback when the connected browser exposes it over CDP.
- Node ≥ 22, Python ≥ 3.11 with `websocket-client`, Go ≥ 1.24 with `gobwas/ws`.

---

<details>
<summary><b>Architecture &amp; lifecycle</b></summary>

### Connect

1. Open a raw CDP websocket to the browser. If no `cdp_url` is supplied, the JS client first tries the live stock-Chrome endpoint at `http://127.0.0.1:9222`, then auto-launches a test browser only if that is not reachable.
2. `bridge/injector.js` either discovers an existing MagicCDP service worker target or installs the extension via `Extensions.loadUnpacked` when the connected browser permits it.
3. Attach a session to that SW target and `Runtime.enable` on it.
4. Optionally call `globalThis.MagicCDP.configure(...)` to push routing config into the SW (only needed when using `--loopback` or non-default server-side routing).

### Send

- `Magic.evaluate({ expression, params, cdpSessionId })` → `Runtime.evaluate` on the ext session, wrapping the expression with an IIFE that exposes `params` and `cdp = MagicCDP.attachToSession(...)`.
- `Magic.addCustomCommand({ name, expression, ... })` → `Runtime.evaluate` calling `globalThis.MagicCDP.addCustomCommand({ ... })` with the user expression embedded as the handler.
- `Magic.addCustomEvent({ name, eventSchema })` → `Runtime.addBinding({ name: "__MagicCDP_<name>" })`, then a `Runtime.evaluate` registering the event in `globalThis.MagicCDP`.
- `Magic.addMiddleware({ name, phase, expression })` → `Runtime.evaluate` registering a service-worker middleware for `phase: "request" | "response" | "event"`. Use `name: "*"` to match every method/event in that phase, or pass generated names like `cdp.Target.targetInfoChanged`.
- `Custom.X(params)` → `Runtime.evaluate` calling `globalThis.MagicCDP.handleCommand("Custom.X", params, cdpSessionId)`.

### Receive

When SW handlers `cdp.emit('Custom.X', payload)`, the SW invokes `globalThis.__MagicCDP_Custom_X(JSON.stringify({ event, data, cdpSessionId }))`. CDP delivers `Runtime.bindingCalled` on the ext session; the client (or proxy) decodes the payload, filters by `cdpSessionId`, and re-dispatches as a normal `cdp.on('Custom.X', ...)` event.

### Why this works

`Runtime.addBinding` is the only out-of-page → in-page → out-of-page channel CDP exposes. Combined with one extension service worker (which gets `chrome.*` access as a side effect of being in an extension), you get:

- A guaranteed JS execution context that's not a page, with the right permissions
- A way to push named events back through the same CDP socket your client already speaks
- Zero extra IPC, native messaging, or sidecar processes

</details>

<details>
<summary><b>Routing details</b></summary>

```ts
type CDPUpstream = "service_worker" | "direct_cdp" | "auto" | "loopback_cdp" | "chrome_debugger";

// client-side defaults
const clientRoutes = { "Magic.*": "service_worker", "Custom.*": "service_worker", "*.*": "direct_cdp" } as const;

// server-side defaults (inside the SW)
const serverRoutes = { "Magic.*": "service_worker", "Custom.*": "service_worker", "*.*": "auto" } as const;
```

- **`service_worker`** — handle in the extension SW.
- **`direct_cdp`** (client only) — send straight to the browser CDP websocket.
- **`auto`** (server only) — try `loopback_cdp` first, fall back to `chrome_debugger`.
- **`loopback_cdp`** (server only) — SW dials a CDP websocket reachable from the browser. You may pass `http://host:port` as shorthand, but it is resolved to the concrete `ws://.../devtools/...` URL at configuration time. Useful for `Browser.*` commands that `chrome.debugger` doesn't support.
- **`chrome_debugger`** (server only) — `chrome.debugger.sendCommand` against `params.debuggee || { tabId, targetId, extensionId }`, defaulting to the active last-focused tab.

Route resolution is **deterministic across all three language clients**: exact-method match → longest-prefix wildcard → `*.*` fallback. This avoids map-iteration nondeterminism (Go) and key-insertion-order shadowing (JS/Python).

When `auto` discovery is enabled, the SW only trusts `127.0.0.1:9222` after verifying a per-connection `browserToken` round-trip — it won't accidentally connect to a different browser that happens to have the same extension installed.

</details>

<details>
<summary><b>Wire diagrams</b></summary>

#### 1. Normal CDP Call / Response

```mermaid
flowchart LR
  subgraph Node["Node client"]
    direction LR
    SDK["SDK"]
    WS["WS client"]
    SDK -->|"1. cdp.send('Browser.getVersion')"| WS
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

#### 2. Normal CDP Event Listener / Event

```mermaid
flowchart LR
  subgraph Node["Node client"]
    direction LR
    SDK["SDK"]
    WS["WS client"]
    SDK -->|"1. cdp.on('Target.attachedToTarget', ...)"| WS
    SDK -->|"2. cdp.send('Target.attachToTarget', ...)"| WS
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

#### 3. MagicCDP Custom Call / Response

```mermaid
flowchart LR
  subgraph Node["Node client"]
    direction LR
    SDK["SDK"]
    WS["WS client"]
    SDK -->|"1. cdp.send('Magic.evaluate', ...)"| WS
  end

  subgraph Browser["Browser"]
    direction LR
    ClientCDP["CDP Session for client<br/>localhost:9222"]
    LoopbackCDP["CDP Session for loopback<br/>localhost:9222"]
    SW["Extension service worker<br/>CDP target / JS context<br/>globalThis.MagicCDP"]
    Page["Page target"]
    ClientCDP -->|"4. dispatch Runtime.evaluate(Magic.evaluate)"| SW
    LoopbackCDP -->|"7. Input.dispatchMouseEvent"| Page
    Page -->|"8. Input.dispatchMouseEvent result"| LoopbackCDP
    SW -. "<s>chrome.debugger</s><br/>not used" .-> Page
  end

  ClientSocket["client CDP socket.<br/>carries Magic.evaluate ..."]
  LoopbackSocket["loopback CDP socket.<br/>carries standard CDP only"]

  ClientSocket ~~~ LoopbackSocket
  WS -->|"2. Runtime.evaluate(Magic.evaluate)"| ClientSocket
  ClientSocket -->|"3. Runtime.evaluate(Magic.evaluate)"| ClientCDP
  SW -->|"5. WebSocket CDP loopback<br/>out of Browser<br/>Input.dispatchMouseEvent"| LoopbackSocket
  LoopbackSocket -->|"6. Input.dispatchMouseEvent"| LoopbackCDP
  LoopbackCDP -->|"9. Input.dispatchMouseEvent result"| LoopbackSocket
  LoopbackSocket -->|"10. Input.dispatchMouseEvent result<br/>back into Browser"| SW
  SW -->|"11. Runtime.evaluate(Magic.evaluate) result"| ClientCDP
  ClientCDP -->|"12. Runtime.evaluate(Magic.evaluate) result"| ClientSocket
  ClientSocket -->|"13. => {ok, action, target}"| WS
```

The same transport shape applies to `Magic.addCustomCommand`: the client installs a named command handler in the service worker, and later `cdp.send('Custom.someCommand', params)` is routed back through `globalThis.MagicCDP.handleCommand(...)`.

#### 4. MagicCDP Custom Event Listener / Event

```mermaid
flowchart LR
  subgraph Node["Node client"]
    direction LR
    SDK["SDK"]
    WS["WS client"]
    SDK -->|"1. cdp.on('Custom.demo', ...)"| WS
    SDK -->|"6. cdp.send('Magic.evaluate', ...)"| WS
  end

  subgraph Browser["Browser"]
    direction LR
    ClientCDP["CDP Session for client<br/>localhost:9222"]
    LoopbackCDP["CDP Session for loopback<br/>localhost:9222"]
    SW["Extension service worker<br/>CDP target / JS context<br/>MagicCDP + bindings"]
    Page["Page target"]
    ClientCDP -->|"5. dispatch Runtime.evaluate(Magic.addCustomEvent)<br/>9. dispatch Runtime.evaluate(Magic.evaluate)"| SW
    LoopbackCDP -->|"12. Input.dispatchMouseEvent"| Page
    Page -->|"13. Input.dispatchMouseEvent result"| LoopbackCDP
    SW -. "<s>chrome.debugger</s><br/>not used" .-> Page
  end

  ClientSocket["client CDP socket.<br/>carries MagicCDP ..."]
  LoopbackSocket["loopback CDP socket.<br/>carries standard CDP only"]

  ClientSocket ~~~ LoopbackSocket
  WS -->|"2. CDP Runtime.addBinding"| ClientSocket
  WS -->|"3. Magic.addCustomEvent<br/>7. Magic.evaluate(cdp.emit(...))"| ClientSocket
  ClientSocket <-->|"4. Runtime.evaluate(Magic.addCustomEvent)<br/>8. Runtime.evaluate(Magic.evaluate)"| ClientCDP
  SW -->|"10. WebSocket CDP loopback<br/>out of Browser<br/>Input.dispatchMouseEvent"| LoopbackSocket
  LoopbackSocket -->|"11. Input.dispatchMouseEvent"| LoopbackCDP
  LoopbackCDP -->|"14. Input.dispatchMouseEvent result"| LoopbackSocket
  LoopbackSocket -->|"15. Input.dispatchMouseEvent result<br/>service worker emits custom event"| SW
  SW -->|"16. Runtime.bindingCalled<br/>{name:'__MagicCDP_Custom_demo', payload:'{event:Custom.demo,data:test}'}"| ClientCDP
  ClientCDP -->|"17. Standard CDP event<br/>Runtime.bindingCalled {name:'__MagicCDP_Custom_demo', payload:'{event:Custom.demo,data:test}'}"| ClientSocket
  ClientSocket -->|"18. Standard CDP event<br/>Runtime.bindingCalled {name:'__MagicCDP_Custom_demo', payload:'{event:Custom.demo,data:test}'}"| WS
  WS -->|"19. emit('Custom.demo', 'test')"| SDK
```

</details>

<details>
<summary><b>Constraints &amp; alternatives explored</b></summary>

**Constraints**

- This does not add real CDP methods to Chrome — the wire methods stay `Runtime.evaluate` + `Runtime.bindingCalled`. The `Magic.*` / `Custom.*` namespace is a client + SW convention.
- Page JS does not see custom commands or event bindings.
- Stock Google Chrome's `chrome://inspect/#remote-debugging` toggle can expose the current browser at `localhost:9222` without relaunching with `--remote-debugging-port`, `--enable-unsafe-extension-debugging`, or `--remote-allow-origins=*`.
- If `Extensions.loadUnpacked` is unavailable in the connected browser, load/install the MagicCDP extension in that Chrome profile once and reconnect; the injector will use the discovery path.

**Alternatives considered**

- `chrome.debugger` — used as the server-side fallback, but doesn't expose other connected CDP clients or the raw protocol stream.
- Extension WebSocket → pass the actual `ws://.../devtools/browser/...` CDP endpoint directly; HTTP `/json/*` discovery is only a compatibility fallback for `http://host:port` shorthand.
- Listening to another CDP client's traffic — separate clients don't see each other's frames.
- WebMCP — page-visible/tool-oriented, unsuitable when page JS must not detect the control plane.
- `Extensions.*` storage mailbox — slower and more brittle than the SW target.
- A separate local CDP proxy process — clean, but unnecessary for the default flow; the proxy here is opt-in (only used when "upgrading" a vanilla CDP client).

</details>

<details>
<summary><b>Latency (local PoC, headless Chromium 141)</b></summary>

```
launchToFirstBrowserGetVersion:      1262.6 ms
normalBrowserGetVersionRoundTrip:       0.7 ms
smuggledCustomPingRoundTrip:            9.3 ms
normalOnSubscribeTriggerEvent:          1.8 ms
smuggledCustomOnSubscribeTriggerEvent: 29.6 ms
```

Custom roundtrip overhead is dominated by `Runtime.evaluate` + the SW's loopback CDP dial, not by wrap/unwrap. Avoid `auto` discovery in latency-sensitive paths if you can pre-configure `loopback_cdp_url` directly.

</details>
