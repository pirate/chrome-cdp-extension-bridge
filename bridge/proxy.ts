// proxy.js: a transparent local CDP proxy that "upgrades" any vanilla CDP
// client to speak Magic.* / Custom.*. By default listens on ws://127.0.0.1:9223
// and forwards to http://127.0.0.1:9222.
//
// Behavior on each client connection:
//   - If the upstream isn't reachable and { autoLaunch: true }, launch a local
//     Chrome via launcher.js and use it as the upstream.
//   - Inject the MagicCDP extension service worker via injector.js if needed
//     (single source of truth for that precedence + error messages).
//   - Stand up a hidden CDP session attached to the SW; rewrite Magic.* /
//     Custom.* outbound and Runtime.bindingCalled inbound; forward everything
//     else unchanged.
//
// Run as a CLI:
//   node proxy.js --port 9223 --upstream http://127.0.0.1:9222
//
// Or import { startProxy } and embed.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import type { RawData, WebSocket as ClientWebSocket } from "ws";

import { launchChrome } from "./launcher.js";
import { injectExtensionIfNeeded } from "./injector.js";
import {
  bindingNameFor,
  wrapMagicEvaluate,
  wrapMagicAddCustomCommand,
  wrapMagicAddMiddleware,
  wrapMagicAddCustomEvent,
  wrapCustomCommand,
  unwrapResponseIfNeeded,
  unwrapEventIfNeeded,
} from "./translate.js";
import type {
  CdpCommandFrame,
  CdpEventFrame,
  CdpResponseFrame,
  CdpFrame,
  ProtocolParams,
  ProtocolResult,
  ProxyConnectionState,
  ProxyUpstreamState,
} from "../types/magic.js";
import {
  CdpCommandFrameSchema,
  CdpEventFrameSchema,
  CdpResponseFrameSchema,
  MagicAddCustomCommandParamsSchema,
  MagicAddCustomEventParamsSchema,
  MagicAddMiddlewareParamsSchema,
  MagicEvaluateParamsSchema,
  normalizeMagicName,
} from "../types/magic.js";
import { events } from "../types/zod.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXTENSION_PATH = path.join(ROOT, "extension");
const DEFAULT_PORT = 9223;
const DEFAULT_UPSTREAM = "http://127.0.0.1:9222";

const DEBUG = process.env.PROXY_DEBUG === "1";
const log = (...args) => console.log("[proxy]", ...args);
const dbg = (...args) => {
  if (DEBUG) console.log("[proxy:dbg]", ...args);
};

const MAGIC_METHODS = new Set([
  "Magic.evaluate",
  "Magic.addCustomCommand",
  "Magic.addCustomEvent",
  "Magic.addMiddleware",
]);
const ROUTE_TO_SW_RE = /^(Magic|Custom)\./;
const isWsUrl = (url) => /^wss?:\/\//i.test(url);

function liveBrowserWsUrl(endpoint: string) {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/devtools/browser";
  url.search = "";
  url.hash = "";
  return url.toString();
}

// --- public API -------------------------------------------------------------

