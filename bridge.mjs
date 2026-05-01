// MagicCDPBridge: a transparent local CDP proxy that "upgrades" any vanilla CDP
// client to speak Magic.* and Custom.* without managing the extension service
// worker session itself.
//
// Run:
//   node bridge.mjs --upstream http://127.0.0.1:9222 --port 9333
//
// Then connect Playwright (or any CDP client) to http://127.0.0.1:9333.

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  bindingFor,
  wrapEvaluate,
  wrapAddCustomCommand,
  wrapAddCustomEventEval,
  wrapCustomCommand,
  unwrapEvaluateResult,
  unwrapBindingCalled,
} from "./magic-translate.mjs";

const argv = Object.fromEntries(process.argv.slice(2).flatMap((arg, i, all) =>
  arg.startsWith("--") ? [[arg.slice(2), all[i + 1]]] : []));
const UPSTREAM = argv.upstream || "http://127.0.0.1:9222";
const PORT = Number(argv.port || 9333);
const SW_URL_RE = /^chrome-extension:\/\/[a-z]+\/service_worker\.js$/;

function log(...args) { console.log("[bridge]", ...args); }
const DEBUG = process.env.BRIDGE_DEBUG === "1";
function dbg(...args) { if (DEBUG) console.log("[bridge:dbg]", ...args); }

const server = http.createServer(async (req, res) => {
  try {
    const upstream = await fetch(`${UPSTREAM}${req.url}`);
    const text = await upstream.text();
    const ct = upstream.headers.get("content-type") || "";
    if (ct.includes("application/json") && (req.url === "/json/version" || req.url.startsWith("/json"))) {
      const body = JSON.parse(text);
      const rewrite = obj => {
        if (obj && typeof obj === "object") {
          if (typeof obj.webSocketDebuggerUrl === "string") {
            obj.webSocketDebuggerUrl = obj.webSocketDebuggerUrl
              .replace(/ws:\/\/[^/]+/, `ws://${req.headers.host}`);
          }
          for (const v of Array.isArray(obj) ? obj : Object.values(obj)) rewrite(v);
        }
      };
      rewrite(body);
      res.writeHead(upstream.status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    } else {
      res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      res.end(text);
    }
  } catch (e) { res.writeHead(502); res.end(String(e)); }
});

const wss = new WebSocketServer({ server });

wss.on("connection", (client, req) => {
  log("client connected", req.url);
  const earlyBuffer = [];
  const earlyHandler = buf => earlyBuffer.push(buf);
  client.on("message", earlyHandler);
  bridge(client, earlyBuffer, earlyHandler).catch(err => {
    log("bridge error", err);
    try { client.close(1011, err.message); } catch {}
  });
});

server.listen(PORT, () => log(`listening on http://127.0.0.1:${PORT} -> ${UPSTREAM}`));

async function bridge(client, earlyBuffer, earlyHandler) {
  const versionRes = await fetch(`${UPSTREAM}/json/version`);
  const version = await versionRes.json();
  const up = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    up.once("open", resolve); up.once("error", reject);
  });

  const state = {
    up, client,
    nextId: 1_000_000,
    pending: new Map(),       // upstreamId -> { kind, clientId, clientSessionId?, partial? }
    hidden: new Set(),        // sessionIds the bridge attached for itself
    hiddenTargetIds: new Set(),// targetIds whose events should never reach the client
    clientSessions: new Set(),// sessionIds the client is using (for event broadcast)
    extSession: null,
    extTargetId: null,
    bootstrapped: false,      // when false, do not forward upstream events to client
    bufferedFromClient: [],   // client messages received during bootstrap
  };

  // swap the early synchronous buffer for the real handler. drain anything
  // that arrived before bootstrap got this far.
  client.off("message", earlyHandler);
  for (const buf of earlyBuffer) {
    try {
      const m = JSON.parse(buf);
      dbg("client-> (buffered)", m.id, m.method, m.sessionId || "");
      state.bufferedFromClient.push(m);
    } catch (e) { log("client msg parse error", e); }
  }
  client.on("message", buf => {
    try {
      const m = JSON.parse(buf);
      dbg("client->", m.id, m.method, m.sessionId || "");
      if (!state.bootstrapped) state.bufferedFromClient.push(m);
      else onClientMsg(state, m);
    } catch (e) { log("client msg parse error", e); }
  });
  up.on("message", buf => {
    try {
      const m = JSON.parse(buf);
      dbg("upstream->", m.id || "", m.method || "(response)", m.sessionId || "");
      onUpstreamMsg(state, m);
    } catch (e) { log("upstream msg parse error", e); }
  });
  client.on("close", () => up.close());
  up.on("close", () => client.close());
  up.on("error", e => { log("upstream ws error", e.message); try { client.close(1011, e.message); } catch {} });

  // bridge-internal RPC
  const ask = (method, params = {}, sessionId = null) => new Promise((resolve, reject) => {
    const id = state.nextId++;
    state.pending.set(id, { kind: "internal", resolve, reject });
    const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
    up.send(JSON.stringify(msg));
  });

  // bootstrap: attach the MagicCDP service worker invisibly. We do NOT call
  // Target.setAutoAttach here — Playwright will set it itself. We just probe
  // existing service-worker targets, attach to the MagicCDP one, and remember
  // its targetId so we can filter all subsequent events about it.
  const { targetInfos } = await ask("Target.getTargets");
  const candidates = targetInfos.filter(t => t.type === "service_worker" && SW_URL_RE.test(t.url));
  for (const t of candidates) {
    const { sessionId } = await ask("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    state.hidden.add(sessionId);
    const probe = await ask("Runtime.evaluate", {
      expression: "Boolean(globalThis.MagicCDP?.handleCommand && globalThis.MagicCDP?.addCustomEvent)",
      returnByValue: true,
    }, sessionId);
    if (probe.result?.value === true) {
      state.extSession = sessionId;
      state.extTargetId = t.targetId;
      state.hiddenTargetIds.add(t.targetId);
      break;
    } else {
      await ask("Target.detachFromTarget", { sessionId }).catch(() => {});
      state.hidden.delete(sessionId);
    }
  }
  if (!state.extSession) throw new Error("MagicCDP extension service worker not found upstream");

  await ask("Runtime.enable", {}, state.extSession);
  log("ext session attached", state.extSession, "target", state.extTargetId);

  state.bootstrapped = true;
  for (const m of state.bufferedFromClient) onClientMsg(state, m);
  state.bufferedFromClient = [];
}

