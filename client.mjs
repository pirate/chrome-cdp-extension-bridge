import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import net from "node:net";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const defaultExtensionDir = path.join(rootDir, "extension");
const defaultChromePath = process.env.CHROME_PATH || "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary";
const workerSuffix = "/service_worker.js";
const targetAutoAttachParams = {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
};
const defaultChromeFlags = [
  "--disable-background-networking",
  "--disable-client-side-phishing-detection",
  "--disable-sync",
  "--metrics-recording-only",
  "--disable-default-apps",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
  "--disable-ipc-flooding-protection",
  "--password-store=basic",
  "--use-mock-keychain",
  "--disable-hang-monitor",
  "--disable-prompt-on-repost",
  "--disable-domain-reliability",
  "--remote-allow-origins=*",
  "--enable-unsafe-extension-debugging",
  "--unsafely-disable-devtools-self-xss-warnings",
  "--no-first-run",
  "--no-default-browser-check",
];

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(fn, { timeoutMs = 10_000, intervalMs = 100, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  const suffix = lastError ? ` Last error: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${label}.${suffix}`);
}

function normalizeHttpOrigin(url) {
  const parsed = new URL(url);
  if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
    parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    parsed.pathname = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.origin;
  }
  return parsed.origin;
}

async function resolveCdpEndpoint(cdpUrl) {
  if (cdpUrl.startsWith("ws://") || cdpUrl.startsWith("wss://")) {
    return { wsUrl: cdpUrl, httpOrigin: normalizeHttpOrigin(cdpUrl) };
  }

  const httpOrigin = normalizeHttpOrigin(cdpUrl);
  const response = await fetch(`${httpOrigin}/json/version`);
  if (!response.ok) throw new Error(`GET ${httpOrigin}/json/version failed with ${response.status}`);
  const version = await response.json();
  return { wsUrl: version.webSocketDebuggerUrl, httpOrigin };
}

function routeFor(method, routes) {
  let fallback = "direct_cdp";

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

function createTypesProxy(pathParts = []) {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "toJSON") return () => ({ $ref: pathParts.join(".") });
        if (prop === "toString") return () => pathParts.join(".");
        if (prop === Symbol.toPrimitive) return () => pathParts.join(".");
        return createTypesProxy([...pathParts, String(prop)]);
      },
    },
  );
}