export async function startProxy({
  port = DEFAULT_PORT,
  upstream = DEFAULT_UPSTREAM,
  extensionPath = DEFAULT_EXTENSION_PATH,
  autoLaunch = true,
  launchOptions = {},
}: {
  port?: number;
  upstream?: string;
  extensionPath?: string;
  autoLaunch?: boolean;
  launchOptions?: Parameters<typeof launchChrome>[0];
} = {}) {
  // Per-process upstream: lazily probed on first connection. If reachable, use
  // it. Otherwise launch a local Chrome and remember it.
  const upstreamState: ProxyUpstreamState = { url: upstream, launched: null };

  const server = http.createServer(async (req, res) => {
    try {
      await ensureUpstream(upstreamState, { autoLaunch, launchOptions });
      if (isWsUrl(upstreamState.url)) {
        if (req.url === "/json/version") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://${req.headers.host}/devtools/browser/proxy` }));
        } else {
          res.writeHead(404);
          res.end("HTTP discovery is unavailable for a ws:// upstream.");
        }
        return;
      }
      const upstreamRes = await fetch(`${upstreamState.url}${req.url}`);
      const text = await upstreamRes.text();
      const contentType = upstreamRes.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const body = JSON.parse(text);
        rewriteWsUrls(body, req.headers.host);
        res.writeHead(upstreamRes.status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      } else {
        res.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers));
        res.end(text);
      }
    } catch (error) {
      res.writeHead(502);
      res.end(error.message);
    }
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (client, req) => {
    log("client connected", req.url);
    // attach a synchronous early-buffer immediately so we don't lose frames
    // sent before bootstrap (e.g. Playwright's first commands).
    const earlyBuffer = [];
    const earlyHandler = (buf) => earlyBuffer.push(buf);
    client.on("message", earlyHandler);
    handleConnection(client, earlyBuffer, earlyHandler, upstreamState, {
      extensionPath,
      autoLaunch,
      launchOptions,
    }).catch((err) => {
      log("connection failed:", err.message);
      try {
        client.close(1011, err.message.slice(0, 120));
      } catch {}
    });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  log(`listening on ws://127.0.0.1:${port}/  (upstream: ${upstreamState.url})`);

  return {
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (upstreamState.launched) await upstreamState.launched.close();
    },
  };
}

// --- upstream probe / lazy launch ------------------------------------------

async function ensureUpstream(
  upstreamState: ProxyUpstreamState,
  { autoLaunch, launchOptions }: { autoLaunch: boolean; launchOptions: Parameters<typeof launchChrome>[0] },
) {
  if (isWsUrl(upstreamState.url)) return;
  try {
    const r = await fetch(`${upstreamState.url}/json/version`);
    if (r.ok) {
      const { webSocketDebuggerUrl } = await r.json();
      if (!webSocketDebuggerUrl)
        throw new Error(`GET ${upstreamState.url}/json/version returned no webSocketDebuggerUrl`);
      upstreamState.url = webSocketDebuggerUrl;
      return;
    }
    if (r.status === 404) {
      upstreamState.url = liveBrowserWsUrl(upstreamState.url);
      return;
    }
  } catch {}
  if (!autoLaunch) {
    throw new Error(
      `Upstream CDP at ${upstreamState.url} is not reachable. Pass --no-auto-launch only when an upstream is already running.`,
    );
  }
  // dedupe concurrent launch attempts: stash the in-flight promise on
  // upstreamState so callers racing into ensureUpstream all await the same
  // single launchChrome.
  if (!upstreamState.launchPromise) {
    log(`upstream ${upstreamState.url} not reachable, launching local Chrome...`);
    upstreamState.launchPromise = launchChrome(launchOptions)
      .then((launched) => {
        upstreamState.launched = launched;
        upstreamState.url = launched.wsUrl;
        log(`launched local Chrome at ${upstreamState.url}`);
        return launched;
      })
      .catch((err) => {
        upstreamState.launchPromise = null;
        throw err;
      });
  }
  await upstreamState.launchPromise;
}

function rewriteWsUrls(value: unknown, host: string) {
  if (!value || typeof value !== "object") return;
  if ("webSocketDebuggerUrl" in value && typeof value.webSocketDebuggerUrl === "string") {
    value.webSocketDebuggerUrl = value.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://${host}`);
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) rewriteWsUrls(child, host);
}

// --- per-connection bridging ----------------------------------------------