function send(ws, obj) {
  if (DEBUG) dbg("client<-", obj.id ?? "", obj.method ?? "(response)", obj.sessionId ?? "");
  ws.send(JSON.stringify(obj));
}

function onClientMsg(s, msg) {
  const { id, method, params = {}, sessionId } = msg;

  const dispatch = (upMethod, upParams, upSessionId, kind, extra = {}) => {
    const upId = s.nextId++;
    s.pending.set(upId, { kind, clientId: id, clientSessionId: sessionId || null, ...extra });
    const out = { id: upId, method: upMethod, params: upParams };
    if (upSessionId) out.sessionId = upSessionId;
    send(s.up, out);
  };

  if (method === "Magic.evaluate") {
    return dispatch("Runtime.evaluate", wrapEvaluate({ ...params, cdpSessionId: params.cdpSessionId ?? sessionId ?? null }),
      s.extSession, "magic_eval");
  }
  if (method === "Magic.addCustomCommand") {
    return dispatch("Runtime.evaluate", wrapAddCustomCommand(params), s.extSession, "magic_eval");
  }
  if (method === "Magic.addCustomEvent") {
    // step 1: Runtime.addBinding; step 2 fires from onUpstreamMsg
    const bn = bindingFor(params.name);
    return dispatch("Runtime.addBinding", { name: bn }, s.extSession,
      "add_event_step1", { eventName: params.name, payloadSchema: params.payloadSchema ?? null });
  }
  if (method.startsWith("Magic.") || method.startsWith("Custom.")) {
    return dispatch("Runtime.evaluate",
      wrapCustomCommand(method, params, params.cdpSessionId ?? sessionId ?? null),
      s.extSession, "magic_eval");
  }
  // passthrough
  return dispatch(method, params, sessionId, "passthrough");
}

