// proxy.js: a transparent local CDP proxy that "upgrades" any vanilla CDP
// client to speak Mod.* / Custom.*. By default listens on ws://127.0.0.1:9223
// and forwards to http://127.0.0.1:9222.
//
// Behavior on each client connection:
//   - Connect a ModCDPClient to the existing upstream so auto-attach,
//     extension discovery, and injection stay in the main client implementation.
//   - Reuse that client's upstream websocket + hidden extension session to
//     rewrite Mod.* /
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
import { WebSocketServer } from "ws";
import type { RawData, WebSocket as ClientWebSocket } from "ws";

import { ModCDPClient } from "../client/js/ModCDPClient.js";
import {
  bindingNameFor,
  wrapModCDPEvaluate,
  wrapModCDPAddCustomCommand,
  wrapModCDPAddMiddleware,
  wrapModCDPAddCustomEvent,
  wrapCustomCommand,
  unwrapResponseIfNeeded,
  unwrapEventIfNeeded,
} from "./translate.js";
import type {
  CdpCommandFrame,
  CdpEventFrame,
  CdpResponseFrame,
  CdpFrame,
  ProxyConnectionState,
} from "../types/modcdp.js";
import {
  CdpCommandFrameSchema,
  CdpEventFrameSchema,
  CdpResponseFrameSchema,
  ModCDPAddCustomCommandParamsSchema,
  ModCDPAddCustomEventObjectParamsSchema,
  ModCDPAddMiddlewareParamsSchema,
  ModCDPEvaluateParamsSchema,
  normalizeModCDPName,
} from "../types/modcdp.js";
import { events as RuntimeEvents } from "../types/zod/Runtime.js";
import { events as TargetEvents } from "../types/zod/Target.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXTENSION_PATH = path.resolve(ROOT, "..", "extension");
const DEFAULT_PORT = 9223;
const DEFAULT_UPSTREAM = "http://127.0.0.1:9222";

const DEBUG = process.env.PROXY_DEBUG === "1";
const log = (...args) => console.log("[proxy]", ...args);
const dbg = (...args) => {
  if (DEBUG) console.log("[proxy:dbg]", ...args);
};

const MAGIC_METHODS = new Set(["Mod.evaluate", "Mod.addCustomCommand", "Mod.addCustomEvent", "Mod.addMiddleware"]);
const ROUTE_TO_SW_RE = /^(Mod|Custom)\./;
const isWsUrl = (url) => /^wss?:\/\//i.test(url);

// --- public API -------------------------------------------------------------

