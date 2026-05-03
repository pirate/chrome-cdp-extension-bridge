// @ts-nocheck
// MagicCDPClient (JS): importable, no CLI, no demo code.
//
// Constructor parameter names match across JS / Python / Go ports:
//   cdp_url           upstream CDP URL (string, default null -> try localhost:9222,
//                       then autolaunch)
//   extension_path    extension directory (string, default ../../extension)
//   routes            client-side routing dict (default { "Magic.*": "service_worker",
//                       "Custom.*": "service_worker", "*.*": "direct_cdp" })
//   server            { loopback_cdp_url?, routes? } passed to MagicCDPServer.configure
//   launch_options    forwarded to launcher.launchChrome when autolaunching
//
// Public methods: connect, send(method, params), on(event, handler), close.

// oxlint-disable typescript-eslint/no-unsafe-declaration-merging -- alias members are assigned in the constructor.
import type { z } from "zod";

import { createCdpAliases } from "../../types/aliases.js";
import type { CdpAliases } from "../../types/aliases.js";
import {
  bindingNameFor,
  DEFAULT_CLIENT_ROUTES,
  wrapCommandIfNeeded,
  unwrapResponseIfNeeded,
  unwrapEventIfNeeded,
} from "../../bridge/translate.js";
import type {
  CdpCommandFrame,
  CdpError,
  CdpEventFrame,
  CdpResponseFrame,
  MagicConfigureParams,
  MagicPingLatency,
  MagicPongEvent,
  MagicRoutes,
  ProtocolParams,
  ProtocolResult,
  TranslatedCommand,
} from "../../types/magic.js";
import { CdpEventFrameSchema, CdpResponseFrameSchema, Magic, normalizeMagicName } from "../../types/magic.js";
import { events } from "../../types/zod.js";

const DEFAULT_LIVE_CDP_URL = "http://127.0.0.1:9222";
const LOCAL_CDP_URL_RE = /^(https?|wss?):\/\/(127\.0\.0\.1|localhost)(?::|\/|$)/iu;
const DEFAULT_EXTENSION_PATH = import.meta.url.startsWith("file:")
  ? decodeURIComponent(new URL("../../extension", import.meta.url).pathname)
  : null;

type Listener = (...args: unknown[]) => void;
class MagicCDPEventEmitter {
  _listeners = new Map<string | symbol, Set<Listener>>();

  on(eventName: string | symbol, listener: Listener) {
    let listeners = this._listeners.get(eventName);
    if (!listeners) {
      listeners = new Set();
      this._listeners.set(eventName, listeners);
    }
    listeners.add(listener);
    return this;
  }

  once(eventName: string | symbol, listener: Listener) {
    const wrapped = (...args: unknown[]) => {
      this.off(eventName, wrapped);
      listener(...args);
    };
    return this.on(eventName, wrapped);
  }

  off(eventName: string | symbol, listener: Listener) {
    this._listeners.get(eventName)?.delete(listener);
    return this;
  }

  emit(eventName: string | symbol, ...args: unknown[]) {
    const listeners = this._listeners.get(eventName);
    if (!listeners) return false;
    for (const listener of [...listeners]) listener(...args);
    return true;
  }
}

type LaunchOptions = Record<string, unknown>;
type LaunchedChrome = { wsUrl: string; close: () => unknown | Promise<unknown> };

async function loadNodeLauncher() {
  const launcherUrl = new URL("../../bridge/launcher.js", import.meta.url).href;
  return import(launcherUrl) as Promise<{
    launchChrome: (options?: LaunchOptions) => Promise<LaunchedChrome>;
  }>;
}

async function loadInjector() {
  const injectorUrl = new URL("../../bridge/injector.js", import.meta.url).href;
  return import(injectorUrl) as Promise<{
    injectExtensionIfNeeded: (options: {
      send: (method: string, params?: ProtocolParams, sessionId?: string | null) => Promise<ProtocolResult>;
      extensionPath?: string | null;
      timeoutMs?: number;
      discoveryWaitMs?: number;
    }) => Promise<{
      source: string;
      extensionId?: string | null;
      targetId: string;
      url: string;
      sessionId: string;
    }>;
  }>;
}

function makeBrowserToken() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function messageText(data: unknown) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data && typeof (data as Blob).text === "function") return (data as Blob).text();
  return String(data);
}

type PendingCommand = {
  method: string;
  resolve: (value: ProtocolResult) => void;
  reject: (error: Error) => void;
};
type ClientOptions = {
  cdp_url?: string | null;
  extension_path?: string | null;
  routes?: MagicRoutes;
  server?: MagicConfigureParams | null;
  launch_options?: LaunchOptions;
};

