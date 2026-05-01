# MagicCDP

CDP sucks today. It is difficult for agents and humans to use without a library because it lacks:

- the ability to use it statelessly without maintaining mappings of sessionIds, targetIds, frameIds, execution context IDs, backendNodeId ownership, and event listeners
- the ability to register custom CDP commands, abstractions, and events
- the ability to easily call `chrome.*` extension APIs for things like `chrome.tabs.query({ active: true })`
- the ability to reference pages and elements with stable references across browser runs, such as XPath, URL, and frame index, instead of backendNodeId, targetId, and frameId

- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/)

While I had high hopes for WebDriver BiDi, unfortunately it solves almost none of these issues.

`MagicCDP` does not aim to solve all of these issues directly either. It exposes three new primitives that you can use to customize and extend CDP:

- `Magic.evaluate`: run code in the `MagicCDP` extension service worker target, where `chrome.*` APIs and a `cdp` bridge back to the client are available
- `Magic.addCustomCommand`: register a custom CDP command that is handled by the expression you provide
- `Magic.addCustomEvent`: register a custom CDP event type with an expected payload schema

Instead of inventing yet another browser driver library, MagicCDP fixes the issue at the root.

MagicCDP uses an automatically injected extension bridge, giving you the ability to keep using the normal CDP websocket transport with extra features that work without IPC, native messaging, or external services for custom side-channel messages.

```ts
import { MagicCDPClient } from 'magic-cdp'

const cdp = await MagicCDPClient({
  cdp_url: 'http://localhost:9222', // ws://..., http://..., and https://... CDP endpoints work
}).connect()
```

## Run Extension Code

Run code in an extension service worker context with access to `chrome.runtime`, `chrome.tabs`, and other extension APIs:

```ts
const foregroundTab = await cdp.send('Magic.evaluate', {
  expression: '(await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]',
})

console.log(foregroundTab.url)
```

## Register Custom Commands

Make extension snippets reusable by registering them as custom CDP commands:

```ts
await cdp.send('Magic.addCustomCommand', {
  name: 'Custom.getForegroundTabInfo',
  paramsSchema: cdp.types.chrome.tabs.queryInfo,
  resultSchema: cdp.types.chrome.tabs.Tab,
  expression: 'async (queryInfo) => (await chrome.tabs.query({ active: true, lastFocusedWindow: true, ...queryInfo }))[0]',
})

const foregroundTab = await cdp.send('Custom.getForegroundTabInfo')
console.log(foregroundTab.url)
```

Schemas are currently metadata. JSON-schema-like values are mirrored into the extension; non-JSON schema objects such as Zod values are kept on the client.

## Register Custom Events

Register a custom event name and expected payload shape, then install logic that emits it:

```ts
await cdp.send('Magic.addCustomEvent', {
  name: 'Custom.foregroundTargetChanged',
  payloadSchema: z.object({ targetId: cdp.types.Target.TargetId }),
})

await cdp.send('Magic.evaluate', {
  expression: `async ({ cdpSessionId }) => {
    const cdp = MagicCDP.attachToSession(cdpSessionId)

    chrome.tabs.onActivated.addListener(async (activeInfo) => {
      const targets = await chrome.debugger.getTargets()
      const target = targets.find(target => target.tabId === activeInfo.tabId)
      if (target) await cdp.emit('Custom.foregroundTargetChanged', { targetId: target.id })
    })
  }`,
  params: { cdpSessionId: cdp.sessionId },
})

cdp.on('Custom.foregroundTargetChanged', console.log)
```

If `cdpSessionId` is omitted, emitted custom events are broadcast to all connected CDP clients that installed the same event binding.

## Current Repository

- `client.mjs`: exports `MagicCDPClient`, `MagicCDP`, and `RawCDP`; it also contains a small runnable demo when executed directly.
- `extension/service_worker.js`: exposes `globalThis.MagicCDP` and `globalThis.Magic` inside the extension service worker.
- `extension/manifest.json`: MV3 extension manifest with `tabs` access and optional `debugger` access.

Run the local demo:

```sh
CHROME_PATH="/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" node client.mjs
```

Or pass a Chromium or Chrome Canary executable:

```sh
node client.mjs "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
```

Stock Google Chrome is intentionally rejected for local launches. Chrome Canary is currently the verified path for `Extensions.loadUnpacked`; local Chromium builds also work if they expose that CDP method with `--enable-unsafe-extension-debugging`.

## Architecture

### Lifecycle

1. User creates a client in their local Node process:

```ts
const cdp = MagicCDPClient({ cdp_url })
```

