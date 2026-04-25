import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(rootDir, "extension");
const chromePath = process.argv[2] || path.join(process.env.HOME, "Library/Application Support/bb/lib/puppeteer/bin/chromium");
const workerSuffix = "/service_worker.js";
const bindingName = "__bbCustomEvent";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

async function getJson(url) {
  while (true) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {}
    await sleep(50);
  }
}

class Cdp extends EventEmitter {
  constructor(wsUrl) {
    super();
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.addEventListener("message", event => this.handleMessage(JSON.parse(event.data)));
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  handleMessage(message) {
    if (message.method) this.emit(message.method, message.params || {});
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    pending.resolve(message.result || {});
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
  }

  close() {
    this.ws.close();
  }
}

class Browser extends EventEmitter {
  constructor(executablePath = chromePath) {
    super();
    this.executablePath = executablePath;
    this.port = null;
    this.profile = null;
    this.process = null;
    this.cdp = null;
    this.workerCdp = null;
    this.customSubscriptions = new Map();
  }

  get http() {
    return `http://localhost:${this.port}`;
  }

  async launch() {
    this.port = await freePort();
    this.profile = await mkdtemp(path.join(tmpdir(), "cdp-extension-demo."));
    this.process = spawn(this.executablePath, [
      `--user-data-dir=${this.profile}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${this.port}`,
      "--remote-allow-origins=*",
      `--load-extension=${extensionDir}`,
      `--disable-extensions-except=${extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ], { stdio: "ignore" });

    const version = await getJson(`${this.http}/json/version`);
    this.cdp = new Cdp(version.webSocketDebuggerUrl);
    await this.cdp.open();

    const worker = await this.findWorker();
    this.workerCdp = new Cdp(worker.webSocketDebuggerUrl);
    this.workerCdp.on("Runtime.bindingCalled", event => this.handleCustomEvent(event));
    await this.workerCdp.open();
    await this.workerCdp.send("Runtime.enable");
    await this.workerCdp.send("Runtime.addBinding", { name: bindingName });
  }

  async findWorker() {
    while (true) {
      const targets = await getJson(`${this.http}/json/list`);
      const worker = targets.find(target => target.type === "service_worker" && target.url.endsWith(workerSuffix));
      if (worker) return worker;
      await sleep(100);
    }
  }

  async findPage() {
    while (true) {
      const targets = await getJson(`${this.http}/json/list`);
      const page = targets.find(target => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
      await sleep(100);
    }
  }

  async custom(name, params = {}) {
    const expression = `globalThis.Custom.${name}(${JSON.stringify({ ...params, cdpHttpOrigin: this.http })})`;
    const response = await this.workerCdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return response.result.value;
  }

  handleCustomEvent(event) {
    if (event.name !== bindingName) return;
    const payload = JSON.parse(event.payload);
    this.emit(payload.event, payload.data);
  }

  on(eventName, listener) {
    if (eventName.includes(".")) {
      this.cdp.on(eventName, listener);
      return this;
    }

    super.on(eventName, listener);
    if (!this.customSubscriptions.has(eventName)) {
      this.customSubscriptions.set(eventName, this.custom("on", { eventName }));
    }
    return this;
  }

  ping(value) {
    return this.custom("ping", { value });
  }

  async firecustomevent(data) {
    await this.customSubscriptions.get("customevent");
    return this.custom("firecustomevent", { data });
  }

  async close() {
    this.workerCdp?.close();
    this.cdp?.close();
    this.process?.kill();
    if (this.profile) await rm(this.profile, { recursive: true, force: true });
  }
}

const browser = new Browser();
const latencyMs = {};

async function timed(name, fn) {
  const start = performance.now();
  const value = await fn();
  latencyMs[name] = Number((performance.now() - start).toFixed(3));
  return value;
}

try {
  const setupStart = performance.now();
  await browser.launch();
  const firstVersion = await browser.cdp.send("Browser.getVersion");
  latencyMs.launchToFirstBrowserGetVersion = Number((performance.now() - setupStart).toFixed(3));

  const warmedVersion = await timed("normalBrowserGetVersionRoundTrip", () => browser.cdp.send("Browser.getVersion"));
  await browser.cdp.send("Target.setDiscoverTargets", { discover: true });

  const customPing = await timed("smuggledCustomPingRoundTrip", () => browser.ping("test"));

  const normalEvent = await timed("normalOnSubscribeTriggerEvent", async () => {
    const page = await browser.findPage();
    const browserEventPromise = new Promise(resolve => {
      browser.on("Target.attachedToTarget", event => {
        if (event.targetInfo.targetId === page.id) resolve(event);
      });
    });
    const cdpEventPromise = new Promise(resolve => {
      browser.cdp.on("Target.attachedToTarget", event => {
        if (event.targetInfo.targetId === page.id) resolve(event);
      });
    });
    const attachPromise = browser.cdp.send("Target.attachToTarget", { targetId: page.id, flatten: true });
    const [browserOn, cdpOn] = await Promise.all([browserEventPromise, cdpEventPromise]);
    attachPromise.then(response => {
      browser.cdp.send("Target.detachFromTarget", { sessionId: response.sessionId });
    });
    return { browserOn, cdpOn };
  });

  const customEvent = await timed("smuggledCustomOnSubscribeTriggerEvent", async () => {
    const eventPromise = new Promise(resolve => browser.on("customevent", resolve));
    await browser.firecustomevent("test");
    return eventPromise;
  });

  console.log("first Browser.getVersion", firstVersion);
  console.log("warmed Browser.getVersion", warmedVersion);
  console.log("browser.ping result", customPing);
  console.log("browser.on Target.attachedToTarget result", normalEvent.browserOn);
  console.log("browser.cdp.on Target.attachedToTarget result", normalEvent.cdpOn);
  console.log("browser.on customevent result", customEvent);
  console.log("latencyMs", latencyMs);
} finally {
  await browser.close();
}
