import { EventEmitter } from "node:events";

const SCAN_INTERVAL_MS = 50;
const MAGIC_BINDING = "__magic_event";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const ROUTES = Object.freeze({
  SERVICE_WORKER: "service_worker",
  DIRECT_CDP: "direct_cdp",
  LOOPBACK_CDP: "loopback_cdp",
  CHROME_DEBUGGER: "chrome_debugger",
});

const DEFAULT_CLIENT_ROUTES = Object.freeze({
  "Magic.*": ROUTES.SERVICE_WORKER,
  "Custom.*": ROUTES.SERVICE_WORKER,
  "*.*": ROUTES.DIRECT_CDP,
});

const DEFAULT_SERVER_ROUTES = Object.freeze({
  "Magic.*": ROUTES.SERVICE_WORKER,
  "Custom.*": ROUTES.SERVICE_WORKER,
  "Browser.*": ROUTES.LOOPBACK_CDP,
  "*.*": ROUTES.CHROME_DEBUGGER,
});

function matchRoute(method, routes) {
  if (routes[method]) return routes[method];
  const [domain] = method.split(".");
  if (routes[`${domain}.*`]) return routes[`${domain}.*`];
  return routes["*.*"] ?? null;
}

function isCustomEventName(name) {
  if (!name.includes(".")) return false;
  return name.startsWith("Magic.") || name.startsWith("Custom.");
}

function originFromCdpUrl(cdpUrl) {
  const trimmed = cdpUrl.replace(/\/$/, "");
  if (/^wss?:/.test(trimmed)) {
    const httpish = trimmed.replace(/^ws/, "http");
    return httpish.replace(/\/devtools\/.*$/, "");
  }
  return trimmed.replace(/\/devtools\/.*$/, "");
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  return res.json();
}

async function pollUntil(fn, intervalMs = SCAN_INTERVAL_MS) {
  while (true) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await sleep(intervalMs);
  }
}

