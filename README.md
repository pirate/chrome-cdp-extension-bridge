# ModCDP

CDP is powerful but it's been stretched to many use-cases beyond its initial audience. It is difficult for agents and humans to use without a harness library, because:

- lacks the ability to use it statelessly without maintaining mappings of sessionIds, targetIds, frameIds, execution context IDs, backendNodeId ownership, and event listeners

- lacks the ability to register custom CDP commands, abstractions, and events

- lacks the ability to easily call chrome.\* extension APIs for things like `chrome.tabs.query({ active: true })`

- _lacks the ability to reference pages and elements with stable references across browser runs, such as XPath, URL, and frame index, instead of unstable identifiers like sessionId, targetId, frameId, backendNodeId_ (unrealistic dream? maybe not)

While I had high hopes for WebDriver BiDi, unfortunately it solves almost none of these issues.

ModCDP does not aim to solve all of these issues directly either. Instead it solves a simpler problem: allowing us to customize and extend CDP with new commands.
Then we use those basic primitives to fix the shortcomings in CDP by implementing our own custom events (all sent over a normal CDP websocket to a stock Chromium browser).

| Primitive              | What it does                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `Mod.evaluate`         | Run an expression in the ModCDP extension service worker, with `chrome.*` and a `cdp` bridge in scope |
| `Mod.addCustomCommand` | Register a `Custom.*` method handler that lives in the SW                                             |
| `Mod.addCustomEvent`   | Register a `Custom.*` event your SW handlers can `emit()`                                             |
| `Mod.addMiddleware`    | Intercept service-worker-routed requests, responses, or events by name or `*`                         |

Instead of inventing yet another browser driver library, ModCDP fixes the issue at the root.

It's perfectly compatible with playwright, puppeteer, etc. with no modifications. You can do things like `patchright` does, but generically at the CDP layer instead of having to patch libraries.

You can send `Mod.*`, `Custom.*`, etc. through standard Playwright/Puppeteer/other-driver-managed CDP sessions; `client/js/demo.ts`, `client/python/demo.py`, and `client/go/demo/main.go` demonstrate the flow in each language.

## Use it

```ts
import { ModCDPClient } from "modcdp";
import { z } from "zod";

// In stock Google Chrome, visit chrome://inspect/#remote-debugging first to
// expose the current browser at localhost:9222. Passing cdp_url is optional
// when that endpoint is live.
const cdp_url = "http://127.0.0.1:9222"; // ws://... URLs work too
const cdp = new ModCDPClient({
  cdp_url,
  routes: { "Target.getTargets": "service_worker" },
  server: { loopback_cdp_url: cdp_url, routes: { "*.*": "loopback_cdp" } },
});
await cdp.connect();

// use it like a normal CDP connection, send normal CDP, register for normal CDP events
console.log(await cdp.Browser.getVersion());
cdp.on(cdp.Target.targetInfoChanged, console.log);

// run extension code with chrome.* in scope
const tab = await cdp.Mod.evaluate({
  expression: "(await chrome.tabs.query({ active: true }))[0]",
});

// ✨ register and use custom CDP commands
await cdp.Mod.addCustomCommand({
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

await cdp.Mod.addCustomEvent(PageForegroundPageChanged);
await cdp.Mod.evaluate({
  expression: `chrome.tabs.onActivated.addListener(async ({ tabId }) =>
    cdp.emit("Page.foregroundPageChanged", {
      tabId,
      targetId: (await chrome.debugger.getTargets()).find(t => t.tabId === tabId)?.id ?? null
    })
  )`,
});
cdp.on(PageForegroundPageChanged, console.log);

// ✨ Intercept, modify, and extend existing CDP commands/results/events on the wire
await cdp.Mod.addMiddleware({
  name: cdp.Target.getTargets,
  phase: cdp.RESPONSE,
  // attach .tabId next to every .targetId in events browser emits
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

Upgrade any vanilla CDP client like Stagehand, Playwright, or Puppeteer transparently with support for `Mod.*` / `Custom.*` commands and events.

```sh
pnpm run proxy -- --upstream http://127.0.0.1:9222 --port 9223
# const browser = await playwright.chromium.connectOverCDP("http://127.0.0.1:9223")
# const session = await browser.contexts()[0].newCDPSession(page)
# await session.send("Mod.evaluate", { expression: "1 + 1" }) // -> 2
# ✨ All ModCDP commands now work through playwright! you can modify/extend playwright behavior to your heart's content
```

## Routing modes

`Mod.*` and `Custom.*` always go through the extension service worker. Routing only changes how _standard_ CDP methods (`Browser.*`, `Page.*`, `DOM.*`, …) are serviced:

| Demo CLI Flag | Standard CDP path                                                  | Use when                                                                        |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `--loopback`  | client → SW → SW dials its own WS back to localhost:9222 → CDP     | Default. You need the SW to intercept/inspect/rewrite normal traffic.           |
| `--debugger`  | client → SW → `chrome.debugger.sendCommand` against the active tab | The browser exposes no remote CDP port and you only have extension permissions. |
| `--direct`    | client → sends non-ModCDP commands to browser CDP directly         | You already have a CDP endpoint and don't need extension interception.          |

Pass via `routes: { "*.*": "direct_cdp" | "service_worker" }` on the client and `server: { routes: { "*.*": "loopback_cdp" | "chrome_debugger" } }` for the SW side. The demos default to `--loopback` (the most powerful mode).

## Repository layout

```
extension/                MV3 extension; service worker registers ModCDPServer
  manifest.json
  service_worker.ts
  ModCDPServer.ts