function createSessionRouter(cdp) {
  const targetSessions = new Map();
  const frameSessions = new Map();
  const executionContextSessions = new Map();
  const pendingTargetAttachments = new Map();
  const autoAttachSessions = new Set();

  function enableAutoAttach(sessionId) {
    if (!sessionId || autoAttachSessions.has(sessionId)) return;
    autoAttachSessions.add(sessionId);
    cdp.send("Target.setAutoAttach", targetAutoAttachParams, sessionId).catch(() => {});
  }

  async function attachTarget(targetId) {
    if (targetSessions.has(targetId)) return targetSessions.get(targetId);
    if (pendingTargetAttachments.has(targetId)) return pendingTargetAttachments.get(targetId);

    const pending = cdp.send("Target.attachToTarget", { targetId, flatten: true })
      .then(({ sessionId }) => {
        targetSessions.set(targetId, sessionId);
        enableAutoAttach(sessionId);
        return sessionId;
      })
      .finally(() => pendingTargetAttachments.delete(targetId));
    pendingTargetAttachments.set(targetId, pending);
    return pending;
  }

  function indexEvent(message) {
    const params = message.params || {};
    const sessionId = message.sessionId || params.sessionId || null;

    if (message.method === "Target.attachedToTarget") {
      targetSessions.set(params.targetInfo.targetId, params.sessionId);
      enableAutoAttach(params.sessionId);
      return;
    }

    if (message.method === "Target.detachedFromTarget") {
      for (const [targetId, targetSessionId] of targetSessions) {
        if (targetSessionId === params.sessionId) targetSessions.delete(targetId);
      }
      for (const [frameId, frameSessionId] of frameSessions) {
        if (frameSessionId === params.sessionId) frameSessions.delete(frameId);
      }
      for (const [contextId, contextSessionId] of executionContextSessions) {
        if (contextSessionId === params.sessionId) executionContextSessions.delete(contextId);
      }
      return;
    }

    if (!sessionId) return;
    const frameId = params.frame?.id || params.frameId || params.executionContextAuxData?.frameId || params.context?.auxData?.frameId;
    if (frameId) frameSessions.set(frameId, sessionId);

    const contextId = params.executionContextId || params.context?.id;
    if (contextId != null) executionContextSessions.set(contextId, sessionId);
  }

  function indexResult(method, result, sessionId) {
    if (!sessionId || method !== "Page.getFrameTree") return;

    function visit(frameTree) {
      if (!frameTree) return;
      if (frameTree.frame?.id) frameSessions.set(frameTree.frame.id, sessionId);
      for (const child of frameTree.childFrames || []) visit(child);
    }

    visit(result?.frameTree);
  }

  async function resolveSessionId(params = {}) {
    if (params.sessionId) return params.sessionId;
    if (params.targetId) return targetSessions.get(params.targetId) || attachTarget(params.targetId);
    if (params.frameId && frameSessions.has(params.frameId)) return frameSessions.get(params.frameId);
    if (params.executionContextId != null && executionContextSessions.has(params.executionContextId)) {
      return executionContextSessions.get(params.executionContextId);
    }
    if (params.contextId != null && executionContextSessions.has(params.contextId)) {
      return executionContextSessions.get(params.contextId);
    }
    return null;
  }

  return {
    indexEvent,
    indexResult,
    resolveSessionId,
    targetSessions,
    frameSessions,
    executionContextSessions,
  };
}

export class RawCDP extends EventEmitter {
  constructor(wsUrl) {
    super();
    if (typeof WebSocket === "undefined") {
      throw new Error("MagicCDP requires a runtime with a global WebSocket implementation.");
    }
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener("message", event => this.handleMessage(JSON.parse(event.data)));
    this.ws.addEventListener("close", () => this.rejectAll(new Error("CDP websocket closed")));
    this.ws.addEventListener("error", () => this.rejectAll(new Error("CDP websocket error")));

    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });

    await this.send("Target.setAutoAttach", targetAutoAttachParams);

    return this;
  }

  handleMessage(message) {
    if (message.method) {
      this.emit(message.method, message.params || {}, message.sessionId || null, message);
      this.emit("*", message);
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);

    if (message.error) {
      const error = new Error(`${pending.method} failed: ${message.error.message}`);
      error.cdp = message.error;
      pending.reject(error);
      return;
    }

    pending.resolve(message.result || {});
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  send(method, params = {}, sessionId = null) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;

    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
    this.ws.send(JSON.stringify(message));
    return promise;
  }

  close() {
    this.ws?.close();
  }
}

export class MagicCDP {
  constructor(options = {}) {
    const serverOptions = options.server || {};
    this.options = options;
    this.directCdpUrl = options.direct_cdp_url || options.cdp_url || null;
    this.extensionPath = options.extensionPath || defaultExtensionDir;
    this.executablePath = options.executablePath || defaultChromePath;
    this.launchFlags = options.launchFlags || [];
    this.routes = {
      "Magic.*": "service_worker",
      "Custom.*": "service_worker",
      "*.*": "direct_cdp",
      ...(options.routes || {}),
    };
    this.server = {
      loopback_cdp_url: Object.prototype.hasOwnProperty.call(serverOptions, "loopback_cdp_url")
        ? serverOptions.loopback_cdp_url
        : null,
      routes: serverOptions.routes || null,
    };
    this._serverRoutesExplicit = Object.prototype.hasOwnProperty.call(serverOptions, "routes");
    this._serverLoopbackExplicit = Object.prototype.hasOwnProperty.call(serverOptions, "loopback_cdp_url");

    this.sessionId = options.sessionId || randomUUID();
    this._browserToken = randomUUID();
    this.types = createTypesProxy();
    this._events = new EventEmitter();
    this._cdp = null;
    this._httpOrigin = null;
    this._extTargetId = null;
    this._extCdpSessionId = null;
    this._extensionId = options.extensionId || null;
    this._customCommands = new Map();
    this._customEvents = new Map();
    this._sessionRouting = options.sessionRouting || options.session_routing || false;
    this._sessionRouter = null;
    this._launched = null;
    this.lastPingTs = null;
    this.latency = null;
  }