function onUpstreamMsg(s, msg) {
  // response
  if (msg.id != null) {
    const p = s.pending.get(msg.id); if (!p) return;
    s.pending.delete(msg.id);

    if (p.kind === "internal") {
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result || {});
      return;
    }
    const reply = (extra) => {
      const out = { id: p.clientId, ...extra };
      if (p.clientSessionId) out.sessionId = p.clientSessionId;
      send(s.client, out);
    };
    if (p.kind === "magic_eval") {
      try { reply({ result: unwrapEvaluateResult(msg.result || {}) ?? {} }); }
      catch (e) { reply({ error: { code: -32000, message: e.message } }); }
      return;
    }
    if (p.kind === "add_event_step1") {
      if (msg.error) { reply({ error: msg.error }); return; }
      const upId = s.nextId++;
      s.pending.set(upId, { kind: "magic_eval", clientId: p.clientId, clientSessionId: p.clientSessionId });
      send(s.up, {
        id: upId,
        method: "Runtime.evaluate",
        params: wrapAddCustomEventEval({ name: p.eventName, payloadSchema: p.payloadSchema }),
        sessionId: s.extSession,
      });
      return;
    }
    // passthrough
    if (msg.error) reply({ error: msg.error });
    else reply({ result: msg.result ?? {} });
    return;
  }

  // event
  if (msg.method === "Runtime.bindingCalled" && msg.sessionId === s.extSession) {
    const u = unwrapBindingCalled(msg.params || {}, null);
    if (!u) return;
    // broadcast to root + every known client session, so any CDPSession listener fires
    send(s.client, { method: u.event, params: u.data ?? {} });
    for (const sid of s.clientSessions) {
      send(s.client, { method: u.event, params: u.data ?? {}, sessionId: sid });
    }
    return;
  }
  // hide bridge-attached sessions entirely from the client
  if (msg.sessionId && s.hidden.has(msg.sessionId)) return;
  if (msg.method === "Target.attachedToTarget" && msg.params?.sessionId && s.hidden.has(msg.params.sessionId)) return;

  // hide ALL events about the MagicCDP extension target: targetCreated /
  // attachedToTarget / detachedFromTarget / targetInfoChanged. If the client
  // (or its setAutoAttach) auto-attaches a fresh session to the same target
  // anyway, also hide that new session and detach it upstream.
  const tid = msg.params?.targetInfo?.targetId
    || msg.params?.targetId
    || (msg.method?.startsWith("Target.") ? null : null);
  if (tid && s.hiddenTargetIds.has(tid)) return;
  if (msg.method === "Target.attachedToTarget" && msg.params?.targetInfo?.targetId
      && s.hiddenTargetIds.has(msg.params.targetInfo.targetId)) {
    const orphan = msg.params.sessionId;
    if (orphan && orphan !== s.extSession) {
      s.hidden.add(orphan);
      const upId = s.nextId++;
      s.pending.set(upId, { kind: "internal", resolve: () => {}, reject: () => {} });
      send(s.up, { id: upId, method: "Target.detachFromTarget", params: { sessionId: orphan } });
    }
    return;
  }
  if (!s.bootstrapped) return; // do not leak bootstrap-time events
  if (msg.method?.startsWith("Target.detached") && msg.params?.sessionId && s.hidden.has(msg.params.sessionId)) return;

  // snoop client-visible session ids so we can broadcast events to them
  if (msg.method === "Target.attachedToTarget" && msg.params?.sessionId) {
    s.clientSessions.add(msg.params.sessionId);
  }
  if (msg.method === "Target.detachedFromTarget" && msg.params?.sessionId) {
    s.clientSessions.delete(msg.params.sessionId);
  }

  send(s.client, msg);
}
