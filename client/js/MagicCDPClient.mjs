// MagicCDPClient (JS): importable, no CLI, no demo code.
//
// Constructor parameter names match across JS / Python / Go ports:
//   cdp_url           upstream CDP URL (string, default null -> autolaunch)
//   extension_path    extension directory (string, default ../../extension)
//   routes            client-side routing dict (default { "Magic.*": "service_worker",
//                       "Custom.*": "service_worker", "*.*": "direct_cdp" })
//   server            { loopback_cdp_url?, routes? } passed to MagicCDPServer.configure
//   session_id        client cdpSessionId tag for event scoping
//   launch_options    forwarded to launcher.launchChrome when autolaunching
//
// Public methods: connect, send(method, params), on(event, handler), close.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { launchChrome } from "../../bridge/launcher.mjs";
import { ensureMagicCDPExtension } from "../../bridge/injector.mjs";
import {
  bindingNameFor,
  wrapMagicEvaluate,
  wrapMagicAddCustomCommand,
  wrapMagicAddCustomEvent,
  wrapCustomCommand,
  unwrapEvaluateResult,
  unwrapBindingCalled,
} from "../../bridge/translate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXTENSION_PATH = path.resolve(HERE, "..", "..", "extension");

const DEFAULT_CLIENT_ROUTES = {
  "Magic.*": "service_worker",
  "Custom.*": "service_worker",
  "*.*": "direct_cdp",
};

function routeFor(method, routes) {
  let fallback = "direct_cdp";
  for (const [pattern, route] of Object.entries(routes || {})) {
    if (pattern === "*.*") { fallback = route; continue; }
    if (pattern.endsWith(".*") && method.startsWith(pattern.slice(0, -1))) return route;
    if (pattern === method) return route;
  }
  return fallback;
}

export function MagicCDPClient(options = {}) {
  return new MagicCDP(options);
}

class MagicCDP extends EventEmitter {
  constructor({
    cdp_url = null,
    extension_path = DEFAULT_EXTENSION_PATH,
    routes = DEFAULT_CLIENT_ROUTES,
    server = null,
    session_id = randomUUID(),
    launch_options = {},
  } = {}) {
    super();
    this.cdp_url = cdp_url;
    this.extension_path = extension_path;
    this.routes = { ...DEFAULT_CLIENT_ROUTES, ...routes };
    this.server = server;
    this.session_id = session_id;
    this.launch_options = launch_options;

    this.ws = null;
    this.next_id = 1;
    this.pending = new Map();
    this.ext_session_id = null;
    this.ext_target_id = null;
    this.extension_id = null;
    this._launched = null;
  }

  async connect() {
    if (!this.cdp_url) {
      this._launched = await launchChrome(this.launch_options);
      this.cdp_url = this._launched.cdpUrl;
    }
    const versionRes = await fetch(`${this.cdp_url}/json/version`);
    if (!versionRes.ok) throw new Error(`GET ${this.cdp_url}/json/version -> ${versionRes.status}`);
    const { webSocketDebuggerUrl } = await versionRes.json();

    this.ws = new WebSocket(webSocketDebuggerUrl);
    this.ws.on("message", buf => this._onMessage(buf));
    this.ws.on("close", () => this._rejectAll(new Error("CDP websocket closed")));
    this.ws.on("error", err => this._rejectAll(new Error(`CDP websocket error: ${err.message}`)));
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });

    const ext = await ensureMagicCDPExtension({
      send: (method, params, sessionId) => this._sendRaw(method, params, sessionId),
      extensionPath: this.extension_path,
    });
    this.extension_id = ext.extensionId;
    this.ext_target_id = ext.targetId;
    this.ext_session_id = ext.sessionId;
    await this._sendRaw("Runtime.enable", {}, this.ext_session_id);

    if (this.server) {
      await this._sendRaw("Runtime.evaluate", {
        expression: `globalThis.MagicCDP.configure(${JSON.stringify(this.server)})`,
        awaitPromise: true,
        returnByValue: true,
        allowUnsafeEvalBlockedByCSP: true,
      }, this.ext_session_id);
    }

    return this;
  }

  async send(method, params = {}) {
    const route = routeFor(method, this.routes);
    if (route === "service_worker") {
      if (method === "Magic.evaluate") {
        return this._evalOnExt(wrapMagicEvaluate({ ...params, cdpSessionId: params.cdpSessionId ?? this.session_id }));
      }
      if (method === "Magic.addCustomCommand") {
        return this._evalOnExt(wrapMagicAddCustomCommand(params));
      }
      if (method === "Magic.addCustomEvent") {
        await this._sendRaw("Runtime.addBinding", { name: bindingNameFor(params.name) }, this.ext_session_id);
        return this._evalOnExt(wrapMagicAddCustomEvent({ name: params.name, payloadSchema: params.payloadSchema ?? null }));
      }
      return this._evalOnExt(wrapCustomCommand(method, params, this.session_id));
    }
    if (route === "direct_cdp") return this._sendRaw(method, params);
    throw new Error(`Unsupported client route "${route}" for ${method}`);
  }

  async close() {
    try { await this._sendRaw("Target.detachFromTarget", { sessionId: this.ext_session_id }); } catch {}
    try { this.ws?.close(); } catch {}
    if (this._launched) await this._launched.close();
  }

  async _evalOnExt(evalParams) {
    const result = await this._sendRaw("Runtime.evaluate", evalParams, this.ext_session_id);
    return unwrapEvaluateResult(result);
  }

  _sendRaw(method, params = {}, sessionId = null) {
    const id = this.next_id++;
    const message = { id, method, params }; if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.ws.send(JSON.stringify(message));
    });
  }

  _rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  _onMessage(buf) {
    let msg;
    try { msg = JSON.parse(buf); } catch { return; }
    if (msg.id != null) {
      const pending = this.pending.get(msg.id); if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(`${pending.method} failed: ${msg.error.message}`);
        err.cdp = msg.error;
        pending.reject(err);
      } else {
        pending.resolve(msg.result || {});
      }
      return;
    }
    if (msg.method === "Runtime.bindingCalled" && msg.sessionId === this.ext_session_id) {
      const u = unwrapBindingCalled(msg.params || {}, this.session_id);
      if (u) this.emit(u.event, u.data);
      return;
    }
    if (msg.method) this.emit(msg.method, msg.params || {}, msg.sessionId || null);
  }
}
