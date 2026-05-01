// proxy.mjs: a transparent local CDP proxy that "upgrades" any vanilla CDP
// client to speak Magic.* / Custom.*. By default listens on ws://127.0.0.1:9223
// and forwards to http://127.0.0.1:9222.
//
// Behavior on each client connection:
//   - If the upstream isn't reachable and { autoLaunch: true }, launch a local
//     Chrome via launcher.mjs and use it as the upstream.
//   - Inject the MagicCDP extension service worker via injector.mjs if needed
//     (single source of truth for that precedence + error messages).
//   - Stand up a hidden CDP session attached to the SW; rewrite Magic.* /
//     Custom.* outbound and Runtime.bindingCalled inbound; forward everything
//     else unchanged.
//
// Run as a CLI:
//   node proxy.mjs --port 9223 --upstream http://127.0.0.1:9222
//
// Or import { startProxy } and embed.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { launchChrome } from "./launcher.mjs";
import { injectExtensionIfNeeded } from "./injector.mjs";
import {
  bindingNameFor,
  wrapMagicEvaluate,
  wrapMagicAddCustomCommand,
  wrapMagicAddCustomEvent,
  wrapCustomCommand,
  unwrapResponseIfNeeded,
  unwrapEventIfNeeded,
} from "./translate.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXTENSION_PATH = path.join(ROOT, "extension");
const DEFAULT_PORT = 9223;
const DEFAULT_UPSTREAM = "http://127.0.0.1:9222";

const DEBUG = process.env.PROXY_DEBUG === "1";
const log = (...args) => console.log("[proxy]", ...args);
const dbg = (...args) => { if (DEBUG) console.log("[proxy:dbg]", ...args); };

const MAGIC_METHODS = new Set(["Magic.evaluate", "Magic.addCustomCommand", "Magic.addCustomEvent"]);
const ROUTE_TO_SW_RE = /^(Magic|Custom)\./;
const isWsUrl = url => /^wss?:\/\//i.test(url);

// --- public API -------------------------------------------------------------

export async function startProxy({
  port = DEFAULT_PORT,
  upstream = DEFAULT_UPSTREAM,
  extensionPath = DEFAULT_EXTENSION_PATH,
  autoLaunch = true,
  launchOptions = {},
} = {}) {
  // Per-process upstream: lazily probed on first connection. If reachable, use
  // it. Otherwise launch a local Chrome and remember it.
  const upstreamState = { url: upstream, launched: null };

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
    const earlyHandler = buf => earlyBuffer.push(buf);
    client.on("message", earlyHandler);
    handleConnection(client, earlyBuffer, earlyHandler, upstreamState, { extensionPath, autoLaunch, launchOptions })
      .catch(err => {
        log("connection failed:", err.message);
        try { client.close(1011, err.message.slice(0, 120)); } catch {}
      });
  });

  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  log(`listening on ws://127.0.0.1:${port}/  (upstream: ${upstreamState.url})`);

  return {
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    close: async () => {
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
      if (upstreamState.launched) await upstreamState.launched.close();
    },
  };
}

// --- upstream probe / lazy launch ------------------------------------------

async function ensureUpstream(upstreamState, { autoLaunch, launchOptions }) {
  if (isWsUrl(upstreamState.url)) return;
  try {
    const r = await fetch(`${upstreamState.url}/json/version`);
    if (r.ok) {
      const { webSocketDebuggerUrl } = await r.json();
      if (!webSocketDebuggerUrl) throw new Error(`GET ${upstreamState.url}/json/version returned no webSocketDebuggerUrl`);
      upstreamState.url = webSocketDebuggerUrl;
      return;
    }
  } catch {}
  if (!autoLaunch) {
    throw new Error(`Upstream CDP at ${upstreamState.url} is not reachable. Pass --no-auto-launch only when an upstream is already running.`);
  }
  // dedupe concurrent launch attempts: stash the in-flight promise on
  // upstreamState so callers racing into ensureUpstream all await the same
  // single launchChrome.
  if (!upstreamState.launchPromise) {
    log(`upstream ${upstreamState.url} not reachable, launching local Chrome...`);
    upstreamState.launchPromise = launchChrome(launchOptions).then(launched => {
      upstreamState.launched = launched;
      upstreamState.url = launched.wsUrl;
      log(`launched local Chrome at ${upstreamState.url}`);
      return launched;
    }).catch(err => {
      upstreamState.launchPromise = null;
      throw err;
    });
  }
  await upstreamState.launchPromise;
}