export type MagicCDPCommandSpec<Params = unknown, Result = unknown> = {
  params: Params;
  result: Result;
};
export type MagicCDPCommandMap = Record<string, MagicCDPCommandSpec>;
type MethodName<TName extends string> = TName extends `${string}.${infer TMethod}` ? TMethod : never;
type DomainName<TName extends string> = TName extends `${infer TDomain}.${string}` ? TDomain : never;
type CommandsForDomain<TCommands extends MagicCDPCommandMap, TDomain extends string> = {
  [TName in keyof TCommands as TName extends `${TDomain}.${string}`
    ? MethodName<Extract<TName, string>>
    : never]: undefined extends TCommands[TName]["params"]
    ? (params?: TCommands[TName]["params"]) => Promise<TCommands[TName]["result"]>
    : (params: TCommands[TName]["params"]) => Promise<TCommands[TName]["result"]>;
};
export type MagicCDPClientInstance<TCommands extends MagicCDPCommandMap = Record<never, never>> = MagicCDPClient & {
  [TDomain in DomainName<Extract<keyof TCommands, string>>]: CommandsForDomain<TCommands, TDomain>;
};

function defineCustomCommandMethod(client: MagicCDPClient, name: string) {
  const [domain, method] = name.split(".", 2);
  if (!domain || !method) throw new Error(`Custom command must use Domain.method format, got ${name}`);
  const target = client as unknown as Record<string, Record<string, unknown>>;
  target[domain] ??= {};
  const alias = (params?: unknown) => client.send(name, params ?? {});
  Object.defineProperties(alias, {
    id: { value: name, enumerable: true, configurable: true },
    name: { value: name, configurable: true },
    kind: { value: "command", enumerable: true, configurable: true },
    meta: { value: () => ({ id: name, name, kind: "command" }), configurable: true },
  });
  target[domain][method] = alias;
}