bridge/
  translate.ts           Pure stateless wrap/unwrap (used by both Node + SW)
  launcher.ts            Find chrome/chromium binary, spawn with CDP enabled
  injector.ts            Discover existing SW or Extensions.loadUnpacked it
  proxy.ts               Local CDP proxy (upgrades any vanilla CDP client)
client/
  js/ModCDPClient.ts + demo.ts
  python/ModCDPClient.py + demo.py
  go/ModCDPClient.go + demo/main.go
dist/                     Built JS output used by the extension and Node CLI scripts
```

## Requirements

- Stock Google Chrome can be used without relaunch flags: visit `chrome://inspect/#remote-debugging` to expose the current browser at `http://127.0.0.1:9222`, and load/install the ModCDP extension in that profile. Pass that endpoint as `cdp_url`, or set `scan_for_existing_localhost_9222: true` to let the JS client probe it before auto-launching a test browser.
- Automated/test browsers can still preload the extension with `--load-extension=<path>`. `Extensions.loadUnpacked` is used as a fallback when the connected browser exposes it over CDP.
- Node ≥ 22, Python ≥ 3.11 with `websocket-client`, Go ≥ 1.24 with `gobwas/ws`.

---

<details>
<summary><b>Architecture &amp; lifecycle</b></summary>

### Connect

1. Open a raw CDP websocket to the browser. If no `cdp_url` is supplied, the JS client auto-launches a test browser. Set `scan_for_existing_localhost_9222: true` to opt into trying the live stock-Chrome endpoint at `http://127.0.0.1:9222` before auto-launching.
2. `bridge/injector.js` either discovers an existing ModCDP service worker target or installs the extension via `Extensions.loadUnpacked` when the connected browser permits it.
3. Attach a session to that SW target and `Runtime.enable` on it.
4. Call `globalThis.ModCDP.configure(...)` to push the resolved loopback websocket and any explicit server route overrides into the SW. The clients do this automatically by default.

### Send

- `Mod.evaluate({ expression, params, cdpSessionId })` → `Runtime.evaluate` on the ext session, wrapping the expression with an IIFE that exposes `params` and `cdp = ModCDP.attachToSession(...)`.
- `Mod.addCustomCommand({ name, expression, ... })` → `Runtime.evaluate` calling `globalThis.ModCDP.addCustomCommand({ ... })` with the user expression embedded as the handler.
- `Mod.addCustomEvent(EventSchema.meta({ id }))` → `Runtime.addBinding({ name: "__ModCDP_<id>" })`, then a `Runtime.evaluate` registering the event in `globalThis.ModCDP`.
- `Mod.addMiddleware({ name, phase, expression })` → `Runtime.evaluate` registering a service-worker middleware for `phase: "request" | "response" | "event"`. Use `name: "*"` to match every method/event in that phase, or pass generated names like `cdp.Target.targetInfoChanged`.
- `Custom.X(params)` → `Runtime.evaluate` calling `globalThis.ModCDP.handleCommand("Custom.X", params, cdpSessionId)`.