function rewriteWsUrls(value, host) {
  if (!value || typeof value !== "object") return;
  if (typeof value.webSocketDebuggerUrl === "string") {
    value.webSocketDebuggerUrl = value.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://${host}`);
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) rewriteWsUrls(child, host);
}

// --- per-connection bridging ----------------------------------------------

async function handleConnection(client, earlyBuffer, earlyHandler, upstreamState, { extensionPath, autoLaunch, launchOptions }) {
  await ensureUpstream(upstreamState, { autoLaunch, launchOptions });

  const upstream = new WebSocket(upstreamState.url);
  await new Promise((resolve, reject) => {
    upstream.addEventListener("open", resolve, { once: true });
    upstream.addEventListener("error", reject, { once: true });
  });

  // per-connection state
  const state = {
    client,
    upstream,
    nextUpstreamId: 1_000_000,
    pending: new Map(),               // upstreamId -> { kind, clientId?, clientSessionId?, ... }
    extSessionId: null,
    extTargetId: null,
    hiddenSessionIds: new Set(),      // sessions we attached for ourselves
    hiddenTargetIds: new Set(),       // SW target the client must never see
    clientSessionIds: new Set(),      // session ids the client has attached
    bootstrapped: false,
    queuedFromClient: [],
  };

  upstream.addEventListener("message", event => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { log("upstream parse error", e.message); return; }
    dbg("upstream->", msg.id ?? "", msg.method ?? "(response)", msg.sessionId ?? "");
    handleUpstreamMessage(state, msg);
  });
  upstream.addEventListener("close", () => { try { client.close(); } catch {} });
  upstream.addEventListener("error", () => { log("upstream ws error"); try { client.close(1011, "upstream error"); } catch {} });
  client.on("close", () => { try { upstream.close(); } catch {} });

  // Bootstrap: ensure the MagicCDP extension is present and attach a hidden
  // session to it. All single-source-of-truth precedence + error messaging
  // lives in injector.mjs; the proxy just consumes its result.
  const sendInternal = (method, params = {}, sessionId = null) => new Promise((resolve, reject) => {
    const id = state.nextUpstreamId++;
    state.pending.set(id, { kind: "internal", resolve, reject });
    const message = { id, method, params }; if (sessionId) message.sessionId = sessionId;
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
  client.on("message", buf => {
    if (!state.bootstrapped) { state.queuedFromClient.push(buf); return; }
    handleClientMessage(state, buf);
  });
  state.bootstrapped = true;
  for (const buf of state.queuedFromClient) handleClientMessage(state, buf);
  state.queuedFromClient = [];
}

function handleClientMessage(state, buf) {
  let msg;
  try { msg = JSON.parse(buf); } catch (e) { log("client parse error", e.message); return; }
  dbg("client->", msg.id ?? "", msg.method, msg.sessionId ?? "");
  const { id, method, params = {}, sessionId } = msg;

  // route a Magic.* / Custom.* command into a Runtime.evaluate against the
  // hidden ext session, while remembering the originating client id+session
  // so the response can be steered back to the right Playwright CDPSession.
  if (MAGIC_METHODS.has(method) || ROUTE_TO_SW_RE.test(method)) {
    if (method === "Magic.addCustomEvent") {
      // two-step: addBinding, then evaluate the addCustomEvent registration.
      const upId = state.nextUpstreamId++;
      state.pending.set(upId, {
        kind: "magic_add_event_step1",
        clientId: id,
        clientSessionId: sessionId || null,
        eventName: params.name,
        payloadSchema: params.payloadSchema ?? null,
      });
      state.upstream.send(JSON.stringify({
        id: upId,
        method: "Runtime.addBinding",
        params: { name: bindingNameFor(params.name) },
        sessionId: state.extSessionId,
      }));
      return;
    }
    const upId = state.nextUpstreamId++;
    state.pending.set(upId, { kind: "magic_eval", clientId: id, clientSessionId: sessionId || null });
    let runtimeParams;
    if (method === "Magic.evaluate") {
      runtimeParams = wrapMagicEvaluate({ ...params, cdpSessionId: params.cdpSessionId ?? sessionId ?? null });
    } else if (method === "Magic.addCustomCommand") {
      runtimeParams = wrapMagicAddCustomCommand(params);
    } else {
      runtimeParams = wrapCustomCommand(method, params, params.cdpSessionId ?? sessionId ?? null);
    }
    state.upstream.send(JSON.stringify({ id: upId, method: "Runtime.evaluate", params: runtimeParams, sessionId: state.extSessionId }));
    return;
  }

  // passthrough
  const upId = state.nextUpstreamId++;
  state.pending.set(upId, { kind: "passthrough", clientId: id, clientSessionId: sessionId || null });
  const out = { id: upId, method, params }; if (sessionId) out.sessionId = sessionId;
  state.upstream.send(JSON.stringify(out));
}

function handleUpstreamMessage(state, msg) {
  // response
  if (msg.id != null) {
    const p = state.pending.get(msg.id); if (!p) return;
    state.pending.delete(msg.id);

    if (p.kind === "internal") {
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result || {});
      return;
    }

    const replyToClient = (extra) => {
      const out = { id: p.clientId, ...extra };
      if (p.clientSessionId) out.sessionId = p.clientSessionId;
      sendToClient(state, out);
    };

    if (p.kind === "magic_eval") {
      try { replyToClient({ result: unwrapResponseIfNeeded(msg.result || {}, "evaluate") ?? {} }); }
      catch (e) { replyToClient({ error: { code: -32000, message: e.message } }); }
      return;
    }
    if (p.kind === "magic_add_event_step1") {
      if (msg.error) { replyToClient({ error: msg.error }); return; }
      const upId = state.nextUpstreamId++;
      state.pending.set(upId, { kind: "magic_eval", clientId: p.clientId, clientSessionId: p.clientSessionId });
      state.upstream.send(JSON.stringify({
        id: upId,
        method: "Runtime.evaluate",
        params: wrapMagicAddCustomEvent({ name: p.eventName, payloadSchema: p.payloadSchema }),
        sessionId: state.extSessionId,
      }));
      return;
    }
    // passthrough
    if (msg.error) replyToClient({ error: msg.error });
    else replyToClient({ result: msg.result ?? {} });
    return;
  }

  // event
  if (msg.method === "Runtime.bindingCalled" && msg.sessionId === state.extSessionId) {
    const u = unwrapEventIfNeeded(msg.method, msg.params || {}, msg.sessionId || null, null);
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
  if (msg.sessionId && state.hiddenSessionIds.has(msg.sessionId)) return;

  // If the client's auto-attach creates a fresh orphan session against the
  // hidden SW target, hide that session and detach it upstream. This MUST run
  // before the generic hiddenTargetIds drop below: for an attachedToTarget
  // event, msg.params.targetInfo.targetId is the SW target (which we want to
  // act on), not a target the client owns.
  if (msg.method === "Target.attachedToTarget" && msg.params?.targetInfo?.targetId
      && state.hiddenTargetIds.has(msg.params.targetInfo.targetId)) {
    const orphan = msg.params.sessionId;
    if (orphan && orphan !== state.extSessionId) {
      state.hiddenSessionIds.add(orphan);
      const upId = state.nextUpstreamId++;
      state.pending.set(upId, { kind: "internal", resolve: () => {}, reject: () => {} });
      state.upstream.send(JSON.stringify({ id: upId, method: "Target.detachFromTarget", params: { sessionId: orphan } }));
    }
    return;
  }

  // hide all other events about the extension SW target.
  const targetId = msg.params?.targetInfo?.targetId || msg.params?.targetId || null;
  if (targetId && state.hiddenTargetIds.has(targetId)) return;
  if (msg.method?.startsWith("Target.detached") && msg.params?.sessionId && state.hiddenSessionIds.has(msg.params.sessionId)) return;

  if (!state.bootstrapped) return; // do not leak bootstrap events

  if (msg.method === "Target.attachedToTarget" && msg.params?.sessionId) {
    state.clientSessionIds.add(msg.params.sessionId);
  }
  if (msg.method === "Target.detachedFromTarget" && msg.params?.sessionId) {
    state.clientSessionIds.delete(msg.params.sessionId);
  }

  sendToClient(state, msg);
}

function sendToClient(state, obj) {
  if (DEBUG) dbg("client<-", obj.id ?? "", obj.method ?? "(response)", obj.sessionId ?? "");
  state.client.send(JSON.stringify(obj));
}

// --- CLI -------------------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = Object.fromEntries(process.argv.slice(2).flatMap((arg, i, all) =>
    arg.startsWith("--") ? [[arg.slice(2), all[i + 1]?.startsWith("--") ? "true" : (all[i + 1] ?? "true")]] : []));
  const port = Number(argv.port || DEFAULT_PORT);
  const upstream = argv.upstream || DEFAULT_UPSTREAM;
  const extensionPath = argv.extension ? path.resolve(argv.extension) : DEFAULT_EXTENSION_PATH;
  const autoLaunch = argv["no-auto-launch"] !== "true";
  startProxy({ port, upstream, extensionPath, autoLaunch }).catch(e => {
    console.error(e);
    process.exitCode = 1;
  });
}
