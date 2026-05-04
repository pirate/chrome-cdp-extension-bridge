// CDPModServer: lives inside an extension service worker. Owns the registry
// of custom commands and event bindings, and emits events through the binding
// API installed by the client (Runtime.addBinding -> globalThis[bindingName]).
//
// The installer is intentionally self-contained so the bridge can inject the
// same server implementation into an already-running extension service worker
// when Chrome refuses Extensions.loadUnpacked.

import type { cdp } from "../types/cdp.js";
import type {
  CdpDebuggeeCommandParams,
  CDPModConfigureParams,
  CDPModCustomCommandRegistration,
  CDPModCustomEventRegistration,
  CDPModMiddlewareRegistration,
  CDPModPingParams,
  CDPModRoutes,
  ProtocolParams,
  ProtocolPayload,
  ProtocolResult,
} from "../types/cdpmod.js";

type MiddlewarePhase = "request" | "response" | "event";

export function installCDPModServer(globalScope: typeof globalThis = globalThis) {
  const CDPMOD_SERVER_VERSION = 1;
  if (
    globalScope.CDPMod?.__CDPModServerVersion === CDPMOD_SERVER_VERSION &&
    globalScope.CDPMod?.handleCommand &&
    globalScope.CDPMod?.addCustomEvent
  )
    return globalScope.CDPMod;

  const BINDING_PREFIX = "__CDPMod_";
  const bindingNameFor = (eventName: string) => BINDING_PREFIX + eventName.replaceAll(".", "_").replaceAll("*", "all");
  const encodeBindingPayload = ({
    event,
    data,
    cdpSessionId = null,
  }: {
    event: string;
    data: ProtocolPayload;
    cdpSessionId?: string | null;
  }) => JSON.stringify({ event, data, cdpSessionId });

  const commandHandlers = new Map<string, CDPModCustomCommandRegistration>();
  const eventBindings = new Map<string, CDPModCustomEventRegistration>();
  const eventListeners = new Set<(event: string, data: ProtocolPayload, cdpSessionId: string | null) => void>();
  const middlewares = {
    request: [],
    response: [],
    event: [],
  } satisfies Record<MiddlewarePhase, CDPModMiddlewareRegistration[]>;
  const attachedDebuggees = new Set<string>();
  let runtime_types_promise: Promise<unknown> | null = null;

  const targetAutoAttachParams = {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  } satisfies cdp.types.ts.Target.SetAutoAttachParams;

  const defaultRoutes = {
    "Mod.*": "service_worker",
    "Custom.*": "service_worker",
    "*.*": "auto",
  } satisfies CDPModRoutes;

  const browserLevelDomains = new Set(["Browser", "Target", "SystemInfo"]);

  let nextLoopbackId = 1;
  const loopbackSockets = new Map<string, WebSocket>();
  const loopbackSocketPromises = new Map<string, Promise<WebSocket>>();
  const loopbackTargetSessions = new Map<string, string>();
  const initializedLoopbackSockets = new WeakSet<WebSocket>();
  const loopbackPending = new Map<
    number,
    { resolve: (value: ProtocolResult) => void; reject: (error: Error) => void }
  >();
  const offscreenKeepAlivePortName = "CDPModOffscreenKeepAlive";
  const offscreenKeepAlivePath = "offscreen/keepalive.html";
  let creatingOffscreenKeepAlive: Promise<void> | null = null;
  let offscreenKeepAlivePort: chrome.runtime.Port | null = null;

  function registryMatch<T>(registry: Map<string, T>, name: string): T | null {
    const exact = registry.get(name);
    if (exact) return exact;
    let match: T | null = null;
    let matchPrefixLength = -1;
    for (const [pattern, value] of registry) {
      if (!pattern.endsWith(".*")) continue;
      const prefix = pattern.slice(0, -1);
      if (!name.startsWith(prefix) || prefix.length <= matchPrefixLength) continue;
      match = value;
      matchPrefixLength = prefix.length;
    }
    return match;
  }

  function normalizeCDPModName(
    value:
      | {
          cdp_command_name?: string;
          cdp_event_name?: string;
          id?: string;
          name?: string;
          meta?: () => { cdp_command_name?: unknown; cdp_event_name?: unknown; id?: unknown; name?: unknown };
        }
      | string,
  ) {
    if (typeof value === "string") return value;
    const meta = typeof value?.meta === "function" ? value.meta() : undefined;
    const name =
      value?.cdp_command_name ??
      value?.cdp_event_name ??
      (typeof meta?.cdp_command_name === "string" ? meta.cdp_command_name : undefined) ??
      (typeof meta?.cdp_event_name === "string" ? meta.cdp_event_name : undefined) ??
      value?.id ??
      (typeof meta?.id === "string" ? meta.id : undefined) ??
      (typeof meta?.name === "string" ? meta.name : undefined) ??
      value?.name;
    if (typeof name !== "string" || !name) throw new Error("Expected a CDP name string or a named CDP schema/alias.");
    return name;
  }

  async function resolveCDPEndpoint(endpoint: string | null) {
    if (!endpoint || /^wss?:\/\//i.test(endpoint)) return endpoint;
    if (!/^https?:\/\//i.test(endpoint)) {
      throw new Error(`loopback_cdp_url must be a ws://, wss://, http://, or https:// CDP endpoint, got ${endpoint}.`);
    }
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
      let settled = false;
      let errorEvent: Event | null = null;
      const describe = (prefix: string, closeEvent?: CloseEvent) => {
        const parts = [`${prefix} ${endpoint}`, `readyState=${w.readyState}`];
        if (errorEvent) parts.push(`error.type=${errorEvent.type}`);
        if (closeEvent) {
          parts.push(`close.code=${closeEvent.code}`);
          parts.push(`close.reason=${closeEvent.reason || ""}`);
          parts.push(`close.wasClean=${closeEvent.wasClean}`);
        }
        return parts.join(" ");
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      w.addEventListener(
        "open",
        () => {
          if (settled) return;
          settled = true;
          resolve(w);
        },
        { once: true },
      );
      w.addEventListener(
        "error",
        (event) => {
          errorEvent = event;
          setTimeout(() => fail(new Error(describe("CDP socket error"))), 250);
        },
        { once: true },
      );
      w.addEventListener("close", (event) => fail(new Error(describe("CDP socket closed", event))), { once: true });
    });
  }

  function startOffscreenKeepAlive() {
    void ensureOffscreenKeepAlive().catch(() => {});
  }

  function rejectLoopbackPending(error: Error) {
    for (const pending of loopbackPending.values()) pending.reject(error);
    loopbackPending.clear();
  }

  async function loopbackWS(endpoint: string): Promise<WebSocket> {
    const existing = loopbackSockets.get(endpoint);
    if (existing?.readyState === WebSocket.OPEN) return existing;
    const pending = loopbackSocketPromises.get(endpoint);
    if (pending) return pending;

    const nextSocket = openCDPSocket(endpoint).then((ws) => {
      loopbackSockets.set(endpoint, ws);
      loopbackSocketPromises.delete(endpoint);
      ws.addEventListener("message", (event) => {
        const msg = JSON.parse(event.data);
        const id = typeof msg.id === "number" ? msg.id : null;
        if (id == null) {
          const method = typeof msg.method === "string" ? msg.method : null;
          if (!method) return;
          const payload =
            msg.params && typeof msg.params === "object" && !Array.isArray(msg.params)
              ? (msg.params as ProtocolPayload)
              : {};
          const cdpSessionId = typeof msg.sessionId === "string" ? msg.sessionId : null;
          void CDPModServer.runMiddleware("event", method, payload, {
            cdpSessionId,
            event: { name: method, payload },
          })
            .then((nextPayload) => {
              if (nextPayload === undefined) return;
              for (const listener of eventListeners) {
                try {
                  listener(method, nextPayload, cdpSessionId);
                } catch (error) {
                  console.error("[CDPModServer] event listener failed", error);
                }
              }
            })
            .catch((error) => console.error("[CDPModServer] loopback event listener failed", error));
          return;
        }
        const pending = loopbackPending.get(id);
        if (!pending) return;
        loopbackPending.delete(id);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result || {});
      });
      ws.addEventListener("error", () => {
        if (loopbackSockets.get(endpoint) === ws) loopbackSockets.delete(endpoint);
        loopbackTargetSessions.clear();
        rejectLoopbackPending(new Error(`CDP socket error ${endpoint}`));
      });
      ws.addEventListener("close", (event) => {
        if (loopbackSockets.get(endpoint) === ws) loopbackSockets.delete(endpoint);
        loopbackTargetSessions.clear();
        rejectLoopbackPending(
          new Error(
            `CDP socket closed ${endpoint} close.code=${event.code} close.reason=${event.reason || ""} close.wasClean=${
              event.wasClean
            }`,
          ),
        );
      });
      return ws;
    });
    loopbackSocketPromises.set(endpoint, nextSocket);
    return nextSocket;
  }

  async function callLoopbackWS(method: string, params: ProtocolParams = {}, sessionId: string | null = null) {
    if (!CDPModServer.loopback_cdp_url) throw new Error(`No loopback_cdp_url configured for ${method}.`);
    const ws = await loopbackWS(CDPModServer.loopback_cdp_url);
    const id = nextLoopbackId++;
    const message: { id: number; method: string; params: ProtocolParams; sessionId?: string } = {
      id,
      method,
      params,
    };
    if (sessionId) message.sessionId = sessionId;
    ws.send(JSON.stringify(message));
    return new Promise<ProtocolResult>((resolve, reject) => {
      loopbackPending.set(id, { resolve, reject });
      ws.addEventListener("error", () => reject(new Error(`CDP socket error ${CDPModServer.loopback_cdp_url}`)), {
        once: true,
      });
    });
  }

  async function initializeLoopbackCDP() {
    if (!CDPModServer.loopback_cdp_url) return;
    const ws = await loopbackWS(CDPModServer.loopback_cdp_url);
    if (initializedLoopbackSockets.has(ws)) return;
    await callLoopbackWS("Target.setAutoAttach", targetAutoAttachParams);
    await callLoopbackWS("Target.setDiscoverTargets", { discover: true });
    initializedLoopbackSockets.add(ws);
  }

  async function ensureOffscreenKeepAlive() {
    const chromeApi = globalScope.chrome;
    const offscreen = chromeApi?.offscreen;
    if (!offscreen || !chromeApi?.runtime?.getURL) return { started: false, reason: "offscreen_unavailable" };

    const offscreenUrl = chromeApi.runtime.getURL(offscreenKeepAlivePath);
    try {
      const existingContexts = chromeApi.runtime.getContexts
        ? await chromeApi.runtime.getContexts({
            contextTypes: ["OFFSCREEN_DOCUMENT"],
            documentUrls: [offscreenUrl],
          })
        : [];
      if (existingContexts.length > 0) return { started: true, existing: true };

      creatingOffscreenKeepAlive ??= offscreen
        .createDocument({
          url: offscreenKeepAlivePath,
          reasons: ["BLOBS"],
          justification: "Keep CDPMod service worker active while CDP clients route commands through it.",
        })
        .finally(() => {
          creatingOffscreenKeepAlive = null;
        });
      await creatingOffscreenKeepAlive;
      return { started: true };
    } catch (error) {
      return { started: false, reason: error?.message || String(error) };
    }
  }

  const CDPModServer = {
    __CDPModServerVersion: CDPMOD_SERVER_VERSION,
    routes: { ...defaultRoutes },
    loopback_cdp_url: null,
    browserToken: null,
    types: null,
    commands: null,
    events: null,
    startOffscreenKeepAlive,
    ensureOffscreenKeepAlive,

    async loadTypes() {
      runtime_types_promise ??= import("../types/zod.js").then((module) => {
        this.types = module.types;
        this.commands = module.commands;
        this.events = module.events;
        return module.types;
      });
      return runtime_types_promise;
    },

    async configure(params: CDPModConfigureParams = {}) {
      const {
        loopback_cdp_url = this.loopback_cdp_url,
        routes,
        browserToken = this.browserToken,
        custom_commands = [],
        custom_events = [],
        custom_middlewares = [],
      } = params;
      this.loopback_cdp_url = await resolveCDPEndpoint(loopback_cdp_url);
      this.browserToken = browserToken;
      if (routes) this.routes = { ...defaultRoutes, ...routes };
      else {
        this.routes = { ...defaultRoutes };
        await this.discoverLoopbackCDP();
      }
      for (const command of custom_commands) this.addCustomCommand(command as CDPModCustomCommandRegistration);
      for (const event of custom_events) this.addCustomEvent(event as CDPModCustomEventRegistration);
      for (const middleware of custom_middlewares) this.addMiddleware(middleware as CDPModMiddlewareRegistration);
      await initializeLoopbackCDP();
      return { loopback_cdp_url: this.loopback_cdp_url, routes: this.routes };
    },

    addCustomCommand({
      name,
      paramsSchema = null,
      resultSchema = null,
      expression = null,
      handler,
    }: CDPModCustomCommandRegistration) {
      name = normalizeCDPModName(name);
      if (!/^[^.]+\.[^.]+$/.test(name)) throw new Error("name must be in Domain.method form.");
      if (typeof handler !== "function" && typeof expression === "string") {
        handler = async (params: ProtocolParams = {}, cdpSessionId: string | null = null, method: string = name) => {
          const cdp = CDPModServer.attachToSession(cdpSessionId);
          const CDPMod = CDPModServer;
          const chrome = globalScope.chrome;
          const value = new Function(
            "params",
            "method",
            "cdp",
            "CDPMod",
            "chrome",
            `return (async () => {
              const handler = (${expression});
              return typeof handler === "function" ? await handler(params || {}, method) : handler;
            })()`,
          );
          return await value(params, method, cdp, CDPMod, chrome);
        };
      }
      if (typeof handler !== "function") throw new Error(`Custom command ${name} was registered without a handler.`);
      commandHandlers.set(name, { name, handler, paramsSchema, resultSchema, expression });
      return { name, registered: true };
    },

    addCustomEvent({ name, bindingName, eventSchema = null }: CDPModCustomEventRegistration) {
      name = normalizeCDPModName(name);
      if (!/^[^.]+\.[^.]+$/.test(name)) throw new Error("name must be in Domain.event form.");
      bindingName ??= bindingNameFor(name);
      eventBindings.set(name, { name, bindingName, eventSchema });
      return { name, bindingName, registered: true };
    },

    addEventListener(listener: (event: string, data: ProtocolPayload, cdpSessionId: string | null) => void) {
      eventListeners.add(listener);
      return { remove: () => eventListeners.delete(listener) };
    },

    addMiddleware({ name = "*", phase, expression = null, handler }: CDPModMiddlewareRegistration) {
      name = normalizeCDPModName(name);
      if (!["request", "response", "event"].includes(phase))
        throw new Error("phase must be request, response, or event.");
      if (name !== "*" && (!name || !name.includes("."))) throw new Error("name must be '*' or Domain.name form.");
      if (typeof handler !== "function" && typeof expression === "string") {
        handler = async (payload: ProtocolPayload, next: unknown, context: ProtocolPayload = {}) => {
          const context_object = context && typeof context === "object" ? (context as Record<string, unknown>) : {};
          const cdp = CDPModServer.attachToSession(
            typeof context_object.cdpSessionId === "string" ? context_object.cdpSessionId : null,
          );
          const CDPMod = CDPModServer;
          const chrome = globalScope.chrome;
          const value = new Function(
            "payload",
            "next",
            "context",
            "cdp",
            "CDPMod",
            "chrome",
            `return (async () => {
              const handler = (${expression});
              return await handler(payload, next, context);
            })()`,
          );
          return await value(payload, next, context, cdp, CDPMod, chrome);
        };
      }
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

      const command = registryMatch(commandHandlers, method);
      let result;
      if (command) {
        result = await command.handler(params, cdpSessionId, method);
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
      else throw new Error(`No CDPMod command registered for ${method}.`);

      return this.runMiddleware("response", method, result, {
        cdpSessionId,
        request: { ...request, params },
        response: { result },
      });
    },

    attachToSession(cdpSessionId: string | null = null) {
      return {
        sessionId: cdpSessionId,
        get types() {
          return CDPModServer.types;
        },
        get commands() {
          return CDPModServer.commands;
        },
        get events() {
          return CDPModServer.events;
        },
        send: (method: string, params: ProtocolParams = {}) => this.handleCommand(method, params, cdpSessionId),
        emit: (eventName: string, payload: ProtocolPayload = {}) => this.emit(eventName, payload, cdpSessionId),
      };
    },

    async emit(eventName: string, payload: ProtocolPayload = {}, cdpSessionId: string | null = null) {
      const event = registryMatch(eventBindings, eventName);
      if (!event) return { event: eventName, emitted: false, reason: "event_not_registered" };
      const binding = globalScope[event.bindingName];
      if (typeof binding !== "function") return { event: eventName, emitted: false, reason: "binding_not_installed" };

      payload = await this.runMiddleware("event", eventName, payload, {
        cdpSessionId,
        event: { name: eventName, payload },
      });
      if (payload === undefined) return { event: eventName, emitted: false, reason: "middleware_dropped" };

      for (const listener of eventListeners) {
        try {
          listener(eventName, payload, cdpSessionId);
        } catch (error) {
          console.error("[CDPModServer] event listener failed", error);
        }
      }
      if (typeof binding === "function")
        binding(encodeBindingPayload({ event: eventName, data: payload, cdpSessionId }));
      return { event: eventName, emitted: true };
    },

    async discoverLoopbackCDP() {
      if (!this.browserToken) return { loopback_cdp_url: null, verified: false };

      const url = "http://127.0.0.1:9222";
      const previousLoopbackUrl = this.loopback_cdp_url;
      const fail = (version?: unknown) => {
        this.loopback_cdp_url = previousLoopbackUrl ?? null;
        return { loopback_cdp_url: null, verified: false, ...(version ? { version } : {}) };
      };
      try {
        const version = await fetch(`${url}/json/version`).then((response) => response.ok && response.json());
        if (!version?.webSocketDebuggerUrl) return fail();

        this.loopback_cdp_url = version.webSocketDebuggerUrl;
        const { targetInfos } = (await callLoopbackWS("Target.getTargets")) as cdp.types.ts.Target.GetTargetsResult;
        const chromeApi = globalScope.chrome;
        const worker = targetInfos.find(
          (target) =>
            target.type === "service_worker" &&
            target.url === `chrome-extension://${chromeApi.runtime.id}/service_worker.js`,
        );
        if (!worker) return fail(version);

        const { sessionId } = (await callLoopbackWS("Target.attachToTarget", {
          targetId: worker.targetId,
          flatten: true,
        })) as cdp.types.ts.Target.AttachToTargetResult;
        const result = (await callLoopbackWS(
          "Runtime.evaluate",
          {
            expression: `globalThis.CDPMod?.browserToken === ${JSON.stringify(this.browserToken)}`,
            returnByValue: true,
          },
          sessionId,
        )) as cdp.types.ts.Runtime.EvaluateResult;
        await callLoopbackWS("Target.detachFromTarget", { sessionId }).catch(() => {});
        if (result.result?.value !== true) return fail(version);

        await initializeLoopbackCDP();
        return { loopback_cdp_url: this.loopback_cdp_url, verified: true, version };
      } catch {
        return fail();
      }
    },

    async sendLoopback(method: string, params: ProtocolParams = {}) {
      if (!this.loopback_cdp_url) throw new Error(`No loopback_cdp_url configured for ${method}.`);

      await initializeLoopbackCDP();

      const domain = method.split(".")[0] ?? "";
      if (browserLevelDomains.has(domain)) return await callLoopbackWS(method, params);

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

      const chromeApi = globalScope.chrome;
      let resolvedTargetId = resolvedDebuggee.targetId || null;
      if (!resolvedTargetId) {
        let resolvedTabId = resolvedDebuggee.tabId || null;
        let resolvedTabUrl: string | null = null;
        if (!resolvedTabId) {
          const [tab] = chromeApi.tabs?.query
            ? await chromeApi.tabs.query({ active: true, lastFocusedWindow: true })
            : [];
          resolvedTabId = tab?.id || null;
          resolvedTabUrl = tab?.url || tab?.pendingUrl || null;
        } else if (chromeApi.tabs?.get) {
          const tab = await chromeApi.tabs.get(resolvedTabId).catch(() => null);
          resolvedTabUrl = tab?.url || tab?.pendingUrl || null;
        }
        if (resolvedTabId && chromeApi.debugger?.getTargets) {
          const targets = await chromeApi.debugger.getTargets();
          resolvedTargetId =
            targets.find((target) => target.tabId === resolvedTabId && target.type === "page")?.id || null;
        }
        if (!resolvedTargetId) {
          const { targetInfos } = (await callLoopbackWS("Target.getTargets")) as cdp.types.ts.Target.GetTargetsResult;
          const pageTargets = targetInfos.filter((target) => target.type === "page");
          resolvedTargetId =
            pageTargets.find((target) => resolvedTabUrl && target.url === resolvedTabUrl)?.targetId ||
            pageTargets[0]?.targetId ||
            null;
        }
        if (!resolvedTargetId) {
          const created = (await callLoopbackWS("Target.createTarget", {
            url: "about:blank#cdpmod",
          })) as cdp.types.ts.Target.CreateTargetResult;
          resolvedTargetId = created.targetId || null;
        }
      }
      if (!resolvedTargetId) throw new Error(`loopback_cdp route for ${method} could not resolve a page target.`);

      let sessionId = loopbackTargetSessions.get(resolvedTargetId) || null;
      if (!sessionId) {
        const attached = (await callLoopbackWS("Target.attachToTarget", {
          targetId: resolvedTargetId,
          flatten: true,
        })) as cdp.types.ts.Target.AttachToTargetResult;
        sessionId = attached.sessionId;
        loopbackTargetSessions.set(resolvedTargetId, sessionId);
        await callLoopbackWS("Target.setAutoAttach", targetAutoAttachParams, sessionId).catch(() => {});
      }
      return await callLoopbackWS(method, commandParams, sessionId);
    },

    async sendChromeDebugger(method: string, params: ProtocolParams = {}) {
      const chromeApi = globalScope.chrome;
      if (!chromeApi?.debugger?.sendCommand) throw new Error("chrome.debugger is unavailable.");

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
        let [tab] = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) [tab] = await chromeApi.tabs.query({});
        if (!tab?.id) {
          try {
            tab = await chromeApi.tabs.create({ url: "https://example.com/#cdpmod", active: true });
          } catch {
            const win = await chromeApi.windows.create({ url: "https://example.com/#cdpmod", focused: true });
            tab = win.tabs?.[0] || null;
          }
        }
        if (!tab?.id) throw new Error(`chrome_debugger route for ${method} could not find an active tab.`);
        resolvedDebuggee.tabId = tab.id;
      }

      const key = JSON.stringify(resolvedDebuggee);
      if (!attachedDebuggees.has(key)) {
        try {
          await new Promise<void>((resolve, reject) =>
            chromeApi.debugger.attach(resolvedDebuggee, "1.3", () => {
              const error = chromeApi.runtime.lastError;
              if (error) reject(new Error(error.message));
              else resolve();
            }),
          );
        } catch (error) {
          if (!error.message.includes("Another debugger is already attached")) throw error;
        }
        await new Promise<void>((resolve, reject) =>
          chromeApi.debugger.sendCommand(resolvedDebuggee, "Target.setAutoAttach", targetAutoAttachParams, () => {
            const error = chromeApi.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve();
          }),
        );
        attachedDebuggees.add(key);
      }

      return new Promise<ProtocolResult>((resolve, reject) =>
        chromeApi.debugger.sendCommand(resolvedDebuggee, method, commandParams, (result) => {
          const error = chromeApi.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(result as ProtocolResult);
        }),
      );
    },
  };

  globalScope.CDPMod = CDPModServer;

  CDPModServer.addCustomEvent({
    name: "Mod.pong",
    bindingName: bindingNameFor("Mod.pong"),
  });

  CDPModServer.addCustomCommand({
    name: "Mod.ping",
    handler: async (params: CDPModPingParams = {}, cdpSessionId: string | null = null) => {
      const receivedAt = Date.now();
      await CDPModServer.emit(
        "Mod.pong",
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

  CDPModServer.addCustomCommand({
    name: "Mod.configure",
    handler: async (params: CDPModConfigureParams = {}) => CDPModServer.configure(params),
  });

  CDPModServer.addCustomCommand({
    name: "Mod.evaluate",
    handler: async (raw_params: ProtocolParams = {}) => {
      const { expression, params = {}, cdpSessionId = null } = raw_params as Record<string, unknown>;
      const cdp = CDPModServer.attachToSession(typeof cdpSessionId === "string" ? cdpSessionId : null);
      const CDPMod = CDPModServer;
      const chrome = globalScope.chrome;
      const value = new Function(
        "params",
        "cdp",
        "CDPMod",
        "chrome",
        `return (async () => {
          const value = (${expression});
          return typeof value === "function" ? await value(params || {}) : value;
        })()`,
      );
      return await value(params, cdp, CDPMod, chrome);
    },
  });

  CDPModServer.addCustomCommand({
    name: "Mod.addCustomCommand",
    handler: async (params: ProtocolParams = {}) =>
      CDPModServer.addCustomCommand(params as CDPModCustomCommandRegistration),
  });

  CDPModServer.addCustomCommand({
    name: "Mod.addCustomEvent",
    handler: async (params: ProtocolParams = {}) =>
      CDPModServer.addCustomEvent(params as CDPModCustomEventRegistration),
  });

  CDPModServer.addCustomCommand({
    name: "Mod.addMiddleware",
    handler: async (params: ProtocolParams = {}) => CDPModServer.addMiddleware(params as CDPModMiddlewareRegistration),
  });

  const chromeApi = globalScope.chrome;
  try {
    chromeApi?.runtime?.onStartup?.addListener(startOffscreenKeepAlive);
  } catch {}
  try {
    chromeApi?.runtime?.onInstalled?.addListener(startOffscreenKeepAlive);
  } catch {}
  try {
    chromeApi?.tabs?.onCreated?.addListener(startOffscreenKeepAlive);
  } catch {}
  try {
    chromeApi?.runtime?.onConnect?.addListener((port) => {
      if (port.name !== offscreenKeepAlivePortName) return;
      offscreenKeepAlivePort = port;
      port.onMessage.addListener(() => {});
      port.onDisconnect.addListener(() => {
        if (offscreenKeepAlivePort === port) offscreenKeepAlivePort = null;
      });
    });
  } catch {}
  startOffscreenKeepAlive();

  return CDPModServer;
}

export const CDPModServer = installCDPModServer(globalThis);
