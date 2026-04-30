# MagicCDP

CDP sucks today. It's hard for agents and humans to use without a wrapper library because it lacks:

- the ability to use it statelessly without bookkeeping `sessionId` / `targetId` / `frameId` / execution-context-id / `backendNodeId` ownership and event-listener mappings
- the ability to register **custom CDP commands / abstractions / events**
- the ability to easily call `chrome.*` extension APIs (e.g. `chrome.tabs.query({active: true})`) from your CDP client
- the ability to reference pages and elements with stable refs across browser runs (e.g. `xpath`, `url`, `frameIdx` instead of `backendNodeId` / `targetId` / `frameId`)

> Reference: [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/)

WebDriver BiDi solves almost none of these. Instead of inventing yet another browser-driver library, **MagicCDP fixes the problem at the root**: it exposes 3 new primitives on top of vanilla CDP that you can compose to build whatever higher-level abstractions you want.

- `Magic.evaluate` — run JS in the **MagicCDP extension service worker** target, where `chrome.*` APIs and `cdp` callbacks back to the client are available.
- `Magic.addCustomCommand` — register a custom CDP command handled by a JS expression you provide.
- `Magic.addCustomEvent` — register a custom CDP event type with an expected payload schema.

Everything is delivered over the **normal CDP WebSocket transport**, with no IPC / native messaging / external relay process. An auto-injected extension acts as the bridge.

## Install / Run

This repo is a single-file PoC. To run the demo:

```sh
node client.mjs                      # uses the default chromium path baked into client.mjs
node client.mjs /path/to/chromium    # override
```

## Usage

```ts
import { MagicCDPClient } from "./magic-cdp.mjs";

const cdp = await new MagicCDPClient({
  cdp_url: "http://localhost:9222", // or "ws://localhost:9222/devtools/browser/..."
}).connect();
```

### 1. Run code in the extension service worker (with `chrome.*` access)

```ts
const foregroundTab = await cdp.send("Magic.evaluate", {
  script: "async (params) => (await chrome.tabs.query({ active: true, ...params }))[0]",
  params: { lastFocusedWindow: true },
});
console.log(foregroundTab.url);
```

### 2. Register a custom CDP command

```ts
await cdp.send("Magic.addCustomCommand", {
  customMethod: "Custom.getForegroundTabInfo",
  paramsSchema: cdp.types.chrome?.tabs?.queryInfo, // any zod / jsonschema / chrome.* shape
  resultSchema: cdp.types.chrome?.tabs?.Tab,
  script:
    "async (queryInfo) => (await chrome.tabs.query({ active: true, lastFocusedWindow: true, ...queryInfo }))[0]",
});

const tab = await cdp.send("Custom.getForegroundTabInfo");
console.log(tab.url);
```

### 3. Register a custom CDP event + logic to trigger it

```ts
await cdp.send("Magic.addCustomEvent", {
  customEvent: "Custom.foregroundTabChanged",
  resultSchema: { tabId: "number", windowId: "number" },
});

await cdp.send("Magic.evaluate", {
  script: `async (_, server) => {
    chrome.tabs.onActivated.addListener((info) => {
      server.emit("Custom.foregroundTabChanged", { tabId: info.tabId, windowId: info.windowId });
    });
  }`,
});

cdp.on("Custom.foregroundTabChanged", console.log);
```

The same `cdp.on("...")` works for stock CDP events — anything that doesn't start with `Magic.` / `Custom.` is dispatched from the raw CDP socket directly.

## Architecture

### Lifecycle

1. User constructs `const cdp = new MagicCDPClient({ cdp_url })`.
2. `await cdp.connect()`:
   - opens the raw browser CDP WebSocket → kept on `cdp._cdp`.
   - discovers the MagicCDP extension's service worker target (loaded via `--load-extension` or `Extensions.loadUnpacked`) and attaches it as a flat session → `cdp._extTargetId`, `cdp._extCdpSessionId`.
   - registers a single binding via `Runtime.addBinding({ name: "__magic_event" })`.
   - **bootstraps the entire `MagicCDPServer`** into the service worker via one `Runtime.evaluate`. This installs `Magic.addCustomCommand`, `Magic.addCustomEvent`, `Magic.evaluate`, and `Magic.ping` on the server side.
   - sends a `Magic.ping` and waits for the `Magic.pong` round-trip event. Stores `cdp.latency`.
3. `cdp.send("Magic.addCustomCommand", { customMethod, script, ... })` registers a handler in the SW.
4. `cdp.send("Magic.evaluate", { script, params })` runs `script` in the SW with `(params, server)`. Use `server.emit(eventName, payload)` to fire custom events.
5. `cdp.on("Custom.someEvent", listener)`:
   - SW emits via `globalThis.__magic_event(JSON.stringify({ event, data }))`.
   - Browser delivers a `Runtime.bindingCalled` CDP event back over the existing socket.
   - The client maps it to local listeners on the corresponding event name.

### `MagicCDPClient`

- `connect()` — raw CDP open → discover SW target → attach flat session → `Runtime.enable` + `Runtime.addBinding` → bootstrap server → handshake.
- `send(method, params, { sessionId? })` — routes per the `routes` config (see below).
- `on(event, listener)` — `Magic.*` / `Custom.*` listen via the binding bus, everything else is forwarded to the raw CDP socket.
- `close()` — closes the WS.

### `MagicCDPServer`

Lives in the extension service worker. The shipped `extension/service_worker.js` is **intentionally empty** — every server primitive is installed at runtime by the client's bootstrap `Runtime.evaluate`. The extension only exists so the browser keeps a service-worker target alive with the right `chrome.*` permissions.

`manifest.json` requests the `debugger` permission (needed if a future `chrome_debugger` route is enabled) and `tabs` (for the demo). Strip these if you only use `loopback_cdp` / `direct_cdp` routes.

## Routing of non-`Magic.*` standard CDP commands

Every command flows through one of four routes:

```
type CDPUpstream = "service_worker" | "direct_cdp" | "loopback_cdp" | "chrome_debugger"
```

Configured per glob:

```ts
const cdp = new MagicCDPClient({
  direct_cdp_url: "http://some-remote-host:9222",
  routes: {
    "Magic.*": "service_worker",
    "Custom.*": "service_worker",
    "*.*":      "direct_cdp",       // or "service_worker" to make the SW intercept *everything*
  },
  server: {
    loopback_cdp_url: "http://localhost:9222",
    routes: {
      "Magic.*":   "service_worker",
      "Custom.*":  "service_worker",
      "Browser.*": "loopback_cdp",  // chrome.debugger doesn't support Browser.*
      "*.*":       "chrome_debugger",
    },
  },
});
```

Server-side helpers (planned): `MagicCDPServer.discoverLoopbackCDP()`, `requestLoopbackCDP()`, `requestDebuggerCDP()`.

## Files

- `magic-cdp.mjs` — the `MagicCDPClient` library + the inlined `MagicCDPServer` bootstrap.
- `client.mjs` — Chromium launcher + end-to-end demo of all three primitives.
- `extension/service_worker.js` — empty by design.
- `extension/manifest.json` — minimal MV3 manifest.

## Constraints

- This does not literally add `Custom.*` to Chrome; routing is owned by the client.
- The SW target must be visible in `/json/list`. Discovery is by URL suffix `/service_worker.js`.
- `--remote-allow-origins=*` is required so the SW can dial the local CDP port for loopback (when used).
- Page JS never sees the MagicCDP control plane — everything happens in the SW target.
