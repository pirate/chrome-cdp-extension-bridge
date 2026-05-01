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

function normalizeMeta(meta = {}) {
  return {
    cdpSessionId: meta.cdpSessionId || null,
  };
}

function optionalChromeApi(name, fallback) {
  return typeof chrome !== "undefined" && chrome[name] ? chrome[name] : fallback;
}

function routeFor(method, routes) {
  let fallback = "chrome_debugger";

  for (const [pattern, upstream] of Object.entries(routes || {})) {
    if (pattern === "*.*") {
      fallback = upstream;
      continue;
    }

    if (pattern.endsWith(".*") && method.startsWith(pattern.slice(0, -1))) {
      return upstream;
    }

    if (pattern === method) return upstream;
  }

  return fallback;
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
}

function sendWsCommand(ws, method, params = {}, sessionId = null) {
  const id = nextLoopbackId++;
  const message = { id, method, params };
  if (sessionId) message.sessionId = sessionId;
  ws.send(JSON.stringify(message));

  return new Promise((resolve, reject) => {
    ws.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result || {});
    });
    ws.addEventListener("error", reject, { once: true });
  });
}

function chromeDebuggerCall(method, ...args) {
  return new Promise((resolve, reject) => {
    chrome.debugger[method](...args, result => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

async function attachChromeDebugger(debuggee) {
  const key = JSON.stringify(debuggee);
  if (attachedDebuggees.has(key)) return;

  try {
    await chromeDebuggerCall("attach", debuggee, "1.3");
  } catch (error) {
    if (!error.message.includes("Another debugger is already attached")) throw error;
  }
  await chromeDebuggerCall("sendCommand", debuggee, "Target.setAutoAttach", targetAutoAttachParams);
  attachedDebuggees.add(key);
}

const MagicCDPServer = {
  routes: { ...defaultRoutes },
  loopback_cdp_url: null,
  browserToken: null,

  async configure({ loopback_cdp_url = this.loopback_cdp_url, routes, browserToken = this.browserToken } = {}) {
    this.loopback_cdp_url = loopback_cdp_url;
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
    customMethod,
    paramsSchema = null,
    resultSchema = null,
    expression = null,
    script = null,
    handler,
  }) {
    const commandName = name ?? customMethod;
    const source = expression ?? script;
    if (!commandName || !commandName.includes(".")) {
      throw new Error("name must be in Domain.method form.");
    }
    if (typeof handler !== "function") {
      throw new Error(`Custom command ${commandName} was registered without a handler.`);
    }

    commandHandlers.set(commandName, { handler, paramsSchema, resultSchema, expression: source });
    return { name: commandName, registered: true };
  },

  addCustomEvent({ name, customEvent, bindingName, payloadSchema = null, resultSchema = null }) {
    const eventName = name ?? customEvent;
    const schema = payloadSchema ?? resultSchema;
    if (!eventName || !eventName.includes(".")) {
      throw new Error("name must be in Domain.event form.");
    }
    if (!bindingName) throw new Error(`Custom event ${eventName} is missing a Runtime binding name.`);

    eventBindings.set(eventName, { bindingName, payloadSchema: schema });
    return { name: eventName, bindingName, registered: true };
  },

  async handleCommand(method, params = {}, meta = {}) {
    const command = commandHandlers.get(method);
    if (command) return command.handler(params, normalizeMeta(meta));

    const upstream = routeFor(method, this.routes);
    if (upstream === "auto") return this.sendAuto(method, params);
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
    if (typeof binding !== "function") {
      return { event: eventName, emitted: false, reason: "binding_not_installed" };
    }

    const normalizedMeta = normalizeMeta(meta);
    binding(JSON.stringify({
      event: eventName,
      data: payload,
      cdpSessionId: normalizedMeta.cdpSessionId,
    }));
    return { event: eventName, emitted: true };
  },

  async discoverLoopbackCDP() {
    if (!this.browserToken) return { loopback_cdp_url: null, verified: false };

    const url = "http://127.0.0.1:9222";
    try {
      const version = await fetch(`${url}/json/version`).then(response => response.ok && response.json());
      if (!version?.webSocketDebuggerUrl) return { loopback_cdp_url: null, verified: false };

      const ws = await openWs(version.webSocketDebuggerUrl);
      try {
        await sendWsCommand(ws, "Target.setAutoAttach", targetAutoAttachParams);
        const { targetInfos } = await sendWsCommand(ws, "Target.getTargets");
        const worker = targetInfos.find(target =>
          target.type === "service_worker"
          && target.url === `chrome-extension://${chrome.runtime.id}/service_worker.js`
        );
        if (!worker) return { loopback_cdp_url: null, verified: false };

        const { sessionId } = await sendWsCommand(ws, "Target.attachToTarget", {
          targetId: worker.targetId,
          flatten: true,
        });
        const result = await sendWsCommand(ws, "Runtime.evaluate", {
          expression: `globalThis.MagicCDP?.browserToken === ${JSON.stringify(this.browserToken)}`,
          returnByValue: true,
        }, sessionId);
        if (result.result?.value !== true) return { loopback_cdp_url: null, verified: false };

        this.loopback_cdp_url = url;
        return { loopback_cdp_url: url, verified: true, version };
      } finally {
        ws.close();
      }
    } catch {
      return { loopback_cdp_url: null, verified: false };
    }
  },

  async sendAuto(method, params = {}) {
    if (this.loopback_cdp_url) {
      try {
        return await this.sendLoopback(method, params);
      } catch {}
    }
    return this.sendChromeDebugger(method, params);
  },

  async sendLoopback(method, params = {}) {
    if (!this.loopback_cdp_url) throw new Error(`No loopback_cdp_url configured for ${method}.`);

    const { webSocketDebuggerUrl } = await fetch(`${this.loopback_cdp_url}/json/version`)
      .then(response => response.json());
    const ws = await openWs(webSocketDebuggerUrl);

    try {
      await sendWsCommand(ws, "Target.setAutoAttach", targetAutoAttachParams);
      return await sendWsCommand(ws, method, params);
    } finally {
      ws.close();
    }
  },

  async sendChromeDebugger(method, params = {}) {
    const debuggerApi = optionalChromeApi("debugger", null);
    if (!debuggerApi?.sendCommand) throw new Error("chrome.debugger is unavailable.");

    const {
      debuggee = null,
      tabId = null,
      targetId = null,
      extensionId = null,
      ...commandParams
    } = params;
    const resolvedDebuggee = debuggee || { tabId, targetId, extensionId };
    for (const key of Object.keys(resolvedDebuggee)) {
      if (resolvedDebuggee[key] === null || resolvedDebuggee[key] === undefined) delete resolvedDebuggee[key];
    }
    if (Object.keys(resolvedDebuggee).length === 0) {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab?.id) throw new Error(`chrome_debugger route for ${method} could not find an active tab.`);
      resolvedDebuggee.tabId = tab.id;
    }

    await attachChromeDebugger(resolvedDebuggee);
    return chromeDebuggerCall("sendCommand", resolvedDebuggee, method, commandParams);
  },

  async requestLoopbackCDP() {
    const tabs = optionalChromeApi("tabs", null);
    if (!tabs?.create) return { opened: false, reason: "chrome.tabs unavailable" };
    await tabs.create({ url: "chrome://inspect/#remote-debugging" });
    return { opened: true };
  },

  async requestDebuggerCDP() {
    const permissions = optionalChromeApi("permissions", null);
    if (!permissions?.request) return { granted: false, reason: "chrome.permissions unavailable" };
    const granted = await permissions.request({ permissions: ["debugger"] });
    return { granted };
  },
};

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

globalThis.MagicCDP = MagicCDPServer;
globalThis.Magic = MagicCDPServer;