class RawCdp extends EventEmitter {
  constructor(wsUrl) {
    super();
    this.setMaxListeners(0);
    this.wsUrl = wsUrl;
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.addEventListener("message", (event) =>
      this._onMessage(JSON.parse(event.data))
    );
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(this), { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  _onMessage(message) {
    if (message.method) {
      this.emit(message.method, message.params || {}, message.sessionId);
    }
    if (message.id == null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new Error(`${pending.method} -> ${message.error.message}`)
      );
    } else {
      pending.resolve(message.result || {});
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

// Code that the client evaluates inside the service worker target to install
// the MagicCDPServer surface. The extension service_worker.js itself can stay
// effectively empty -- everything below is bootstrapped at connect() time.
const SERVER_BOOTSTRAP = `
(() => {
  if (globalThis.MagicCDPServer) return { ready: true, reused: true };

  const customCommands = new Map();
  const customEvents = new Map();
  const BINDING_NAME = ${JSON.stringify(MAGIC_BINDING)};

  const compile = (script) => {
    if (typeof script === "function") return script;
    const fn = (0, eval)("(" + script + ")");
    if (typeof fn !== "function") {
      throw new Error("MagicCDP script must evaluate to a function");
    }
    return fn;
  };

  const emit = (event, data) => {
    const binding = globalThis[BINDING_NAME];
    if (typeof binding !== "function") {
      throw new Error("MagicCDP binding " + BINDING_NAME + " is not registered yet");
    }
    binding(JSON.stringify({ event, data: data ?? null }));
  };

  const addCustomCommand = ({ customMethod, script, paramsSchema, resultSchema }) => {
    if (!customMethod) throw new Error("addCustomCommand requires customMethod");
    customCommands.set(customMethod, { fn: compile(script), paramsSchema, resultSchema });
    return { registered: customMethod };
  };

  const addCustomEvent = ({ customEvent, resultSchema }) => {
    if (!customEvent) throw new Error("addCustomEvent requires customEvent");
    customEvents.set(customEvent, { resultSchema });
    return { registered: customEvent };
  };

  const dispatch = async (method, params = {}) => {
    if (method === "Magic.evaluate") {
      const fn = compile(params.script);
      return await fn(params.params || {}, server);
    }
    if (method === "Magic.addCustomCommand") return addCustomCommand(params);
    if (method === "Magic.addCustomEvent") return addCustomEvent(params);
    if (method === "Magic.ping") {
      emit("Magic.pong", { ts: Date.now(), value: params.value ?? null });
      return { pong: true };
    }
    const handler = customCommands.get(method);
    if (handler) return await handler.fn(params || {}, server);
    throw new Error("Unknown MagicCDP method: " + method);
  };

  const server = {
    customCommands,
    customEvents,
    addCustomCommand,
    addCustomEvent,
    emit,
    dispatch,
  };
  globalThis.MagicCDPServer = server;
  globalThis.MagicCDP = server; // user-facing alias for scripts
  return { ready: true, reused: false };
})();
`;

export class MagicCDPClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.setMaxListeners(0);
    const url = opts.cdp_url ?? opts.direct_cdp_url;
    if (!url) throw new Error("MagicCDPClient requires cdp_url");
    this.cdp_url = url;
    this.routes = { ...DEFAULT_CLIENT_ROUTES, ...(opts.routes || {}) };
    this.serverConfig = opts.server
      ? { routes: { ...DEFAULT_SERVER_ROUTES, ...(opts.server.routes || {}) }, loopback_cdp_url: opts.server.loopback_cdp_url ?? null }
      : null;
    this.types = opts.types || {}; // pluggable schema registry (zod / jsonschema / chrome.* shapes)

    this._cdp = null;
    this._extTargetId = null;
    this._extCdpSessionId = null;

    this.latency = null;
    this.lastPingTs = null;
  }

  get sessionId() {
    return this._extCdpSessionId;
  }

  async connect() {
    const httpOrigin = originFromCdpUrl(this.cdp_url);
    const version = await pollUntil(() => fetchJson(`${httpOrigin}/json/version`));
    this._cdp = new RawCdp(version.webSocketDebuggerUrl);
    await this._cdp.open();

    this._cdp.on("Runtime.bindingCalled", (params, sessionId) =>
      this._onBindingCalled(params, sessionId)
    );

    const target = await pollUntil(async () => {
      const list = await fetchJson(`${httpOrigin}/json/list`);
      return list.find(
        (t) =>
          t.type === "service_worker" &&
          t.url.startsWith("chrome-extension://") &&
          t.url.endsWith("/service_worker.js")
      );
    });
    this._extTargetId = target.id;

    const attached = await this._cdp.send("Target.attachToTarget", {
      targetId: target.id,
      flatten: true,
    });
    this._extCdpSessionId = attached.sessionId;

    await this._cdp.send("Runtime.enable", {}, this._extCdpSessionId);
    await this._cdp.send(
      "Runtime.addBinding",
      { name: MAGIC_BINDING },
      this._extCdpSessionId
    );

    const bootstrap = await this._cdp.send(
      "Runtime.evaluate",
      { expression: SERVER_BOOTSTRAP, awaitPromise: true, returnByValue: true },
      this._extCdpSessionId
    );
    if (bootstrap.exceptionDetails) {
      throw new Error(
        `MagicCDP bootstrap failed: ${
          bootstrap.exceptionDetails.exception?.description ||
          bootstrap.exceptionDetails.text
        }`
      );
    }

    super.on("Magic.pong", () => {
      if (this.lastPingTs != null) this.latency = Date.now() - this.lastPingTs;
    });

    const pong = new Promise((resolve) => super.once("Magic.pong", resolve));
    this.lastPingTs = Date.now();
    await this.send("Magic.ping");
    await pong;

    return this;
  }

  _onBindingCalled(params, sessionId) {
    if (sessionId !== this._extCdpSessionId) return;
    if (params.name !== MAGIC_BINDING) return;
    let parsed;
    try {
      parsed = JSON.parse(params.payload);
    } catch {
      return;
    }
    super.emit(parsed.event, parsed.data);
  }

  async send(method, params = {}, options = {}) {
    const route = matchRoute(method, this.routes);
    if (route === ROUTES.SERVICE_WORKER) {
      return this._sendViaServiceWorker(method, params);
    }
    if (route === ROUTES.DIRECT_CDP) {
      return this._cdp.send(method, params, options.sessionId);
    }
    throw new Error(
      `MagicCDPClient: route ${route} for ${method} not implemented client-side`
    );
  }

  async _sendViaServiceWorker(method, params) {
    const expression =
      `globalThis.MagicCDPServer.dispatch(${JSON.stringify(method)}, ${JSON.stringify(params || {})})`;
    const response = await this._cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      this._extCdpSessionId
    );
    if (response.exceptionDetails) {
      throw new Error(
        `${method} -> ${
          response.exceptionDetails.exception?.description ||
          response.exceptionDetails.text
        }`
      );
    }
    return response.result?.value;
  }

  on(event, listener) {
    if (event.includes(".") && !isCustomEventName(event)) {
      this._cdp.on(event, listener);
      return this;
    }
    super.on(event, listener);
    return this;
  }

  off(event, listener) {
    if (event.includes(".") && !isCustomEventName(event)) {
      this._cdp.off(event, listener);
      return this;
    }
    super.off(event, listener);
    return this;
  }

  async close() {
    if (this._cdp) this._cdp.close();
  }
}

export function MagicCDP(opts) {
  return new MagicCDPClient(opts);
}