async function handleConnection(
  client: ClientWebSocket,
  earlyBuffer: RawData[],
  earlyHandler: (buf: RawData) => void,
  upstreamState: ProxyUpstreamState,
  {
    extensionPath,
    autoLaunch,
    launchOptions,
  }: { extensionPath: string; autoLaunch: boolean; launchOptions: Parameters<typeof launchChrome>[0] },
) {
  await ensureUpstream(upstreamState, { autoLaunch, launchOptions });

  const upstream = new WebSocket(upstreamState.url, { origin: undefined });
  await new Promise((resolve, reject) => {
    upstream.addEventListener("open", resolve, { once: true });
    upstream.addEventListener("error", reject, { once: true });
  });

  // per-connection state
  const state: ProxyConnectionState = {
    client,
    upstream,
    nextUpstreamId: 1_000_000,
    pending: new Map(), // upstreamId -> { kind, clientId?, clientSessionId?, ... }
    extSessionId: null,
    extTargetId: null,
    hiddenSessionIds: new Set(), // sessions we attached for ourselves
    hiddenTargetIds: new Set(), // SW target the client must never see
    clientSessionIds: new Set(), // session ids the client has attached
    bootstrapped: false,
    queuedFromClient: [],
  };

  upstream.addEventListener("message", (event) => {
    let msg: CdpResponseFrame | CdpEventFrame;
    try {
      const parsed = JSON.parse(String(event.data));
      msg = "id" in parsed ? CdpResponseFrameSchema.parse(parsed) : CdpEventFrameSchema.parse(parsed);
    } catch (e) {
      log("upstream parse error", e.message);
      return;
    }
    dbg("upstream->", msg.id ?? "", msg.method ?? "(response)", msg.sessionId ?? "");
    handleUpstreamMessage(state, msg);
  });
  upstream.addEventListener("close", () => {
    try {
      client.close();
    } catch {}
  });
  upstream.addEventListener("error", () => {
    log("upstream ws error");
    try {
      client.close(1011, "upstream error");
    } catch {}
  });
  client.on("close", () => {
    try {
      upstream.close();
    } catch {}
  });

  // Bootstrap: ensure the MagicCDP extension is present and attach a hidden
  // session to it. All single-source-of-truth precedence + error messaging
  // lives in injector.js; the proxy just consumes its result.
  const sendInternal = (method: string, params: ProtocolParams = {}, sessionId: string | null = null) =>
    new Promise<ProtocolResult>((resolve, reject) => {
      const id = state.nextUpstreamId++;
      state.pending.set(id, { kind: "internal", resolve, reject });
      const message: CdpCommandFrame = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      upstream.send(JSON.stringify(message));
    });

  const ext = await injectExtensionIfNeeded({ send: sendInternal, extensionPath });
  state.extSessionId = ext.sessionId;
  state.extTargetId = ext.targetId;
  state.hiddenSessionIds.add(ext.sessionId);
  state.hiddenTargetIds.add(ext.targetId);
  await sendInternal("Runtime.enable", {}, ext.sessionId);
  log(`extension ${ext.source} (${ext.extensionId}); ext session ${ext.sessionId}`);

  // Swap the early-buffer handler for the real one. Drain anything that
  // arrived before we got here.
  client.off("message", earlyHandler);
  for (const buf of earlyBuffer) state.queuedFromClient.push(buf);
  client.on("message", (buf) => {
    if (!state.bootstrapped) {
      state.queuedFromClient.push(buf);
      return;
    }
    handleClientMessage(state, buf);
  });
  state.bootstrapped = true;
  for (const buf of state.queuedFromClient) handleClientMessage(state, buf);
  state.queuedFromClient = [];
}