  get cdp() {
    return this._cdp;
  }

  async connect() {
    if (!this.directCdpUrl) await this.launchBrowser();

    const endpoint = await resolveCdpEndpoint(this.directCdpUrl);
    this._httpOrigin = endpoint.httpOrigin;
    this._cdp = await new RawCDP(endpoint.wsUrl).connect();
    if (this._sessionRouting) this._sessionRouter = createSessionRouter(this._cdp);
    this._cdp.on("*", message => this.handleCdpEvent(message));

    await this.ensureExtensionLoaded();
    await this.attachToExtensionWorker();
    await this.bootstrap();
    return this;
  }

  async launchBrowser() {
    const port = await freePort();
    const profile = await mkdtemp(path.join(tmpdir(), "magic-cdp."));
    const process = spawn(this.executablePath, [
      ...defaultChromeFlags,
      ...this.launchFlags,
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "about:blank",
    ], { stdio: "ignore" });
    process.unref();

    this._launched = { process, profile };
    this.directCdpUrl = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
      const response = await fetch(`${this.directCdpUrl}/json/version`);
      return response.ok ? response.json() : null;
    }, {
      timeoutMs: 15_000,
      label: "launched browser CDP endpoint",
    });
  }

  async ensureExtensionLoaded() {
    try {
      const result = await this._cdp.send("Extensions.loadUnpacked", { path: this.extensionPath });
      this._extensionId = result.id || result.extensionId || null;
    } catch (error) {
      throw new Error(
        `Unable to load MagicCDP extension with Extensions.loadUnpacked. ` +
        `Launch Chromium or Chrome Canary with --enable-unsafe-extension-debugging and connect over the browser CDP endpoint. ` +
        `Original error: ${error.message}`,
      );
    }

    if (!this._extensionId) throw new Error("Extensions.loadUnpacked did not return an extension id.");
  }

  async attachToExtensionWorker() {
    const worker = await waitFor(async () => {
      const { targetInfos } = await this._cdp.send("Target.getTargets");
      return targetInfos.find(target =>
        target.type === "service_worker"
        && target.url === `chrome-extension://${this._extensionId}${workerSuffix}`
      );
    }, {
      timeoutMs: 10_000,
      label: "MagicCDP extension service worker target",
    });

    this._extTargetId = worker.targetId;
    const attached = await this._cdp.send("Target.attachToTarget", {
      targetId: worker.targetId,
      flatten: true,
    });
    this._extCdpSessionId = attached.sessionId;
    await this._cdp.send("Runtime.enable", {}, this._extCdpSessionId);
    await waitFor(() => this.evaluateInExtension("Boolean(globalThis.MagicCDP?.configure)").catch(() => false), {
      timeoutMs: 5_000,
      label: "MagicCDP service worker bootstrap",
    });
  }

  async bootstrap() {
    const serverConfig = {
      browserToken: this._browserToken,
    };
    if (this._serverLoopbackExplicit) serverConfig.loopback_cdp_url = this.server.loopback_cdp_url;
    else if (this._serverRoutesExplicit) serverConfig.loopback_cdp_url = this._httpOrigin;
    if (this._serverRoutesExplicit) serverConfig.routes = this.server.routes;

    await this.evaluateInExtension(`
      globalThis.MagicCDP.configure(${JSON.stringify(serverConfig)})
    `);

    await this.send("Magic.addCustomEvent", {
      name: "Magic.pong",
      payloadSchema: { type: "object" },
    });

    let onPong;
    const pong = new Promise(resolve => {
      onPong = resolve;
      this.on("Magic.pong", onPong);
    });
    try {
      this.lastPingTs = Date.now();
      await this.send("Magic.ping", { sentAt: this.lastPingTs });
      await pong;
    } finally {
      this.off("Magic.pong", onPong);
    }
  }

  async send(method, params = {}, options = {}) {
    let sessionId = typeof options === "string" ? options : options.sessionId;

    if (method === "Magic.evaluate") return this.magicEvaluate(params);
    if (method === "Magic.addCustomCommand") return this.addCustomCommand(params);
    if (method === "Magic.addCustomEvent") return this.addCustomEvent(params);

    const upstream = routeFor(method, this.routes);
    if (upstream === "direct_cdp") {
      if (!sessionId) sessionId = await this._sessionRouter?.resolveSessionId(params);
      const result = await this._cdp.send(method, params, sessionId);
      this._sessionRouter?.indexResult(method, result, sessionId);
      return result;
    }
    if (upstream === "service_worker") return this.sendToServiceWorker(method, params);

    throw new Error(`Unsupported client route "${upstream}" for ${method}`);
  }

  on(eventName, listener) {
    this._events.on(eventName, listener);
    return this;
  }

  once(eventName, listener) {
    this._events.once(eventName, listener);
    return this;
  }

  off(eventName, listener) {
    this._events.off(eventName, listener);
    return this;
  }

  async magicEvaluate({ expression, params = {}, cdpSessionId = this.sessionId } = {}) {
    if (!expression) throw new Error("Magic.evaluate requires an expression string.");

    const runtimeExpression = `
      (async () => {
        const params = ${JSON.stringify(params)};
        const cdp = globalThis.MagicCDP.attachToSession(${JSON.stringify(cdpSessionId)});
        const context = { cdp, MagicCDP: globalThis.MagicCDP, Magic: globalThis.Magic, chrome: globalThis.chrome };
        const value = (${expression});
        return typeof value === "function" ? await value(params, context) : value;
      })()
    `;
    return this.evaluateInExtension(runtimeExpression);
  }

  async addCustomCommand({ name, paramsSchema = null, resultSchema = null, expression } = {}) {
    if (!name || !name.includes(".")) {
      throw new Error("Magic.addCustomCommand requires name in Domain.method form.");
    }
    if (!expression) throw new Error("Magic.addCustomCommand requires an expression string.");

    this._customCommands.set(name, { paramsSchema, resultSchema, expression });
    const runtimeExpression = `
      (() => {
        const name = ${JSON.stringify(name)};
        const expression = ${JSON.stringify(expression)};
        const handler = (${expression});
        if (typeof handler !== "function") {
          throw new Error("Custom command expression must evaluate to a function.");
        }
        return globalThis.MagicCDP.addCustomCommand({
          name,
          paramsSchema: ${JSON.stringify(paramsSchema)},
          resultSchema: ${JSON.stringify(resultSchema)},
          expression,
          handler: async (params, meta = {}) => {
            const cdp = globalThis.MagicCDP.attachToSession(meta.cdpSessionId);
            const context = { cdp, MagicCDP: globalThis.MagicCDP, Magic: globalThis.Magic, chrome: globalThis.chrome, meta };
            return await handler(params || {}, context);
          },
        });
      })()
    `;

    return this.evaluateInExtension(runtimeExpression);
  }

  async addCustomEvent({ name, payloadSchema = null } = {}) {
    if (!name || !name.includes(".")) {
      throw new Error("Magic.addCustomEvent requires name in Domain.event form.");
    }

    const bindingName = `__MagicCDP_${name.replaceAll(".", "_")}`;
    this._customEvents.set(name, { payloadSchema, bindingName });
    await this._cdp.send("Runtime.addBinding", { name: bindingName }, this._extCdpSessionId);

    return this.evaluateInExtension(`
      globalThis.MagicCDP.addCustomEvent({
        name: ${JSON.stringify(name)},
        bindingName: ${JSON.stringify(bindingName)},
        payloadSchema: ${JSON.stringify(payloadSchema)},
      })
    `);
  }

  async sendToServiceWorker(method, params = {}) {
    return this.evaluateInExtension(`
      globalThis.MagicCDP.handleCommand(
        ${JSON.stringify(method)},
        ${JSON.stringify(params)},
        ${JSON.stringify({ cdpSessionId: this.sessionId })}
      )
    `);
  }

  async evaluateInExtension(expression) {
    const response = await this._cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true,
    }, this._extCdpSessionId);

    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description
          || response.exceptionDetails.text
          || "Runtime.evaluate failed",
      );
    }
    return response.result?.value;
  }

  handleCdpEvent(message) {
    this._sessionRouter?.indexEvent(message);

    if (message.sessionId === this._extCdpSessionId && message.method === "Runtime.bindingCalled") {
      this.handleMagicBinding(message.params);
      return;
    }

    if (message.method) this._events.emit(message.method, message.params || {}, message.sessionId || null, message);
  }

  handleMagicBinding(params) {
    const event = [...this._customEvents.entries()]
      .find(([_eventName, config]) => config.bindingName === params.name)?.[0];
    if (!event) return;

    const payload = JSON.parse(params.payload || "{}");
    if (payload.cdpSessionId && payload.cdpSessionId !== this.sessionId) return;

    const data = Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
    if (event === "Magic.pong") this.latency = Date.now() - this.lastPingTs;
    this._events.emit(event, data);
  }

  async close() {
    await this.disconnect();

    if (this._launched) {
      this._launched.process.kill();
      await rm(this._launched.profile, { recursive: true, force: true });
    }
  }

  async disconnect() {
    if (this._extCdpSessionId) {
      await this._cdp?.send("Target.detachFromTarget", { sessionId: this._extCdpSessionId }).catch(() => {});
    }
    this._cdp?.close();
  }
}

