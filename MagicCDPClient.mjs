// MagicCDPClient.mjs: imperative Magic-aware CDP client.
//
// Combines launcher + injector + translate to give callers a single object
// with .send(method, params) and .on(event, handler) that just works for
// both standard CDP and Magic.* / Custom.*.
//
// Layers:
//   - launcher.mjs ensures a Chrome process is running
//   - injector.mjs ensures the MagicCDP extension service worker is present
//     and returns an attached session id (single source of error semantics)
//   - translate.mjs provides the wrap/unwrap functions
//
// This file knows nothing about HTTP serving, the proxy, or how Chrome is
// launched beyond calling launchChrome().

import { EventEmitter } from "node:events";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { launchChrome } from "./launcher.mjs";
import { ensureMagicCDPExtension } from "./injector.mjs";
import {
  bindingNameFor,
  wrapMagicEvaluate,
  wrapMagicAddCustomCommand,
  wrapMagicAddCustomEvent,
  wrapCustomCommand,
  unwrapEvaluateResult,
  unwrapBindingCalled,
} from "./translate.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXTENSION_PATH = path.join(ROOT, "extension");

const MAGIC_METHODS = new Set(["Magic.evaluate", "Magic.addCustomCommand", "Magic.addCustomEvent"]);
const ROUTE_TO_SW_RE = /^(Magic|Custom)\./;

export function MagicCDPClient(options = {}) {
  return new MagicCDP(options);
}

class MagicCDP extends EventEmitter {
  constructor({
    cdp_url = null,
    extensionPath = DEFAULT_EXTENSION_PATH,
    sessionId = randomUUID(),
    launchOptions = {},
  } = {}) {
    super();
    this.cdpUrl = cdp_url;
    this.extensionPath = extensionPath;
    this.sessionId = sessionId;
    this.launchOptions = launchOptions;

    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.extSessionId = null;
    this.extTargetId = null;
    this.extensionId = null;
    this._launched = null;
  }

  async connect() {
    // 1. Ensure there is a Chrome to talk to.
    if (!this.cdpUrl) {
      this._launched = await launchChrome(this.launchOptions);
      this.cdpUrl = this._launched.cdpUrl;
    }
    const versionRes = await fetch(`${this.cdpUrl}/json/version`);
    if (!versionRes.ok) throw new Error(`GET ${this.cdpUrl}/json/version -> ${versionRes.status}`);
    const { webSocketDebuggerUrl } = await versionRes.json();

    // 2. Open the upstream WS and start the dispatcher BEFORE sending anything.
    this.ws = new WebSocket(webSocketDebuggerUrl);
    this.ws.on("message", buf => this._onWsMessage(buf));
    this.ws.on("close", () => this._rejectAll(new Error("CDP websocket closed")));
    this.ws.on("error", err => this._rejectAll(new Error(`CDP websocket error: ${err.message}`)));
    await new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });

    // 3. Inject / discover the MagicCDP extension service worker.
    const send = (method, params, sessionId) => this._sendRaw(method, params, sessionId);
    const ext = await ensureMagicCDPExtension({ send, extensionPath: this.extensionPath });
    this.extensionId = ext.extensionId;
    this.extTargetId = ext.targetId;
    this.extSessionId = ext.sessionId;
    await this._sendRaw("Runtime.enable", {}, this.extSessionId);

    return this;
  }

  async send(method, params = {}, options = {}) {
    const sessionId = typeof options === "string" ? options : options.sessionId;

    // Magic.* / Custom.* -> wrap as Runtime.evaluate against the ext session.
    if (MAGIC_METHODS.has(method) || ROUTE_TO_SW_RE.test(method)) {
      if (method === "Magic.addCustomEvent") {
        await this._sendRaw("Runtime.addBinding", { name: bindingNameFor(params.name) }, this.extSessionId);
        const evalParams = wrapMagicAddCustomEvent({ name: params.name, payloadSchema: params.payloadSchema ?? null });
        const result = await this._sendRaw("Runtime.evaluate", evalParams, this.extSessionId);
        return unwrapEvaluateResult(result);
      }
      let evalParams;
      if (method === "Magic.evaluate") {
        evalParams = wrapMagicEvaluate({ ...params, cdpSessionId: params.cdpSessionId ?? this.sessionId });
      } else if (method === "Magic.addCustomCommand") {
        evalParams = wrapMagicAddCustomCommand(params);
      } else {
        evalParams = wrapCustomCommand(method, params, params.cdpSessionId ?? this.sessionId);
      }
      const result = await this._sendRaw("Runtime.evaluate", evalParams, this.extSessionId);
      return unwrapEvaluateResult(result);
    }

    // standard CDP
    return this._sendRaw(method, params, sessionId);
  }

  async close() {
    try { await this._sendRaw("Target.detachFromTarget", { sessionId: this.extSessionId }); } catch {}
    try { this.ws?.close(); } catch {}
    if (this._launched) await this._launched.close();
  }

  // --- internal --------------------------------------------------------------

  _sendRaw(method, params = {}, sessionId = null) {
    const id = this.nextId++;
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

  _onWsMessage(buf) {
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
    // event
    if (msg.method === "Runtime.bindingCalled" && msg.sessionId === this.extSessionId) {
      const u = unwrapBindingCalled(msg.params || {}, this.sessionId);
      if (u) this.emit(u.event, u.data);
      return;
    }
    if (msg.method) this.emit(msg.method, msg.params || {}, msg.sessionId || null);
  }
}