function handleClientMessage(state: ProxyConnectionState, buf: RawData) {
  let msg: CdpCommandFrame;
  try {
    msg = CdpCommandFrameSchema.parse(JSON.parse(String(buf)));
  } catch (e) {
    log("client parse error", e.message);
    return;
  }
  dbg("client->", msg.id ?? "", msg.method, msg.sessionId ?? "");
  const { id, method, params = {}, sessionId } = msg;

  // route a Magic.* / Custom.* command into a Runtime.evaluate against the
  // hidden ext session, while remembering the originating client id+session
  // so the response can be steered back to the right Playwright CDPSession.
  if (MAGIC_METHODS.has(method) || ROUTE_TO_SW_RE.test(method)) {
    if (method === "Magic.addCustomEvent") {
      const addEventParams = MagicAddCustomEventParamsSchema.parse(params ?? {});
      const eventName = normalizeMagicName(addEventParams.name);
      // two-step: addBinding, then evaluate the addCustomEvent registration.
      const upId = state.nextUpstreamId++;
      state.pending.set(upId, {
        kind: "magic_add_event_step1",
        clientId: id,
        clientSessionId: sessionId || null,
        eventName,
      });
      state.upstream.send(
        JSON.stringify({
          id: upId,
          method: "Runtime.addBinding",
          params: { name: bindingNameFor(eventName) },
          sessionId: state.extSessionId,
        }),
      );
      return;
    }
    const upId = state.nextUpstreamId++;
    state.pending.set(upId, { kind: "magic_eval", clientId: id, clientSessionId: sessionId || null });
    let runtimeParams;
    if (method === "Magic.evaluate") {
      const evaluateParams = MagicEvaluateParamsSchema.parse(params ?? {});
      runtimeParams = wrapMagicEvaluate({
        ...evaluateParams,
        cdpSessionId: evaluateParams.cdpSessionId ?? sessionId ?? null,
      });
    } else if (method === "Magic.addCustomCommand") {
      runtimeParams = wrapMagicAddCustomCommand(MagicAddCustomCommandParamsSchema.parse(params ?? {}));
    } else if (method === "Magic.addMiddleware") {
      runtimeParams = wrapMagicAddMiddleware(MagicAddMiddlewareParamsSchema.parse(params ?? {}));
    } else {
      const cdpSessionId =
        params && typeof params === "object" && "cdpSessionId" in params && typeof params.cdpSessionId === "string"
          ? params.cdpSessionId
          : (sessionId ?? null);
      runtimeParams = wrapCustomCommand(method, params, cdpSessionId);
    }
    state.upstream.send(
      JSON.stringify({ id: upId, method: "Runtime.evaluate", params: runtimeParams, sessionId: state.extSessionId }),
    );
    return;
  }

  // passthrough
  const upId = state.nextUpstreamId++;
  state.pending.set(upId, { kind: "passthrough", clientId: id, clientSessionId: sessionId || null });
  const out: CdpCommandFrame = { id: upId, method, params };
  if (sessionId) out.sessionId = sessionId;
  state.upstream.send(JSON.stringify(out));
}