export function MagicCDPClient(options = {}) {
  return new MagicCDP(options);
}

async function demo() {
  const argv = process.argv.slice(2);
  const mode = argv.includes("--debugger") ? "debugger" : argv.includes("--loopback") ? "loopback" : "direct";
  const sessionRouting = argv.includes("--session-routing");
  const executablePath = argv.find(arg => !arg.startsWith("--")) || defaultChromePath;
  const cdp = MagicCDPClient({
    executablePath,
    sessionRouting,
    launchFlags: sessionRouting
      ? [
        "--site-per-process",
        "--host-resolver-rules=MAP magic-a.test 127.0.0.1,MAP magic-b.test 127.0.0.1",
      ]
      : [],
    routes: {
      "Magic.*": "service_worker",
      "Custom.*": "service_worker",
      "*.*": mode === "direct" ? "direct_cdp" : "service_worker",
    },
    server: {
      routes: {
        "Magic.*": "service_worker",
        "Custom.*": "service_worker",
        "*.*": mode === "loopback" ? "loopback_cdp" : "chrome_debugger",
      },
    },
  });
  let connected = false;

  try {
    await cdp.connect();
    connected = true;
    console.log({ mode, sessionRouting });
    console.log(await cdp.cdp.send("Browser.getVersion"));
    cdp.on("Magic.pong", event => console.log("Magic.pong", event));
    cdp.lastPingTs = Date.now();
    console.log("Magic.ping", await cdp.send("Magic.ping", { sentAt: cdp.lastPingTs }));
    console.log(await cdp.send("Magic.evaluate", {
      expression: "async () => ({ extensionId: chrome.runtime.id, serviceWorkerUrl: chrome.runtime.getURL('service_worker.js') })",
    }));

    await cdp.send("Magic.addCustomEvent", { name: "Custom.demo" });
    cdp.on("Custom.demo", event => console.log("Custom.demo", event));
    await cdp.send("Magic.addCustomCommand", {
      name: "Custom.echo",
      expression: "async (params, { cdp }) => { await cdp.emit('Custom.demo', { echo: params.value }); return { echo: params.value }; }",
    });
    console.log(await cdp.send("Custom.echo", { value: "test" }));
    console.log({ latency: cdp.latency });

    await setupForegroundTargetChangedDemo(cdp);
    if (sessionRouting && mode === "direct") await runSessionRoutingDemo(cdp);
    await runCommandPrompt(cdp, mode, sessionRouting);
  } catch (error) {
    if (!connected) await cdp.close().catch(() => {});
    throw error;
  }
}

