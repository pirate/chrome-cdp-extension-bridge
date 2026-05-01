// MagicCDPServer: lives inside the extension service worker. Owns the registry
// of custom commands and event bindings, and emits events through the binding
// API installed by the client (Runtime.addBinding -> globalThis[bindingName]).
//
// Re-uses translate.js for the shared { event, data, cdpSessionId } payload
// encoding so binding payloads stay byte-compatible with the client-side
// unwrapEventIfNeeded.

import { bindingNameFor, encodeBindingPayload } from "./translate.js";
import type { cdp } from "../types/cdp.js";
import type {
  CdpDebuggeeCommandParams,
  MagicConfigureParams,
  MagicCustomCommandRegistration,
  MagicCustomEventRegistration,
  MagicMiddlewareRegistration,
  MagicPingParams,
  MagicRoutes,
  ProtocolParams,
  ProtocolPayload,
  ProtocolResult,
} from "../types/magic.js";

type MiddlewarePhase = "request" | "response" | "event";

const commandHandlers = new Map<string, MagicCustomCommandRegistration>();
const eventBindings = new Map<string, MagicCustomEventRegistration>();
const middlewares = {
  request: [],
  response: [],
  event: [],
} satisfies Record<MiddlewarePhase, MagicMiddlewareRegistration[]>;
const attachedDebuggees = new Set<string>();

const targetAutoAttachParams = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
} satisfies cdp.types.ts.Target.SetAutoAttachParams;

const defaultRoutes = {
  "Magic.*": "service_worker",
  "Custom.*": "service_worker",
  "*.*": "auto",
} satisfies MagicRoutes;

const browserLevelDomains = new Set(["Browser", "Target", "SystemInfo"]);

let nextLoopbackId = 1;

async function resolveCDPEndpoint(endpoint: string | null) {
  if (!endpoint || /^wss?:\/\//i.test(endpoint)) return endpoint;
  const { webSocketDebuggerUrl } = await fetch(`${endpoint}/json/version`).then((r) => r.json());
  if (!webSocketDebuggerUrl) throw new Error(`loopback_cdp_url HTTP discovery returned no webSocketDebuggerUrl.`);
  return webSocketDebuggerUrl;
}

async function openCDPSocket(endpoint: string): Promise<WebSocket> {
  if (!/^wss?:\/\//i.test(endpoint)) {
    throw new Error(`loopback_cdp_url must be a ws:// or wss:// CDP websocket URL, got ${endpoint}.`);
  }
  return new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(endpoint);
    w.addEventListener("open", () => resolve(w), { once: true });
    w.addEventListener("error", reject, { once: true });
  });
}

