// MagicCDPServer: lives inside the extension service worker. Owns the registry
// of custom commands and event bindings, and emits events through the binding
// API installed by the client (Runtime.addBinding -> globalThis[bindingName]).
//
// Re-uses translate.mjs for the shared { event, data, cdpSessionId } payload
// encoding so binding payloads stay byte-compatible with the Node-side
// unwrapBindingCalled.

import { encodeBindingPayload } from "./translate.mjs";

const commandHandlers = new Map();
const eventBindings = new Map();
const attachedDebuggees = new Set();

const targetAutoAttachParams = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
};

const defaultRoutes = {
  "Magic.*": "service_worker",
  "Custom.*": "service_worker",
  "*.*": "auto",
};

let nextLoopbackId = 1;

async function resolveCDPEndpoint(endpoint) {
  if (!endpoint || /^wss?:\/\//i.test(endpoint)) return endpoint;
  const { webSocketDebuggerUrl } = await fetch(`${endpoint}/json/version`).then(r => r.json());
  if (!webSocketDebuggerUrl) throw new Error(`loopback_cdp_url HTTP discovery returned no webSocketDebuggerUrl.`);
  return webSocketDebuggerUrl;
}

async function openCDPSocket(endpoint) {
  if (!/^wss?:\/\//i.test(endpoint)) {
    throw new Error(`loopback_cdp_url must be a ws:// or wss:// CDP websocket URL, got ${endpoint}.`);
  }
  return new Promise((resolve, reject) => {
    const w = new WebSocket(endpoint);
    w.addEventListener("open", () => resolve(w), { once: true });
    w.addEventListener("error", reject, { once: true });
  });
}

export const MagicCDPServer = {
  routes: { ...defaultRoutes },
  loopback_cdp_url: null,
  browserToken: null,

  async configure({ loopback_cdp_url = this.loopback_cdp_url, routes, browserToken = this.browserToken } = {}) {
    this.loopback_cdp_url = await resolveCDPEndpoint(loopback_cdp_url);
    this.browserToken = browserToken;
    if (routes) this.routes = { ...defaultRoutes, ...routes };
    else { this.routes = { ...defaultRoutes }; await this.discoverLoopbackCDP(); }
    return { loopback_cdp_url: this.loopback_cdp_url, routes: this.routes };
  },

  addCustomCommand({ name, paramsSchema = null, resultSchema = null, expression = null, handler }) {
    if (!name || !name.includes(".")) throw new Error("name must be in Domain.method form.");
    if (typeof handler !== "function") throw new Error(`Custom command ${name} was registered without a handler.`);
    commandHandlers.set(name, { handler, paramsSchema, resultSchema, expression });
    return { name, registered: true };
  },

  addCustomEvent({ name, bindingName, payloadSchema = null }) {
    if (!name || !name.includes(".")) throw new Error("name must be in Domain.event form.");
    if (!bindingName) throw new Error(`Custom event ${name} is missing a Runtime binding name.`);
    eventBindings.set(name, { bindingName, payloadSchema });
    return { name, bindingName, registered: true };
  },

  async handleCommand(method, params = {}, meta = {}) {
    const command = commandHandlers.get(method);
    if (command) return command.handler(params, { cdpSessionId: meta.cdpSessionId || null });

    let upstream = "chrome_debugger";
    for (const [pattern, route] of Object.entries(this.routes || {})) {
      if (pattern === "*.*") { upstream = route; continue; }
      if (pattern.endsWith(".*") && method.startsWith(pattern.slice(0, -1))) { upstream = route; break; }
      if (pattern === method) { upstream = route; break; }
    }

    if (upstream === "auto") {
      if (this.loopback_cdp_url) {
        try { return await this.sendLoopback(method, params); } catch {}
      }
      return this.sendChromeDebugger(method, params);
    }
    if (upstream === "loopback_cdp") return this.sendLoopback(method, params);
    if (upstream === "chrome_debugger") return this.sendChromeDebugger(method, params);
    throw new Error(`No MagicCDP command registered for ${method}.`);
  },

  attachToSession(cdpSessionId = null) {
    return {
      sessionId: cdpSessionId,
      send: (method, params = {}) => this.handleCommand(method, params, { cdpSessionId }),
      emit: (eventName, payload = {}) => this.emit(eventName, payload, { cdpSessionId }),
    };
  },

  async emit(eventName, payload = {}, meta = {}) {
    const event = eventBindings.get(eventName);
    if (!event) return { event: eventName, emitted: false, reason: "event_not_registered" };
    const binding = globalThis[event.bindingName];
    if (typeof binding !== "function") return { event: eventName, emitted: false, reason: "binding_not_installed" };

    binding(encodeBindingPayload({ event: eventName, data: payload, cdpSessionId: meta.cdpSessionId || null }));
    return { event: eventName, emitted: true };
  },

  async discoverLoopbackCDP() {
    if (!this.browserToken) return { loopback_cdp_url: null, verified: false };

    const url = "http://127.0.0.1:9222";
    try {
      const version = await fetch(`${url}/json/version`).then(response => response.ok && response.json());
      if (!version?.webSocketDebuggerUrl) return { loopback_cdp_url: null, verified: false };

      const ws = await new Promise((resolve, reject) => {
        const w = new WebSocket(version.webSocketDebuggerUrl);
        w.addEventListener("open", () => resolve(w), { once: true });
        w.addEventListener("error", reject, { once: true });
      });
      try {
        const callOnWs = (method, params = {}, sessionId = null) => {
          const id = nextLoopbackId++;
          const message = { id, method, params }; if (sessionId) message.sessionId = sessionId;
          ws.send(JSON.stringify(message));
          return new Promise((resolve, reject) => {
            ws.addEventListener("message", event => {
              const msg = JSON.parse(event.data);
              if (msg.id !== id) return;
              if (msg.error) reject(new Error(msg.error.message));
              else resolve(msg.result || {});
            });
            ws.addEventListener("error", reject, { once: true });
          });
        };

        await callOnWs("Target.setAutoAttach", targetAutoAttachParams);
        const { targetInfos } = await callOnWs("Target.getTargets");
        const worker = targetInfos.find(target =>
          target.type === "service_worker"
          && target.url === `chrome-extension://${chrome.runtime.id}/service_worker.js`,
        );
        if (!worker) return { loopback_cdp_url: null, verified: false };

        const { sessionId } = await callOnWs("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
        const result = await callOnWs("Runtime.evaluate", {
          expression: `globalThis.MagicCDP?.browserToken === ${JSON.stringify(this.browserToken)}`,
          returnByValue: true,
        }, sessionId);
        if (result.result?.value !== true) return { loopback_cdp_url: null, verified: false };

        this.loopback_cdp_url = version.webSocketDebuggerUrl;
        return { loopback_cdp_url: this.loopback_cdp_url, verified: true, version };
      } finally { ws.close(); }
    } catch { return { loopback_cdp_url: null, verified: false }; }
  },

  async sendLoopback(method, params = {}) {
    if (!this.loopback_cdp_url) throw new Error(`No loopback_cdp_url configured for ${method}.`);

    const ws = await openCDPSocket(this.loopback_cdp_url);
    try {
      const callOnWs = (m, p = {}, sid = null) => {
        const id = nextLoopbackId++;
        const message = { id, method: m, params: p }; if (sid) message.sessionId = sid;
        ws.send(JSON.stringify(message));
        return new Promise((resolve, reject) => {
          ws.addEventListener("message", event => {
            const msg = JSON.parse(event.data);
            if (msg.id !== id) return;
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result || {});
          });
          ws.addEventListener("error", reject, { once: true });
        });
      };
      await callOnWs("Target.setAutoAttach", targetAutoAttachParams);
      return await callOnWs(method, params);
    } finally { ws.close(); }
  },

  async sendChromeDebugger(method, params = {}) {
    if (!chrome?.debugger?.sendCommand) throw new Error("chrome.debugger is unavailable.");

    const { debuggee = null, tabId = null, targetId = null, extensionId = null, ...commandParams } = params;
    const resolvedDebuggee = debuggee || { tabId, targetId, extensionId };
    for (const key of Object.keys(resolvedDebuggee)) {
      if (resolvedDebuggee[key] === null || resolvedDebuggee[key] === undefined) delete resolvedDebuggee[key];
    }
    if (Object.keys(resolvedDebuggee).length === 0) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) throw new Error(`chrome_debugger route for ${method} could not find an active tab.`);
      resolvedDebuggee.tabId = tab.id;
    }

    const key = JSON.stringify(resolvedDebuggee);
    if (!attachedDebuggees.has(key)) {
      try { await new Promise((resolve, reject) => chrome.debugger.attach(resolvedDebuggee, "1.3", () => {
        const error = chrome.runtime.lastError; if (error) reject(new Error(error.message)); else resolve();
      })); } catch (error) {
        if (!error.message.includes("Another debugger is already attached")) throw error;
      }
      await new Promise((resolve, reject) => chrome.debugger.sendCommand(resolvedDebuggee, "Target.setAutoAttach", targetAutoAttachParams, () => {
        const error = chrome.runtime.lastError; if (error) reject(new Error(error.message)); else resolve();
      }));
      attachedDebuggees.add(key);
    }

    return new Promise((resolve, reject) => chrome.debugger.sendCommand(resolvedDebuggee, method, commandParams, result => {
      const error = chrome.runtime.lastError; if (error) reject(new Error(error.message)); else resolve(result);
    }));
  },
};

// Built-in Magic.ping command — used by clients to confirm the round trip works.
MagicCDPServer.addCustomCommand({
  name: "Magic.ping",
  handler: async (params = {}, meta = {}) => {
    await MagicCDPServer.emit("Magic.pong", {
      sentAt: params.sentAt || null,
      receivedAt: Date.now(),
      from: "extension-service-worker",
    }, meta);
    return { ok: true };
  },
});