async function setupForegroundTargetChangedDemo(cdp) {
  await cdp.send("Magic.addCustomEvent", {
    name: "Custom.foregroundTargetChanged",
    payloadSchema: {
      type: "object",
      properties: {
        targetId: { type: ["string", "null"] },
        tabId: { type: ["number", "null"] },
        url: { type: ["string", "null"] },
      },
    },
  });

  let sawFirstForegroundEvent = false;
  let resolveFirstForegroundEvent;
  const firstForegroundEvent = new Promise(resolve => {
    resolveFirstForegroundEvent = resolve;
  });
  cdp.on("Custom.foregroundTargetChanged", event => {
    console.log("Custom.foregroundTargetChanged", event);
    if (!sawFirstForegroundEvent) {
      sawFirstForegroundEvent = true;
      resolveFirstForegroundEvent(event);
    }
  });

  await cdp.send("Magic.evaluate", {
    expression: `async ({ cdpSessionId, cdpHttpOrigin }) => {
      const cdp = MagicCDP.attachToSession(cdpSessionId)

      async function foregroundPayload(activeInfo = null) {
        const [tab = null] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
        let target = null
        try {
          const targets = await fetch(cdpHttpOrigin + '/json/list').then(response => response.json())
          target = targets.find(target => target.type === 'page' && tab?.url != null && target.url === tab.url)
            ?? targets.find(target => target.type === 'page')
            ?? null
        } catch {}

        return {
          targetId: target?.id ?? null,
          tabId: activeInfo?.tabId ?? tab?.id ?? null,
          url: tab?.url ?? target?.url ?? null,
        }
      }

      async function emitForegroundTargetChanged(activeInfo = null) {
        const payload = await foregroundPayload(activeInfo)
        const key = payload.targetId ?? payload.tabId ?? payload.url
        if (key != null && key === globalThis.__MagicCDPLastForegroundTargetKey) return
        globalThis.__MagicCDPLastForegroundTargetKey = key
        await cdp.emit('Custom.foregroundTargetChanged', payload)
      }

      if (!globalThis.__MagicCDPForegroundTargetChangedInstalled) {
        globalThis.__MagicCDPForegroundTargetChangedInstalled = true
        chrome.tabs.onActivated.addListener(async (activeInfo) => {
          await emitForegroundTargetChanged(activeInfo)
        })
        chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
          if (changeInfo.status === 'complete' && tab.active) {
            await emitForegroundTargetChanged({ tabId })
          }
        })
      }

      await emitForegroundTargetChanged()
      return { installed: true }
    }`,
    params: {
      cdpHttpOrigin: cdp._httpOrigin,
      cdpSessionId: cdp.sessionId,
    },
  });

  await firstForegroundEvent;
}