export const MagicCDPServer = {
  routes: { ...defaultRoutes },
  loopback_cdp_url: null,
  browserToken: null,

  async configure(params: MagicConfigureParams = {}) {
    const { loopback_cdp_url = this.loopback_cdp_url, routes, browserToken = this.browserToken } = params;
    this.loopback_cdp_url = await resolveCDPEndpoint(loopback_cdp_url);
    this.browserToken = browserToken;
    if (routes) this.routes = { ...defaultRoutes, ...routes };
    else {
      this.routes = { ...defaultRoutes };
      await this.discoverLoopbackCDP();
    }
    return { loopback_cdp_url: this.loopback_cdp_url, routes: this.routes };
  },

  addCustomCommand({
    name,
    paramsSchema = null,
    resultSchema = null,
    expression = null,
    handler,
  }: MagicCustomCommandRegistration) {
    if (!name || !name.includes(".")) throw new Error("name must be in Domain.method form.");
    if (typeof handler !== "function") throw new Error(`Custom command ${name} was registered without a handler.`);
    commandHandlers.set(name, { name, handler, paramsSchema, resultSchema, expression });
    return { name, registered: true };
  },

  addCustomEvent({ name, bindingName, eventSchema = null }: MagicCustomEventRegistration) {
    if (!name || !name.includes(".")) throw new Error("name must be in Domain.event form.");
    if (!bindingName) throw new Error(`Custom event ${name} is missing a Runtime binding name.`);
    eventBindings.set(name, { name, bindingName, eventSchema });
    return { name, bindingName, registered: true };
  },

  addMiddleware({ name = "*", phase, expression = null, handler }: MagicMiddlewareRegistration) {
    if (!["request", "response", "event"].includes(phase))
      throw new Error("phase must be request, response, or event.");
    if (name !== "*" && (!name || !name.includes("."))) throw new Error("name must be '*' or Domain.name form.");
    if (typeof handler !== "function") {
      throw new Error(`Middleware ${name}:${phase} was registered without a handler.`);
    }
    middlewares[phase].push({ name, phase, expression, handler });
    return { name, phase, registered: true };
  },

  async runMiddleware(phase: MiddlewarePhase, name: string, payload: ProtocolPayload, context: ProtocolPayload = {}) {
    const matching = (middlewares[phase] || []).filter(
      (middleware) => middleware.name === "*" || middleware.name === name,
    );
    const dispatch = async (index: number, value: ProtocolPayload): Promise<ProtocolPayload> => {
      const middleware = matching[index];
      if (!middleware) return value;
      let nextCalled = false;
      const next = async (nextValue = value) => {
        if (nextCalled)
          throw new Error(`Middleware ${middleware.name}:${middleware.phase} called next() more than once.`);
        nextCalled = true;
        return dispatch(index + 1, nextValue);
      };
      const ctx = context && typeof context === "object" ? context : {};
      return middleware.handler(value, next, { ...ctx, name, phase });
    };
    return dispatch(0, payload);
  },

  async handleCommand(method: string, params: ProtocolParams = {}, cdpSessionId: string | null = null) {
    const request = { method, params, cdpSessionId };
    params = await this.runMiddleware("request", method, params, { cdpSessionId, request });

    const command = commandHandlers.get(method);
    let result;
    if (command) {
      result = await command.handler(params, cdpSessionId);
      return this.runMiddleware("response", method, result, {
        cdpSessionId,
        request: { ...request, params },
        response: { result },
      });
    }

    let upstream = "chrome_debugger";
    for (const [pattern, route] of Object.entries(this.routes || {}) as [string, string][]) {
      if (pattern === "*.*") {
        upstream = route;
        continue;
      }
      if (pattern.endsWith(".*") && method.startsWith(pattern.slice(0, -1))) {
        upstream = route;
        break;
      }
      if (pattern === method) {
        upstream = route;
        break;
      }
    }

    if (upstream === "auto") {
      if (this.loopback_cdp_url) {
        try {
          result = await this.sendLoopback(method, params);
        } catch {
          result = await this.sendChromeDebugger(method, params);
        }
      } else {
        result = await this.sendChromeDebugger(method, params);
      }
    } else if (upstream === "loopback_cdp") result = await this.sendLoopback(method, params);
    else if (upstream === "chrome_debugger") result = await this.sendChromeDebugger(method, params);
    else throw new Error(`No MagicCDP command registered for ${method}.`);

    return this.runMiddleware("response", method, result, {
      cdpSessionId,
      request: { ...request, params },
      response: { result },
    });
  },

  attachToSession(cdpSessionId: string | null = null) {
    return {
      sessionId: cdpSessionId,
      send: (method: string, params: ProtocolParams = {}) => this.handleCommand(method, params, cdpSessionId),
      emit: (eventName: string, payload: ProtocolPayload = {}) => this.emit(eventName, payload, cdpSessionId),
    };
  },

  async emit(eventName: string, payload: ProtocolPayload = {}, cdpSessionId: string | null = null) {
    const event = eventBindings.get(eventName);
    if (!event) return { event: eventName, emitted: false, reason: "event_not_registered" };
    const binding = globalThis[event.bindingName];
    if (typeof binding !== "function") return { event: eventName, emitted: false, reason: "binding_not_installed" };

    payload = await this.runMiddleware("event", eventName, payload, {
      cdpSessionId,
      event: { name: eventName, payload },
    });
    if (payload === undefined) return { event: eventName, emitted: false, reason: "middleware_dropped" };

    binding(encodeBindingPayload({ event: eventName, data: payload, cdpSessionId }));
    return { event: eventName, emitted: true };
  },

  async discoverLoopbackCDP() {
    if (!this.browserToken) return { loopback_cdp_url: null, verified: false };

    const url = "http://127.0.0.1:9222";
    try {
      const version = await fetch(`${url}/json/version`).then((response) => response.ok && response.json());
      if (!version?.webSocketDebuggerUrl) return { loopback_cdp_url: null, verified: false };

      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const w = new WebSocket(version.webSocketDebuggerUrl);
        w.addEventListener("open", () => resolve(w), { once: true });
        w.addEventListener("error", reject, { once: true });
      });
      try {
        const callOnWs = (
          method: string,
          params: ProtocolParams = {},
          sessionId: string | null = null,
        ): Promise<ProtocolResult> => {
          const id = nextLoopbackId++;
          const message: { id: number; method: string; params: ProtocolParams; sessionId?: string } = {
            id,
            method,
            params,
          };
          if (sessionId) message.sessionId = sessionId;
          ws.send(JSON.stringify(message));
          return new Promise((resolve, reject) => {
            ws.addEventListener("message", (event) => {
              const msg = JSON.parse(event.data);
              if (msg.id !== id) return;
              if (msg.error) reject(new Error(msg.error.message));
              else resolve(msg.result || {});
            });
            ws.addEventListener("error", reject, { once: true });
          });
        };

        await callOnWs("Target.setAutoAttach", targetAutoAttachParams);
        const { targetInfos } = (await callOnWs("Target.getTargets")) as cdp.types.ts.Target.GetTargetsResult;
        const worker = targetInfos.find(
          (target) =>
            target.type === "service_worker" &&
            target.url === `chrome-extension://${chrome.runtime.id}/service_worker.js`,
        );
        if (!worker) return { loopback_cdp_url: null, verified: false };

        const { sessionId } = (await callOnWs("Target.attachToTarget", {
          targetId: worker.targetId,
          flatten: true,
        })) as cdp.types.ts.Target.AttachToTargetResult;
        const result = (await callOnWs(
          "Runtime.evaluate",
          {
            expression: `globalThis.MagicCDP?.browserToken === ${JSON.stringify(this.browserToken)}`,
            returnByValue: true,
          },
          sessionId,
        )) as cdp.types.ts.Runtime.EvaluateResult;
        if (result.result?.value !== true) return { loopback_cdp_url: null, verified: false };

        this.loopback_cdp_url = version.webSocketDebuggerUrl;
        return { loopback_cdp_url: this.loopback_cdp_url, verified: true, version };
      } finally {
        ws.close();
      }
    } catch {
      return { loopback_cdp_url: null, verified: false };
    }
  },

  async sendLoopback(method: string, params: ProtocolParams = {}) {
    if (!this.loopback_cdp_url) throw new Error(`No loopback_cdp_url configured for ${method}.`);

    const ws = await openCDPSocket(this.loopback_cdp_url);
    try {
      const callOnWs = (m: string, p: ProtocolParams = {}, sid: string | null = null): Promise<ProtocolResult> => {
        const id = nextLoopbackId++;
        const message: { id: number; method: string; params: ProtocolParams; sessionId?: string } = {
          id,
          method: m,
          params: p,
        };
        if (sid) message.sessionId = sid;
        ws.send(JSON.stringify(message));
        return new Promise((resolve, reject) => {
          ws.addEventListener("message", (event) => {
            const msg = JSON.parse(event.data);
            if (msg.id !== id) return;
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result || {});
          });
          ws.addEventListener("error", reject, { once: true });
        });
      };
      await callOnWs("Target.setAutoAttach", targetAutoAttachParams);

      const domain = method.split(".")[0] ?? "";
      if (browserLevelDomains.has(domain)) return await callOnWs(method, params);

      const {
        debuggee = null,
        tabId = null,
        targetId = null,
        extensionId = null,
        ...commandParams
      } = params as CdpDebuggeeCommandParams;
      const resolvedDebuggee = debuggee || { tabId, targetId, extensionId };
      for (const key of Object.keys(resolvedDebuggee)) {
        if (resolvedDebuggee[key] === null || resolvedDebuggee[key] === undefined) delete resolvedDebuggee[key];
      }

      let resolvedTargetId = resolvedDebuggee.targetId || null;
      if (!resolvedTargetId) {
        let resolvedTabId = resolvedDebuggee.tabId || null;
        if (!resolvedTabId) {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          if (!tab?.id) throw new Error(`loopback_cdp route for ${method} could not find an active tab.`);
          resolvedTabId = tab.id;
        }
        const targets = await chrome.debugger.getTargets();
        resolvedTargetId =
          targets.find((target) => target.tabId === resolvedTabId && target.type === "page")?.id || null;
      }
      if (!resolvedTargetId) throw new Error(`loopback_cdp route for ${method} could not resolve a page target.`);

      const { sessionId } = (await callOnWs("Target.attachToTarget", {
        targetId: resolvedTargetId,
        flatten: true,
      })) as cdp.types.ts.Target.AttachToTargetResult;
      try {
        return await callOnWs(method, commandParams, sessionId);
      } finally {
        await callOnWs("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    } finally {
      ws.close();
    }
  },

  async sendChromeDebugger(method: string, params: ProtocolParams = {}) {
    if (!chrome?.debugger?.sendCommand) throw new Error("chrome.debugger is unavailable.");

    const {
      debuggee = null,
      tabId = null,
      targetId = null,
      extensionId = null,
      ...commandParams
    } = params as CdpDebuggeeCommandParams;
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
      try {
        await new Promise<void>((resolve, reject) =>
          chrome.debugger.attach(resolvedDebuggee, "1.3", () => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve();
          }),
        );
      } catch (error) {
        if (!error.message.includes("Another debugger is already attached")) throw error;
      }
      await new Promise<void>((resolve, reject) =>
        chrome.debugger.sendCommand(resolvedDebuggee, "Target.setAutoAttach", targetAutoAttachParams, () => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve();
        }),
      );
      attachedDebuggees.add(key);
    }

    return new Promise<ProtocolResult>((resolve, reject) =>
      chrome.debugger.sendCommand(resolvedDebuggee, method, commandParams, (result) => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else resolve(result);
      }),
    );
  },
};

// Built-in Magic.ping command — used by clients to confirm the round trip works.
MagicCDPServer.addCustomEvent({
  name: "Magic.pong",
  bindingName: bindingNameFor("Magic.pong"),
});

MagicCDPServer.addCustomCommand({
  name: "Magic.ping",
  handler: async (params: MagicPingParams = {}, cdpSessionId: string | null = null) => {
    const receivedAt = Date.now();
    await MagicCDPServer.emit(
      "Magic.pong",
      {
        sentAt: typeof params.sentAt === "number" ? params.sentAt : receivedAt,
        receivedAt,
        from: "extension-service-worker",
      },
      cdpSessionId,
    );
    return { ok: true };
  },
});

MagicCDPServer.addCustomCommand({
  name: "Magic.configure",
  handler: async (params: MagicConfigureParams = {}) => MagicCDPServer.configure(params),
});

MagicCDPServer.addCustomCommand({
  name: "Magic.addMiddleware",
  handler: async (params: ProtocolParams = {}) => MagicCDPServer.addMiddleware(params as MagicMiddlewareRegistration),
});