### Receive

When SW handlers `cdp.emit('Custom.X', payload)`, the SW invokes `globalThis.__ModCDP_Custom_X(JSON.stringify({ event, data, cdpSessionId }))`. CDP delivers `Runtime.bindingCalled` on the ext session; the client (or proxy) decodes the payload, filters by `cdpSessionId`, and re-dispatches as a normal `cdp.on('Custom.X', ...)` event.

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
const clientRoutes = { "Mod.*": "service_worker", "Custom.*": "service_worker", "*.*": "service_worker" } as const;

// server-side defaults (inside the SW)
const serverRoutes = { "Mod.*": "service_worker", "Custom.*": "service_worker", "*.*": "auto" } as const;
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
    SDK -->|"1. cdp.on('Target.targetCreated', ...)"| WS
    SDK -->|"2. cdp.Target.createTarget({url})"| WS
  end

  subgraph Browser["Browser"]
    direction LR
    CDP["CDP router<br/>localhost:9222"]
    SW["Extension service worker<br/>CDP target / JS context"]
    Page["Page target<br/>chrome://newtab/"]
    CDP -->|"5. dispatch to page target"| Page
  end

  Socket["CDP socket"]

  WS -->|"3. CDP Target.createTarget"| Socket
  Socket -->|"4. Standard CDP"| CDP
  CDP -->|"6. create page target"| Page
  Page -->|"7. Target.targetCreated<br/>{targetInfo}"| CDP
  CDP -->|"8. Target.targetCreated<br/>{targetInfo}"| Socket
  Socket -->|"9. Target.targetCreated<br/>{targetInfo}"| WS
  WS -->|"10. emit('Target.targetCreated', {targetInfo})"| SDK

  classDef idle fill:#f7f7f7,stroke:#bbb,color:#777;
  class SW idle;
```

#### 3. ModCDP Custom Call / Response

```mermaid
flowchart LR
  subgraph Node["Node client"]
    direction LR
    SDK["SDK"]
    WS["WS client"]
    SDK -->|"1. cdp.send('Mod.evaluate', ...)"| WS
  end

  subgraph Browser["Browser"]
    direction LR
    ClientCDP["CDP Session for client<br/>localhost:9222"]
    LoopbackCDP["CDP Session for loopback<br/>localhost:9222"]
    SW["Extension service worker<br/>CDP target / JS context<br/>globalThis.ModCDP"]
    Page["Page target"]
    ClientCDP -->|"4. dispatch Runtime.evaluate(Mod.evaluate)"| SW
    LoopbackCDP -->|"7. Input.dispatchMouseEvent"| Page
    Page -->|"8. Input.dispatchMouseEvent result"| LoopbackCDP
    SW -. "<s>chrome.debugger</s><br/>not used" .-> Page
  end

  ClientSocket["client CDP socket.<br/>carries Mod.evaluate ..."]
  LoopbackSocket["loopback CDP socket.<br/>carries standard CDP only"]

  ClientSocket ~~~ LoopbackSocket
  WS -->|"2. Runtime.evaluate(Mod.evaluate)"| ClientSocket
  ClientSocket -->|"3. Runtime.evaluate(Mod.evaluate)"| ClientCDP
  SW -->|"5. WebSocket CDP loopback<br/>out of Browser<br/>Input.dispatchMouseEvent"| LoopbackSocket
  LoopbackSocket -->|"6. Input.dispatchMouseEvent"| LoopbackCDP
  LoopbackCDP -->|"9. Input.dispatchMouseEvent result"| LoopbackSocket
  LoopbackSocket -->|"10. Input.dispatchMouseEvent result<br/>back into Browser"| SW
  SW -->|"11. Runtime.evaluate(Mod.evaluate) result"| ClientCDP
  ClientCDP -->|"12. Runtime.evaluate(Mod.evaluate) result"| ClientSocket
  ClientSocket -->|"13. => {ok, action, target}"| WS