function handleUpstreamMessage(state: ProxyConnectionState, msg: CdpResponseFrame | CdpEventFrame) {
  // response
  if ("id" in msg && typeof msg.id === "number") {
    const response = CdpResponseFrameSchema.parse(msg);
    const p = state.pending.get(response.id);
    if (!p) return;
    state.pending.delete(response.id);

    if (p.kind === "internal") {
      if (response.error) p.reject?.(new Error(response.error.message));
      else p.resolve?.(response.result || {});
      return;
    }

    const replyToClient = (extra: Omit<CdpResponseFrame, "id">) => {
      const out: CdpResponseFrame = { id: p.clientId ?? 0, ...extra };
      if (p.clientSessionId) out.sessionId = p.clientSessionId;
      sendToClient(state, out);
    };

    if (p.kind === "magic_eval") {
      try {
        replyToClient({ result: unwrapResponseIfNeeded(response.result || {}, "evaluate") ?? {} });
      } catch (e) {
        replyToClient({ error: { code: -32000, message: e.message } });
      }
      return;
    }
    if (p.kind === "magic_add_event_step1") {
      if (response.error) {
        replyToClient({ error: response.error });
        return;
      }
      const upId = state.nextUpstreamId++;
      state.pending.set(upId, { kind: "magic_eval", clientId: p.clientId, clientSessionId: p.clientSessionId });
      state.upstream.send(
        JSON.stringify({
          id: upId,
          method: "Runtime.evaluate",
          params: wrapMagicAddCustomEvent({ name: p.eventName ?? "" }),
          sessionId: state.extSessionId,
        }),
      );
      return;
    }
    // passthrough
    if (response.error) replyToClient({ error: response.error });
    else replyToClient({ result: response.result ?? {} });
    return;
  }

  const event = CdpEventFrameSchema.parse(msg);

  // event
  if (event.method === "Runtime.bindingCalled" && event.sessionId === state.extSessionId) {
    const u = unwrapEventIfNeeded(
      event.method,
      events["Runtime.bindingCalled"].parse(event.params || {}),
      event.sessionId || null,
      null,
    );
    if (!u) return;
    // emit to root + every known client session, so any CDPSession listener
    // (Playwright per-target sessions) fires.
    sendToClient(state, { method: u.event, params: u.data ?? {} });
    for (const sid of state.clientSessionIds) {
      sendToClient(state, { method: u.event, params: u.data ?? {}, sessionId: sid });
    }
    return;
  }

  // hide bridge-attached session traffic from the client
  if (event.sessionId && state.hiddenSessionIds.has(event.sessionId)) return;

  // If the client's auto-attach creates a fresh orphan session against the
  // hidden SW target, hide that session and detach it upstream. This MUST run
  // before the generic hiddenTargetIds drop below: for an attachedToTarget
  // event, msg.params.targetInfo.targetId is the SW target (which we want to
  // act on), not a target the client owns.
  if (event.method === "Target.attachedToTarget") {
    const attached = events["Target.attachedToTarget"].parse(event.params || {});
    if (state.hiddenTargetIds.has(attached.targetInfo.targetId)) {
      const orphan = attached.sessionId;
      if (orphan && orphan !== state.extSessionId) {
        state.hiddenSessionIds.add(orphan);
        const upId = state.nextUpstreamId++;
        state.pending.set(upId, { kind: "internal", resolve: () => {}, reject: () => {} });
        state.upstream.send(
          JSON.stringify({ id: upId, method: "Target.detachFromTarget", params: { sessionId: orphan } }),
        );
      }
      return;
    }
  }

  // hide all other events about the extension SW target.
  const targetId =
    event.params &&
    typeof event.params === "object" &&
    "targetInfo" in event.params &&
    event.params.targetInfo &&
    typeof event.params.targetInfo === "object" &&
    "targetId" in event.params.targetInfo &&
    typeof event.params.targetInfo.targetId === "string"
      ? event.params.targetInfo.targetId
      : event.params &&
          typeof event.params === "object" &&
          "targetId" in event.params &&
          typeof event.params.targetId === "string"
        ? event.params.targetId
        : null;
  if (targetId && state.hiddenTargetIds.has(targetId)) return;
  const eventSessionId =
    event.params &&
    typeof event.params === "object" &&
    "sessionId" in event.params &&
    typeof event.params.sessionId === "string"
      ? event.params.sessionId
      : null;
  if (event.method.startsWith("Target.detached") && eventSessionId && state.hiddenSessionIds.has(eventSessionId))
    return;

  if (!state.bootstrapped) return; // do not leak bootstrap events

  if (event.method === "Target.attachedToTarget" && eventSessionId) {
    state.clientSessionIds.add(eventSessionId);
  }
  if (event.method === "Target.detachedFromTarget" && eventSessionId) {
    state.clientSessionIds.delete(eventSessionId);
  }

  sendToClient(state, event);
}

function sendToClient(state: ProxyConnectionState, obj: CdpFrame) {
  if (DEBUG)
    dbg("client<-", "id" in obj ? obj.id : "", "method" in obj ? obj.method : "(response)", obj.sessionId ?? "");
  state.client.send(JSON.stringify(obj));
}

// --- CLI -------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = Object.fromEntries(
    process.argv
      .slice(2)
      .flatMap((arg, i, all) =>
        arg.startsWith("--") ? [[arg.slice(2), all[i + 1]?.startsWith("--") ? "true" : (all[i + 1] ?? "true")]] : [],
      ),
  );
  const port = Number(argv.port || DEFAULT_PORT);
  const upstream = argv.upstream || DEFAULT_UPSTREAM;
  const extensionPath = argv.extension ? path.resolve(argv.extension) : DEFAULT_EXTENSION_PATH;
  const autoLaunch = argv["no-auto-launch"] !== "true";
  startProxy({ port, upstream, extensionPath, autoLaunch }).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