2. `await cdp.connect()`:

- connects to the running browser through normal raw CDP and stores that websocket in `cdp._cdp`
- loads the MagicCDP extension with `Extensions.loadUnpacked(...)`
- discovers and attaches to the `chrome-extension://<magiccdpserverid>/service_worker.js` service worker target
- configures server-side routing defaults in the service worker
- sends one `Magic.ping` custom command and waits for a `Magic.pong` custom event to confirm round-trip behavior
- updates `cdp._extTargetId` and `cdp._extCdpSessionId` to point to the extension service worker target

3. `await cdp.send('Magic.addCustomEvent', { name: 'Custom.someEvent' })`:

- calls `Runtime.addBinding({ name: '__MagicCDP_Custom_someEvent' })` on the extension service worker session
- registers the event name and binding name in `globalThis.MagicCDP`
- maps later `Runtime.bindingCalled` payloads back to local `cdp.on(...)` listeners

4. `await cdp.send('Magic.evaluate', { expression })`:

- calls `Runtime.evaluate` on the extension service worker session
- evaluates the provided expression; function expressions are called with `(params, context)`
- exposes `context.cdp`, `context.MagicCDP`, `context.chrome`, and the extension global `MagicCDP`

5. `cdp.on('Custom.someEvent', listener)`:

- listens locally on the Node client
- receives events emitted by extension code through `cdp.emit(...)`
- filters events by `cdp.sessionId` when the event was emitted to a specific session

### `MagicCDPClient`

`connect()` handles:

- initial raw CDP connection to the browser
- extension upload or discovery
- service worker target attachment
- `Runtime.enable` and `Runtime.addBinding` setup
- base custom event setup for `Magic.pong`
- `Magic.ping` latency measurement

`send(method, params, options)` routes:

- `Magic.evaluate`, `Magic.addCustomCommand`, and `Magic.addCustomEvent` through built-in client handlers
- `Magic.*` and `Custom.*` commands through the extension service worker by default
- standard CDP commands directly to the browser CDP websocket by default

### `MagicCDPServer`

`MagicCDPServer` lives inside the injected extension service worker.

The service worker can be very small because the client can bootstrap behavior with `Runtime.evaluate`. In practice this repository defines `MagicCDPServer` in `service_worker.js` so startup is faster and the core primitives are available immediately.

The extension exists to guarantee there is at least one target with the required `chrome.*` APIs enabled through extension permissions. `manifest.json` declares `tabs` access by default and `debugger` as optional permission for users who want `chrome_debugger` upstream routing.

Available server helpers:

```ts
MagicCDPServer.discoverLoopbackCDP()
MagicCDPServer.requestLoopbackCDP()
MagicCDPServer.requestDebuggerCDP()
MagicCDPServer.attachToSession(cdpSessionId)
```

## Routing

Users can customize how non-`Magic.*` CDP commands are handled.

```ts
type CDPUpstream =
  | 'service_worker'
  | 'direct_cdp'
  | 'loopback_cdp'
  | 'chrome_debugger'
```

Client mode A sends non-`Magic.*` commands directly to the browser CDP target with no extension involvement:

```ts
const version = await cdp.send('Browser.getVersion')
```

Client mode B sends non-`Magic.*` commands to the extension service worker target and lets it intercept, manage, reject, or forward them:

```ts
const cdp = MagicCDPClient({
  direct_cdp_url: 'http://some-remote-host:9222',
  routes: {
    'Magic.*': 'service_worker',
    'Custom.*': 'service_worker',
    '*.*': 'service_worker',
  },
  server: {
    loopback_cdp_url: 'http://localhost:9222',
    routes: {
      'Magic.*': 'service_worker',
      'Custom.*': 'service_worker',
      'Browser.*': 'loopback_cdp',
      '*.*': 'chrome_debugger',
    },
  },
})
```

Server modes:

- `service_worker`: handle commands in the extension service worker
- `loopback_cdp`: forward commands through a CDP websocket reachable from the browser, useful for `Browser.*` commands that `chrome.debugger` does not support
- `chrome_debugger`: forward target-scoped commands through `chrome.debugger.sendCommand`, which requires a `debuggee`, `tabId`, `targetId`, or `extensionId` in params

The default client route is conservative:

```ts
{
  'Magic.*': 'service_worker',
  'Custom.*': 'service_worker',
  '*.*': 'direct_cdp',
}
```

The default server route is:

```ts
{
  'Magic.*': 'service_worker',
  'Custom.*': 'service_worker',
  'Browser.*': 'loopback_cdp',
  '*.*': 'chrome_debugger',
}
```