```

The same transport shape applies to `Mod.addCustomCommand`: the client installs a named command handler in the service worker, and later `cdp.send('Custom.someCommand', params)` is routed back through `globalThis.ModCDP.handleCommand(...)`.

#### 4. ModCDP Custom Event Listener / Event

```mermaid
flowchart LR
  subgraph Node["Node client"]
    direction LR
    SDK["SDK"]
    WS["WS client"]
    SDK -->|"1. cdp.on('Custom.demo', ...)"| WS
    SDK -->|"6. cdp.send('Mod.evaluate', ...)"| WS
  end

  subgraph Browser["Browser"]
    direction LR
    ClientCDP["CDP Session for client<br/>localhost:9222"]
    LoopbackCDP["CDP Session for loopback<br/>localhost:9222"]
    SW["Extension service worker<br/>CDP target / JS context<br/>ModCDP + bindings"]
    Page["Page target"]
    ClientCDP -->|"5. dispatch Runtime.evaluate(Mod.addCustomEvent)<br/>9. dispatch Runtime.evaluate(Mod.evaluate)"| SW
    LoopbackCDP -->|"12. Input.dispatchMouseEvent"| Page
    Page -->|"13. Input.dispatchMouseEvent result"| LoopbackCDP
    SW -. "<s>chrome.debugger</s><br/>not used" .-> Page
  end

  ClientSocket["client CDP socket.<br/>carries ModCDP ..."]
  LoopbackSocket["loopback CDP socket.<br/>carries standard CDP only"]

  ClientSocket ~~~ LoopbackSocket
  WS -->|"2. CDP Runtime.addBinding"| ClientSocket
  WS -->|"3. Mod.addCustomEvent<br/>7. Mod.evaluate(cdp.emit(...))"| ClientSocket
  ClientSocket <-->|"4. Runtime.evaluate(Mod.addCustomEvent)<br/>8. Runtime.evaluate(Mod.evaluate)"| ClientCDP
  SW -->|"10. WebSocket CDP loopback<br/>out of Browser<br/>Input.dispatchMouseEvent"| LoopbackSocket
  LoopbackSocket -->|"11. Input.dispatchMouseEvent"| LoopbackCDP
  LoopbackCDP -->|"14. Input.dispatchMouseEvent result"| LoopbackSocket
  LoopbackSocket -->|"15. Input.dispatchMouseEvent result<br/>service worker emits custom event"| SW
  SW -->|"16. Runtime.bindingCalled<br/>{name:'__ModCDP_Custom_demo', payload:'{event:Custom.demo,data:test}'}"| ClientCDP
  ClientCDP -->|"17. Standard CDP event<br/>Runtime.bindingCalled {name:'__ModCDP_Custom_demo', payload:'{event:Custom.demo,data:test}'}"| ClientSocket
  ClientSocket -->|"18. Standard CDP event<br/>Runtime.bindingCalled {name:'__ModCDP_Custom_demo', payload:'{event:Custom.demo,data:test}'}"| WS
  WS -->|"19. emit('Custom.demo', 'test')"| SDK
```

</details>

<details>
<summary><b>Constraints &amp; alternatives explored</b></summary>

**Constraints**

- This does not add real CDP methods to Chrome — the wire methods stay `Runtime.evaluate` + `Runtime.bindingCalled`. The `Mod.*` / `Custom.*` namespace is a client + SW convention.
- Page JS does not see custom commands or event bindings.
- Stock Google Chrome's `chrome://inspect/#remote-debugging` toggle can expose the current browser at `localhost:9222` without relaunching with `--remote-debugging-port`, `--enable-unsafe-extension-debugging`, or `--remote-allow-origins=*`.
- If `Extensions.loadUnpacked` is unavailable in the connected browser, load/install the ModCDP extension in that Chrome profile once and reconnect; the injector will use the discovery path.

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