export async function startProxy({
  port = DEFAULT_PORT,
  upstream = DEFAULT_UPSTREAM,
  extensionPath = DEFAULT_EXTENSION_PATH,
}: {
  port?: number;
  upstream?: string;
  extensionPath?: string;
} = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = req.url === "/json/version/" ? "/json/version" : req.url;
      if (requestUrl === "/json/version") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://${req.headers.host}/devtools/browser/proxy` }));
        return;
      }
      if (isWsUrl(upstream)) {
        res.writeHead(404);
        res.end("HTTP discovery is unavailable for a ws:// upstream.");
        return;
      }
      const upstreamRes = await fetch(`${upstream}${requestUrl}`);
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
    handleConnection(client, earlyBuffer, earlyHandler, {
      upstream,
      extensionPath,
    }).catch((err) => {
      log("connection failed:", err.message);
      try {
        client.close(1011, err.message.slice(0, 120));
      } catch {}
    });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  log(`listening on ws://127.0.0.1:${port}/  (upstream: ${upstream})`);

  return {
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
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
  { upstream, extensionPath }: { upstream: string; extensionPath: string },
) {
  const cdp = new ModCDPClient({
    cdp_url: upstream,
    extension_path: extensionPath,
    hydrate_aliases: false,
  });
  await cdp.connect();
  const upstream_socket = cdp.ws as unknown as WebSocket | null;
  if (!upstream_socket) throw new Error("ModCDPClient connected without an upstream websocket.");

  // per-connection state
  const state: ProxyConnectionState = {
    client,
    upstream: upstream_socket as unknown as import("ws").WebSocket,
    nextUpstreamId: 1_000_000,
    pending: new Map(), // upstreamId -> { kind, clientId?, clientSessionId?, ... }
    extSessionId: cdp.ext_session_id,
    extTargetId: cdp.ext_target_id,
    hiddenSessionIds: new Set(), // sessions we attached for ourselves
    hiddenTargetIds: new Set(), // SW target the client must never see
    targetSessionIds: cdp.auto_target_sessions,
    clientSessionIds: new Set(), // session ids the client has attached
    bootstrapped: false,
    queuedFromClient: [],
  };
  if (cdp.ext_session_id) state.hiddenSessionIds.add(cdp.ext_session_id);
  if (cdp.ext_target_id) state.hiddenTargetIds.add(cdp.ext_target_id);

  upstream_socket.addEventListener("message", (event) => {
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
  upstream_socket.addEventListener("close", () => {
    try {
      client.close();
    } catch {}
  });
  upstream_socket.addEventListener("error", () => {
    log("upstream ws error");
    try {
      client.close(1011, "upstream error");
    } catch {}
  });
  client.on("close", () => {
    void cdp.close().catch(() => {});
  });
  log(`extension ${cdp.connect_timing?.extension_source} (${cdp.extension_id}); ext session ${cdp.ext_session_id}`);

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

  // route a Mod.* / Custom.* command into a Runtime.evaluate against the
  // hidden ext session, while remembering the originating client id+session
  // so the response can be steered back to the right Playwright CDPSession.
  if (MAGIC_METHODS.has(method) || ROUTE_TO_SW_RE.test(method)) {
    if (method === "Mod.addCustomEvent") {
      const addEventParams = ModCDPAddCustomEventObjectParamsSchema.parse(params ?? {});
      const eventName = normalizeModCDPName(addEventParams.name);
      // two-step: addBinding, then evaluate the addCustomEvent registration.
      const upId = state.nextUpstreamId++;
      state.pending.set(upId, {
        kind: "modcdp_add_event_step1",
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
    state.pending.set(upId, { kind: "modcdp_eval", clientId: id, clientSessionId: sessionId || null });
    let runtimeParams;
    if (method === "Mod.evaluate") {
      const evaluateParams = ModCDPEvaluateParamsSchema.parse(params ?? {});
      runtimeParams = wrapModCDPEvaluate({
        ...evaluateParams,
        cdpSessionId: evaluateParams.cdpSessionId ?? sessionId ?? null,
      });
    } else if (method === "Mod.addCustomCommand") {
      runtimeParams = wrapModCDPAddCustomCommand(ModCDPAddCustomCommandParamsSchema.parse(params ?? {}));
    } else if (method === "Mod.addMiddleware") {
      runtimeParams = wrapModCDPAddMiddleware(ModCDPAddMiddlewareParamsSchema.parse(params ?? {}));
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

    if (p.kind === "modcdp_eval") {
      try {
        replyToClient({ result: unwrapResponseIfNeeded(response.result || {}, "evaluate") ?? {} });
      } catch (e) {
        replyToClient({ error: { code: -32000, message: e.message } });
      }
      return;
    }
    if (p.kind === "modcdp_add_event_step1") {
      if (response.error) {
        replyToClient({ error: response.error });
        return;
      }
      const upId = state.nextUpstreamId++;
      state.pending.set(upId, { kind: "modcdp_eval", clientId: p.clientId, clientSessionId: p.clientSessionId });
      state.upstream.send(
        JSON.stringify({
          id: upId,
          method: "Runtime.evaluate",
          params: wrapModCDPAddCustomEvent({ name: p.eventName ?? "" }),
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

  if (event.method === "Target.attachedToTarget") {
    const attached = TargetEvents["Target.attachedToTarget"].parse(event.params || {});
    state.targetSessionIds.set(attached.targetInfo.targetId, attached.sessionId);
  }
  if (event.method === "Target.detachedFromTarget") {
    const eventSessionId =
      event.params &&
      typeof event.params === "object" &&
      "sessionId" in event.params &&
      typeof event.params.sessionId === "string"
        ? event.params.sessionId
        : null;
    if (eventSessionId) {
      for (const [target_id, session_id] of state.targetSessionIds) {
        if (session_id === eventSessionId) state.targetSessionIds.delete(target_id);
      }
    }
  }

  // event
  if (event.method === "Runtime.bindingCalled" && event.sessionId === state.extSessionId) {
    const u = unwrapEventIfNeeded(
      event.method,
      RuntimeEvents["Runtime.bindingCalled"].parse(event.params || {}),
      event.sessionId || null,
      null,
    );
    if (!u) return;
    // emit to root + every known client session, so any CDPSession listener
    // (Playwright per-target sessions) fires.
    sendToClient(state, { method: u.event, params: (u.data ?? {}) as Record<string, unknown> });
    for (const sid of state.clientSessionIds) {
      sendToClient(state, { method: u.event, params: (u.data ?? {}) as Record<string, unknown>, sessionId: sid });
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
    const attached = TargetEvents["Target.attachedToTarget"].parse(event.params || {});
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
  startProxy({ port, upstream, extensionPath }).catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