async function webSocketUrlFor(endpoint: string, name = "cdp_url") {
  if (/^wss?:\/\//i.test(endpoint)) return endpoint;
  const response = await fetch(`${endpoint}/json/version`);
  if (!response.ok) {
    if (response.status === 404) {
      const url = new URL(endpoint);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = "/devtools/browser";
      url.search = "";
      url.hash = "";
      return url.toString();
    }
    throw new Error(`GET ${endpoint}/json/version -> ${response.status}`);
  }
  const { webSocketDebuggerUrl } = await response.json();
  if (!webSocketDebuggerUrl) throw new Error(`${name} HTTP discovery returned no webSocketDebuggerUrl`);
  return webSocketDebuggerUrl;
}

async function liveWebSocketUrlFor(endpoint = DEFAULT_LIVE_CDP_URL) {
  try {
    return await webSocketUrlFor(endpoint, "live_cdp_url");
  } catch {
    return null;
  }
}

export class MagicCDPClient extends MagicCDPEventEmitter {
  cdp_url: string | null;
  extension_path: string | null;
  routes: MagicRoutes;
  server: MagicConfigureParams | null;
  launch_options: LaunchOptions;
  ws: WebSocket | null;
  next_id: number;
  pending: Map<number, PendingCommand>;
  ext_session_id: string | null;
  ext_target_id: string | null;
  extension_id: string | null;
  latency: MagicPingLatency | null;
  event_schemas: Map<string, z.ZodType>;
  command_params_schemas: Map<string, z.ZodType>;
  command_result_schemas: Map<string, z.ZodType>;
  _cdp: {
    send: (method: string, params?: ProtocolParams, sessionId?: string | null) => Promise<ProtocolResult>;
    on: (eventName: string | symbol, listener: (...args: unknown[]) => void) => MagicCDPClient;
    once: (eventName: string | symbol, listener: (...args: unknown[]) => void) => MagicCDPClient;
  };
  _launched: LaunchedChrome | null;

  constructor({
    cdp_url = null,
    extension_path = DEFAULT_EXTENSION_PATH,
    routes = DEFAULT_CLIENT_ROUTES,
    server = {},
    launch_options = {},
  }: ClientOptions = {}) {
    super();
    this.cdp_url = cdp_url;
    this.extension_path = extension_path;
    this.routes = { ...DEFAULT_CLIENT_ROUTES, ...routes };
    this.server = server;
    this.launch_options = launch_options;

    this.ws = null;
    this.next_id = 1;
    this.pending = new Map();
    this.ext_session_id = null;
    this.ext_target_id = null;
    this.extension_id = null;
    this.latency = null;
    this.event_schemas = new Map();
    this.command_params_schemas = new Map();
    this.command_result_schemas = new Map();
    this._launched = null;

    Object.assign(
      this,
      createCdpAliases((method, params) => this.send(method, params), {
        onCustomCommand: (name, paramsSchema, resultSchema) => {
          if (paramsSchema) this.command_params_schemas.set(name, paramsSchema);
          if (resultSchema) this.command_result_schemas.set(name, resultSchema);
          defineCustomCommandMethod(this, name);
        },
        onCustomEvent: (name, eventSchema) => {
          if (eventSchema) this.event_schemas.set(name, eventSchema);
        },
      }),
    );
    this._cdp = {
      send: (method: string, params: ProtocolParams = {}, sessionId: string | null = null) =>
        this._sendFrame(method, params, sessionId),
      on: (eventName: string | symbol, listener: (...args: unknown[]) => void) =>
        MagicCDPEventEmitter.prototype.on.call(this, eventName, listener) as this,
      once: (eventName: string | symbol, listener: (...args: unknown[]) => void) =>
        MagicCDPEventEmitter.prototype.once.call(this, eventName, listener) as this,
    };
  }

  async connect() {
    if (!this.cdp_url) {
      this.cdp_url = await liveWebSocketUrlFor();
      if (!this.cdp_url) {
        if (!import.meta.url.startsWith("file:")) {
          throw new Error("MagicCDPClient requires cdp_url when running in a browser; autolaunch is Node-only.");
        }
        const { launchChrome } = await loadNodeLauncher();
        this._launched = await launchChrome(this.launch_options);
        this.cdp_url = this._launched.wsUrl;
      }
    }
    const inputCdpUrl = this.cdp_url;
    this.cdp_url = await webSocketUrlFor(this.cdp_url);
    if (this.server !== null && Object.hasOwn(this.server, "loopback_cdp_url") && this.server?.loopback_cdp_url) {
      const loopbackUrl = this.server.loopback_cdp_url;
      if (loopbackUrl === inputCdpUrl || loopbackUrl === this.cdp_url) {
        this.server = { ...this.server, loopback_cdp_url: this.cdp_url };
      }
    } else if (this.server !== null && LOCAL_CDP_URL_RE.test(this.cdp_url)) {
      this.server = { ...this.server, loopback_cdp_url: this.cdp_url };
    }
    if (this.server !== null && !this.server.browserToken) this.server = { ...this.server, browserToken: makeBrowserToken() };

    this.ws = new WebSocket(this.cdp_url);
    this.ws.addEventListener("message", (event) => {
      void this._onMessage(event.data);
    });
    this.ws.addEventListener("close", () => this._rejectAll(new Error("CDP websocket closed")));
    this.ws.addEventListener("error", () => this._rejectAll(new Error(`CDP websocket error`)));
    await new Promise<void>((resolve, reject) => {
      this.ws?.addEventListener("open", () => resolve(), { once: true });
      this.ws?.addEventListener("error", reject, { once: true });
    });
    let ext;
    try {
      const { injectExtensionIfNeeded } = await loadInjector();
      ext = await injectExtensionIfNeeded({
        send: (method, params, sessionId) => this._sendFrame(method, params, sessionId),
        extensionPath: this.extension_path,
      });
    } catch (error) {
      const html = `<!doctype html><title>Enable MagicCDP</title><main style="font:16px system-ui;margin:40px;max-width:820px"><h1>Enable MagicCDP</h1><p>A MagicCDP client has connected, but was unable to set up the extra Magic.* commands because extension installation over CDP is only allowed in Chrome Canary or Chromium. Google Chrome users must install the extension manually and use chrome://inspect/#remote-debugging to open CDP.</p><ol><li>Download Chrome Canary or Chromium instead. MagicCDP can auto-launch these for you.</li><li>Connect to any remote Chrome launched with:<pre>--remote-debugging-address=127.0.0.1
--remote-debugging-port=9222
--enable-unsafe-extension-debugging
--remote-allow-origins=*</pre></li><li>Install the extension manually via chrome://extensions/ &gt; Developer mode &gt; Load unpacked &gt; magiccdp.zip<br><code>${this.extension_path}</code></li></ol></main>`;
      try {
        const { targetId } = (await this._sendFrame("Target.createTarget", { url: "about:blank" })) as any;
        const { sessionId } = (await this._sendFrame("Target.attachToTarget", {
          targetId,
          flatten: true,
        })) as any;
        await this._sendFrame(
          "Runtime.evaluate",
          {
            expression: `document.open();document.write(${JSON.stringify(html)});document.close();`,
            returnByValue: true,
          },
          sessionId as string,
        );
        await this._sendFrame("Page.bringToFront", {}, sessionId as string);
        await this._sendFrame("Target.detachFromTarget", { sessionId });
      } catch {}
      throw error;
    }
    this.extension_id = ext.extensionId;
    this.ext_target_id = ext.targetId;
    this.ext_session_id = ext.sessionId;
    await this._sendFrame("Runtime.enable", {}, this.ext_session_id);
    await this._sendFrame("Runtime.addBinding", { name: bindingNameFor("Magic.pong") }, this.ext_session_id);
    this.event_schemas.set("Magic.pong", Magic.PongEvent);

    if (this.server !== null) {
      await this._sendRaw(
        wrapCommandIfNeeded("Magic.configure", this.server, {
          routes: this.routes,
          cdpSessionId: this.ext_session_id,
        }),
      );
    }

    await this._measurePingLatency();
    return this;
  }

  async send(method: string, params: unknown = {}) {
    const commandParams = this.command_params_schemas.get(method)?.parse(params ?? {}) ?? params ?? {};
    const result = await this._sendRaw(
      wrapCommandIfNeeded(method, commandParams as ProtocolParams, {
        routes: this.routes,
        cdpSessionId: this.ext_session_id,
      }),
    );
    return this.command_result_schemas.get(method)?.parse(result) ?? result;
  }

  async close() {
    try {
      await this._sendFrame("Target.detachFromTarget", { sessionId: this.ext_session_id });
    } catch {}
    try {
      this.ws?.close();
    } catch {}
    if (this._launched) await this._launched.close();
  }

  on(eventName, listener) {
    return super.on(typeof eventName === "symbol" ? eventName : normalizeMagicName(eventName), listener);
  }

  once(eventName, listener) {
    return super.once(typeof eventName === "symbol" ? eventName : normalizeMagicName(eventName), listener);
  }

  async _measurePingLatency() {
    const sentAt = Date.now();
    const pong = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Magic.pong timed out")), 10_000);
      this.once("Magic.pong", (payload) => {
        clearTimeout(timeout);
        resolve(payload || {});
      });
    });
    await this.send("Magic.ping", { sentAt });
    const payload = (await pong) as MagicPongEvent;
    const returnedAt = Date.now();
    this.latency = {
      sentAt,
      receivedAt: payload.receivedAt ?? null,
      returnedAt,
      roundTripMs: returnedAt - sentAt,
      serviceWorkerMs: typeof payload.receivedAt === "number" ? payload.receivedAt - sentAt : null,
      returnPathMs: typeof payload.receivedAt === "number" ? returnedAt - payload.receivedAt : null,
    };
    return this.latency;
  }

  async _sendRaw(command: TranslatedCommand) {
    if (command.target === "direct_cdp") {
      const [step] = command.steps;
      return this._sendFrame(step.method, step.params ?? {});
    }
    if (command.target !== "service_worker") {
      throw new Error(`Unsupported command target "${command.target}"`);
    }

    let result = {};
    let unwrap = null;
    for (const step of command.steps) {
      result = await this._sendFrame(step.method, step.params ?? {}, this.ext_session_id);
      unwrap = step.unwrap ?? null;
    }
    return unwrapResponseIfNeeded(result, unwrap);
  }

  _sendFrame(method: string, params: ProtocolParams = {}, sessionId: string | null = null) {
    const id = this.next_id++;
    const message: CdpCommandFrame = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      if (!this.ws) {
        this.pending.delete(id);
        reject(new Error("CDP websocket is not connected"));
        return;
      }
      this.ws.send(JSON.stringify(message));
    });
  }

  _rejectAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async _onMessage(buf: unknown) {
    let msg: CdpResponseFrame | CdpEventFrame;
    try {
      const parsed = JSON.parse(await messageText(buf));
      msg = "id" in parsed ? CdpResponseFrameSchema.parse(parsed) : CdpEventFrameSchema.parse(parsed);
    } catch {
      return;
    }
    if ("id" in msg && typeof msg.id === "number") {
      const response = CdpResponseFrameSchema.parse(msg);
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) {
        const err = new Error(`${pending.method} failed: ${response.error.message}`) as Error & { cdp?: CdpError };
        err.cdp = response.error;
        pending.reject(err);
      } else {
        pending.resolve(response.result || {});
      }
      return;
    }
    const event = CdpEventFrameSchema.parse(msg);
    if (event.sessionId === this.ext_session_id) {
      if (event.method !== "Runtime.bindingCalled") return;
      const u = unwrapEventIfNeeded(
        event.method,
        events["Runtime.bindingCalled"].parse(event.params || {}),
        event.sessionId || null,
        this.ext_session_id,
      );
      if (u) this.emit(u.event, this.event_schemas.get(u.event)?.parse(u.data) ?? u.data);
      return;
    }
    if (event.method) {
      const schema = (events as Record<string, z.ZodType | undefined>)[event.method];
      this.emit(event.method, schema?.parse(event.params || {}) ?? event.params ?? {}, event.sessionId || null);
    }
  }
}

export interface MagicCDPClient extends CdpAliases {}