<details>
<summary><b>macOS Chrome compatibility matrix (tested 2026-05-01)</b></summary>

Tested browsers:

- `/Applications/Google Chrome.app` — Google Chrome `148.0.7778.96 beta`
- `/Applications/Google Chrome Canary.app` — Google Chrome `149.0.7819.0 canary`
- Playwright Chrome for Testing — `147.0.7727.15`

Latency columns:

- `direct` — ModCDP client to browser raw CDP `Page.getFrameTree` against an attached `chrome://newtab/` page target.
- `pong` — ModCDP client to browser to extension service worker `Mod.pong` round trip.
- `loopback` — ModCDP client to browser to extension service worker to loopback CDP to browser `Page.getFrameTree`.
- `debugger` — ModCDP client to browser to extension service worker to `chrome.debugger.sendCommand` `Page.getFrameTree`.

The launched-browser rows used an isolated temporary user data dir. The live/default-profile row is separate because it depends on the user enabling Chrome's `chrome://inspect/#remote-debugging` flow and accepting Chrome's connection prompt.

| Browser                           | UI               | Mode         | Works | `chrome.tabs.query` | `chrome.debugger` | `Browser.getVersion` | `Target.getTargets` | Default profile | direct ms | pong ms | loopback ms | debugger ms |
| --------------------------------- | ---------------- | ------------ | ----- | ------------------- | ----------------- | -------------------- | ------------------- | --------------- | --------: | ------: | ----------: | ----------: |
| Chrome Beta 148                   | `--headless=new` | `--direct`   | yes   | yes                 | no                | yes                  | yes                 | no              |       4.8 |       3 |           - |           - |
| Chrome Beta 148                   | `--headless=new` | `--loopback` | yes   | yes                 | no                | yes                  | yes                 | no              |       2.3 |       2 |        13.5 |           - |
| Chrome Beta 148                   | `--headless=new` | `--debugger` | no    | yes                 | no                | no                   | no                  | no              |       5.3 |       5 |           - |           - |
| Chrome Beta 148                   | headful          | `--direct`   | yes   | yes                 | no                | yes                  | yes                 | no              |       5.1 |       1 |           - |           - |
| Chrome Beta 148                   | headful          | `--loopback` | yes   | yes                 | no                | yes                  | yes                 | no              |       2.4 |       1 |        13.5 |           - |
| Chrome Beta 148                   | headful          | `--debugger` | no    | yes                 | no                | no                   | no                  | no              |       2.2 |       2 |           - |           - |
| Chrome Canary 149                 | `--headless=new` | `--direct`   | yes   | yes                 | yes               | yes                  | yes                 | no              |       2.2 |       1 |           - |           - |
| Chrome Canary 149                 | `--headless=new` | `--loopback` | yes   | yes                 | yes               | yes                  | yes                 | no              |       2.6 |       1 |        14.4 |           - |
| Chrome Canary 149                 | `--headless=new` | `--debugger` | yes   | yes                 | yes               | no                   | no                  | no              |       2.1 |       1 |           - |         1.4 |
| Chrome Canary 149                 | headful          | `--direct`   | yes   | yes                 | yes               | yes                  | yes                 | no              |       2.4 |       1 |           - |           - |
| Chrome Canary 149                 | headful          | `--loopback` | yes   | yes                 | yes               | yes                  | yes                 | no              |       2.2 |       1 |        13.5 |           - |
| Chrome Canary 149                 | headful          | `--debugger` | yes   | yes                 | yes               | no                   | no                  | no              |       2.3 |       0 |           - |         1.2 |
| Playwright Chrome for Testing 147 | `--headless=new` | `--direct`   | yes   | yes                 | yes\*             | yes                  | yes                 | no              |       2.3 |       3 |           - |           - |
| Playwright Chrome for Testing 147 | `--headless=new` | `--loopback` | yes   | yes                 | yes\*             | yes                  | yes                 | no              |       1.9 |       1 |        13.0 |           - |
| Playwright Chrome for Testing 147 | `--headless=new` | `--debugger` | yes   | yes                 | yes\*             | no                   | no                  | no              |       2.6 |       1 |           - |         0.7 |
| Playwright Chrome for Testing 147 | headful          | `--direct`   | yes   | yes                 | yes\*             | yes                  | yes                 | no              |       2.0 |       1 |           - |           - |
| Playwright Chrome for Testing 147 | headful          | `--loopback` | yes   | yes                 | yes\*             | yes                  | yes                 | no              |       2.4 |       1 |        12.5 |           - |
| Playwright Chrome for Testing 147 | headful          | `--debugger` | yes   | yes                 | yes\*             | no                   | no                  | no              |       2.1 |       1 |           - |         1.2 |