async function runSessionRoutingDemo(cdp) {
  console.log("");
  console.log("Session routing demo: target-scoped commands without sessionId");

  const tabA = await cdp.send("Target.createTarget", { url: "https://example.com" });
  const tabB = await cdp.send("Target.createTarget", { url: "https://example.org" });
  await waitFor(() => cdp._sessionRouter?.targetSessions.has(tabA.targetId), {
    label: "session for example.com target",
  });
  await waitFor(() => cdp._sessionRouter?.targetSessions.has(tabB.targetId), {
    label: "session for example.org target",
  });
  await waitFor(async () => {
    const result = await cdp.send("Runtime.evaluate", {
      targetId: tabA.targetId,
      expression: "location.href",
      returnByValue: true,
    });
    return result.result.value === "https://example.com/";
  }, {
    label: "example.com navigation",
  });
  await waitFor(async () => {
    const result = await cdp.send("Runtime.evaluate", {
      targetId: tabB.targetId,
      expression: "location.href",
      returnByValue: true,
    });
    return result.result.value === "https://example.org/";
  }, {
    label: "example.org navigation",
  });

  const hrefA = await cdp.send("Runtime.evaluate", {
    targetId: tabA.targetId,
    expression: "location.href",
    returnByValue: true,
  });
  const hrefB = await cdp.send("Runtime.evaluate", {
    targetId: tabB.targetId,
    expression: "location.href",
    returnByValue: true,
  });
  console.log("two tabs, no sessionId", {
    [tabA.targetId]: hrefA.result.value,
    [tabB.targetId]: hrefB.result.value,
  });

  const webPort = await freePort();
  const server = http.createServer((request, response) => {
    if (request.headers.host?.startsWith("magic-a.test")) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><title>Magic A</title><iframe src="http://magic-b.test:${webPort}/child"></iframe>`);
      return;
    }

    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>Magic B</title><script>globalThis.magicOopifMarker = 'inside-oopif'</script>`);
  });
  server.on("connection", socket => socket.unref());

  await new Promise(resolve => server.listen(webPort, "127.0.0.1", resolve));
  try {
    const root = await cdp.send("Target.createTarget", { url: `http://magic-a.test:${webPort}/` });
    await waitFor(() => cdp._sessionRouter?.targetSessions.has(root.targetId), {
      label: "session for OOPIF root target",
    });
    const iframe = await waitFor(async () => {
      const { targetInfos } = await cdp.send("Target.getTargets");
      return targetInfos.find(target => target.type === "iframe" && target.url.includes("magic-b.test"));
    }, {
      timeoutMs: 10_000,
      label: "OOPIF target",
    });

    const oopif = await cdp.send("Runtime.evaluate", {
      targetId: iframe.targetId,
      expression: "location.href + ' ' + globalThis.magicOopifMarker",
      returnByValue: true,
    });
    console.log("OOPIF, no sessionId", {
      rootTargetId: root.targetId,
      iframeTargetId: iframe.targetId,
      value: oopif.result.value,
    });
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

async function runCommandPrompt(cdp, mode, sessionRouting) {
  console.log("");
  console.log(`Browser remains running. Events will print in realtime. Mode: ${mode}.`);
  if (sessionRouting) console.log("Session routing is enabled: targetId/frameId/executionContextId params can infer the CDP session.");
  console.log("Enter commands as Domain.method({param: 'value'}), e.g. Browser.getVersion({})");
  console.log("Example: Magic.evaluate({expression: 'chrome.tabs.query({active: true})'})");
  if (mode === "debugger") console.log("Debugger mode defaults to the active tab unless debuggee/tabId/targetId/extensionId is passed.");
  console.log('Use exit or quit to disconnect this client without killing the browser.');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const line = (await rl.question("MagicCDP> ")).trim();
      if (line.length === 0) continue;
      if (line === "exit" || line === "quit") break;

      try {
        const { method, params } = parsePromptCommand(line);
        const result = await cdp.send(method, params);
        console.log(JSON.stringify(result, null, 2));
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
    }
  } finally {
    rl.close();
    await cdp.disconnect();
    console.log("Disconnected from CDP. Browser was left running.");
  }
}

function parsePromptCommand(line) {
  const match = line.match(/^([A-Za-z_][\w]*\.[A-Za-z_][\w]*)(?:\(([\s\S]*)\))?$/);
  if (!match) {
    throw new Error('Expected command format: Domain.method({"param":"value"})');
  }

  const [, method, rawParams = ""] = match;
  const trimmedParams = rawParams.trim();
  if (trimmedParams.length === 0) return { method, params: {} };

  const params = Function(`"use strict"; return (${trimmedParams});`)();
  if (params == null) return { method, params: {} };
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Command params must be an object.");
  }
  return { method, params };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  demo().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