`*` Playwright Chrome for Testing exposes `chrome.debugger` when the ModCDP extension is launched with `--load-extension`. With auto-injection only, `--direct` and `--loopback` still work, but `chrome.debugger` is not available in the borrowed/injected service worker.

Live/default-profile status:

| Browser                           | UI               | Mode     | Result                                                                                                 |
| --------------------------------- | ---------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| Chrome Beta 148                   | `--headless=new` | `--live` | not applicable                                                                                         |
| Chrome Beta 148                   | headful          | `--live` | current advertised `DevToolsActivePort` was stale; websocket failed with `ECONNREFUSED 127.0.0.1:9222` |
| Chrome Canary 149                 | `--headless=new` | `--live` | not applicable                                                                                         |
| Chrome Canary 149                 | headful          | `--live` | no active live endpoint found                                                                          |
| Playwright Chrome for Testing 147 | `--headless=new` | `--live` | not applicable                                                                                         |
| Playwright Chrome for Testing 147 | headful          | `--live` | no active live endpoint found                                                                          |

Minimum viable macOS CLI args:

| Mode                  | Browsers                          | Args                                                                                                                                   |
| --------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `--direct` headful    | all three                         | `--remote-debugging-port=<port> --user-data-dir=<temp-profile> chrome://newtab/`                                                       |
| `--direct` headless   | all three                         | `--headless=new --remote-debugging-port=<port> --user-data-dir=<temp-profile> chrome://newtab/`                                        |
| `--loopback` headful  | all three                         | `--remote-debugging-port=<port> --user-data-dir=<temp-profile> --remote-allow-origins=* chrome://newtab/`                              |
| `--loopback` headless | all three                         | `--headless=new --remote-debugging-port=<port> --user-data-dir=<temp-profile> --remote-allow-origins=* chrome://newtab/`               |
| `--debugger`          | Chrome Beta 148                   | no working set found; `chrome.debugger` is unavailable in the extension service worker                                                 |
| `--debugger` headful  | Chrome Canary 149                 | `--remote-debugging-port=<port> --user-data-dir=<temp-profile> chrome://newtab/`                                                       |
| `--debugger` headless | Chrome Canary 149                 | `--headless=new --remote-debugging-port=<port> --user-data-dir=<temp-profile> chrome://newtab/`                                        |
| `--debugger` headful  | Playwright Chrome for Testing 147 | `--remote-debugging-port=<port> --user-data-dir=<temp-profile> --load-extension=<repo>/dist/extension chrome://newtab/`                |
| `--debugger` headless | Playwright Chrome for Testing 147 | `--headless=new --remote-debugging-port=<port> --user-data-dir=<temp-profile> --load-extension=<repo>/dist/extension chrome://newtab/` |

Recommended full macOS launch args:

```bash
--remote-debugging-port=<port>
--user-data-dir=<temp-profile>
--remote-allow-origins=*
--enable-unsafe-extension-debugging
--load-extension=<repo>/dist/extension
--no-first-run
--no-default-browser-check
--disable-default-apps
--disable-background-networking
--disable-backgrounding-occluded-windows
--disable-renderer-backgrounding
--disable-background-timer-throttling
--disable-sync
--password-store=basic
--use-mock-keychain
chrome://newtab/
```

Add `--headless=new` for headless launches. Do not pass `--no-sandbox`, `--disable-gpu`, or `--remote-debugging-address` on macOS. On Linux only, pass `--no-sandbox` when there is no usable sandbox/display environment.

</details>
