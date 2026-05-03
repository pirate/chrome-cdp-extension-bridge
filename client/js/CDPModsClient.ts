// @ts-nocheck
// CDPModsClient (JS): importable, no CLI, no demo code.
//
// Constructor parameter names match across JS / Python / Go ports:
//   cdp_url           upstream CDP URL (string, default null -> try localhost:9222,
//                       then autolaunch)
//   extension_path    extension directory (string, default ../../extension)
//   routes            client-side routing dict (default { "Mods.*": "service_worker",
//                       "Custom.*": "service_worker", "*.*": "direct_cdp" })
//   server            { loopback_cdp_url?, routes? } passed to CDPModsServer.configure
//   launch_options    forwarded to launcher.launchChrome when running in Node and autolaunching
//
// Public methods: connect, send(method, params), on(event, handler), close.

// oxlint-disable typescript-eslint/no-unsafe-declaration-merging -- alias members are assigned by connect().
import type { z } from "zod";

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
  CDPModsConfigureParams,
  CDPModsPingLatency,
  CDPModsPongEvent,
  CDPModsRoutes,
  ProtocolPayload,
  ProtocolParams,
  ProtocolResult,
  TranslatedCommand,
} from "../../types/cdpmods.js";
import {
  CdpEventFrameSchema,
  CdpResponseFrameSchema,
  Mods,
  normalizeCDPModsName,
  normalizeCDPModsPayloadSchema,
} from "../../types/cdpmods.js";

const DEFAULT_LIVE_CDP_URL = "http://127.0.0.1:9222";

type PendingCommand = {
  method: string;
  resolve: (value: ProtocolResult) => void;
  reject: (error: Error) => void;
};
type ClientOptions = {
  cdp_url?: string | null;
  extension_path?: string;
  routes?: CDPModsRoutes;
  server?: CDPModsConfigureParams | null;
  custom_commands?: Array<Record<string, unknown>>;
  custom_events?: Array<Record<string, unknown>>;
  custom_middlewares?: Array<Record<string, unknown>>;
  hydrate_aliases?: boolean;
  service_worker_url_includes?: string[];
  service_worker_url_suffixes?: string[] | null;
  trust_service_worker_target?: boolean;
  launch_options?: Record<string, unknown>;
  self?: {
    addEventListener?: (listener: (event: string, data: ProtocolPayload, cdpSessionId: string | null) => void) => unknown;
    configure?: (params: CDPModsConfigureParams) => Promise<ProtocolResult>;
    handleCommand: (method: string, params?: ProtocolParams, cdpSessionId?: string | null) => Promise<ProtocolResult>;
  } | null;
};

export type CDPModsCommandSpec<Params = unknown, Result = unknown> = {
  params: Params;
  result: Result;
};
export type CDPModsCommandMap = Record<string, CDPModsCommandSpec>;
type MethodName<TName extends string> = TName extends `${string}.${infer TMethod}` ? TMethod : never;
type DomainName<TName extends string> = TName extends `${infer TDomain}.${string}` ? TDomain : never;
type CommandsForDomain<TCommands extends CDPModsCommandMap, TDomain extends string> = {
  [TName in keyof TCommands as TName extends `${TDomain}.${string}`
    ? MethodName<Extract<TName, string>>
    : never]: undefined extends TCommands[TName]["params"]
    ? (params?: TCommands[TName]["params"]) => Promise<TCommands[TName]["result"]>
    : (params: TCommands[TName]["params"]) => Promise<TCommands[TName]["result"]>;
};
export type CDPModsClientInstance<TCommands extends CDPModsCommandMap = Record<never, never>> = CDPModsClient & {
  [TDomain in DomainName<Extract<keyof TCommands, string>>]: CommandsForDomain<TCommands, TDomain>;
};

class CDPModsEventEmitter {
  private listeners = new Map<string | symbol, Set<(...args: unknown[]) => void>>();

  on(eventName: string | symbol, listener: (...args: unknown[]) => void) {
    this.listeners.get(eventName)?.add(listener) ?? this.listeners.set(eventName, new Set([listener]));
    return this;
  }

  once(eventName: string | symbol, listener: (...args: unknown[]) => void) {
    const wrapped = (...args: unknown[]) => {
      this.listeners.get(eventName)?.delete(wrapped);
      listener(...args);
    };
    return this.on(eventName, wrapped);
  }

  emit(eventName: string | symbol, ...args: unknown[]) {
    for (const listener of this.listeners.get(eventName) ?? []) listener(...args);
    return true;
  }
}

function defineCustomCommandMethod(client: CDPModsClient, name: string) {
  const [domain, method] = name.split(".", 2);
  if (!domain || !method) throw new Error(`Custom command must use Domain.method format, got ${name}`);
  const target = client as unknown as Record<string, Record<string, unknown>>;
  if (method === "*") {
    target[domain] = new Proxy(target[domain] ?? {}, {
      get(existing, property, receiver) {
        if (typeof property !== "string") return Reflect.get(existing, property, receiver);
        if (property in existing) return Reflect.get(existing, property, receiver);
        const commandName = `${domain}.${property}`;
        const alias = (params?: unknown) => client.send(commandName, params ?? {});
        Object.defineProperties(alias, {
          cdp_command_name: { value: commandName, enumerable: true, configurable: true },
          id: { value: commandName, enumerable: true, configurable: true },
          name: { value: commandName, configurable: true },
          kind: { value: "command", enumerable: true, configurable: true },
          meta: {
            value: () => ({
              cdp_command_name: commandName,
              id: commandName,
              name: commandName,
              kind: "command",
            }),
            configurable: true,
          },
        });
        existing[property] = alias;
        return alias;
      },
    });
    return;
  }
  target[domain] ??= {};
  const alias = (params?: unknown) => client.send(name, params ?? {});
  Object.defineProperties(alias, {
    cdp_command_name: { value: name, enumerable: true, configurable: true },
    id: { value: name, enumerable: true, configurable: true },
    name: { value: name, configurable: true },
    kind: { value: "command", enumerable: true, configurable: true },
    meta: { value: () => ({ cdp_command_name: name, id: name, name, kind: "command" }), configurable: true },
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

function defaultExtensionPath() {
  if (typeof process === "object" && process?.versions?.node && import.meta.url.startsWith("file:")) {
    return decodeURIComponent(new URL("../../extension", import.meta.url).pathname);
  }
  return "../../extension";
}

function runtimeModuleUrl(relativePath: string) {
  const resolveUrl = new Function("relativePath", "baseUrl", "return new URL(relativePath, baseUrl).href") as (
    relativePath: string,
    baseUrl: string,
  ) => string;
  return resolveUrl(relativePath, import.meta.url);
}

export class CDPModsClient extends CDPModsEventEmitter {
  cdp_url: string | null;
  extension_path: string;
  routes: CDPModsRoutes;
  server: CDPModsConfigureParams | null;
  launch_options: Record<string, unknown>;
  custom_commands: Array<Record<string, unknown>>;
  custom_events: Array<Record<string, unknown>>;
  custom_middlewares: Array<Record<string, unknown>>;
  hydrate_aliases: boolean;
  service_worker_url_includes: string[];
  service_worker_url_suffixes: string[] | null;
  trust_service_worker_target: boolean;
  ws: WebSocket | null;
  self: ClientOptions["self"];
  next_id: number;
  pending: Map<number, PendingCommand>;
  ext_session_id: string | null;
  ext_target_id: string | null;
  extension_id: string | null;
  latency: CDPModsPingLatency | null;
  event_schemas: Map<string, z.ZodType>;
  command_params_schemas: Map<string, z.ZodType>;
  command_result_schemas: Map<string, z.ZodType>;
  self_event_listener_registered: boolean;
  cdp_aliases_hydrated: boolean;
  _cdp: {
    send: (method: string, params?: ProtocolParams, sessionId?: string | null) => Promise<ProtocolResult>;
    on: (eventName: string | symbol, listener: (...args: unknown[]) => void) => CDPModsClient;
    once: (eventName: string | symbol, listener: (...args: unknown[]) => void) => CDPModsClient;
  };
  _launched: { close: () => Promise<void> | void } | null;

  constructor({
    cdp_url = null,
    extension_path = defaultExtensionPath(),
    routes = DEFAULT_CLIENT_ROUTES,
    server = {},
    custom_commands = [],
    custom_events = [],
    custom_middlewares = [],
    hydrate_aliases = true,
    service_worker_url_includes = [],
    service_worker_url_suffixes = null,
    trust_service_worker_target = false,
    launch_options = {},
    self = null,
  }: ClientOptions = {}) {
    super();
    this.cdp_url = cdp_url;
    this.extension_path = extension_path;
    this.routes = { ...DEFAULT_CLIENT_ROUTES, ...routes };
    this.server = server;
    this.custom_commands = custom_commands;
    this.custom_events = custom_events;
    this.custom_middlewares = custom_middlewares;
    this.hydrate_aliases = hydrate_aliases;
    this.service_worker_url_includes = service_worker_url_includes;
    this.service_worker_url_suffixes = service_worker_url_suffixes;
    this.trust_service_worker_target = trust_service_worker_target;
    this.launch_options = launch_options;
    this.self = self;

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
    this.self_event_listener_registered = false;
    this.cdp_aliases_hydrated = false;
    this._launched = null;

    this._cdp = {
      send: (method: string, params: ProtocolParams = {}, sessionId: string | null = null) =>
        this._sendFrame(method, params, sessionId),
      on: (eventName: string | symbol, listener: (...args: unknown[]) => void) => this.on(eventName, listener),
      once: (eventName: string | symbol, listener: (...args: unknown[]) => void) => this.once(eventName, listener),
    };
    this._hydrateCustomSurface();
  }

  async connect() {
    await this._hydrateCdpAliases();
    if (this.self && !this.cdp_url) {
      this._ensureSelfEventListener();
      if (this.server !== null) await this.self.configure?.(this._serverConfigureParams());
      return this;
    }
    if (!this.cdp_url) {
      this.cdp_url = await liveWebSocketUrlFor();
      if (!this.cdp_url) {
        if (typeof process !== "object" || !process?.versions?.node) {
          throw new Error("CDPModsClient requires cdp_url when running outside Node.");
        }
        const launcherSpecifier = runtimeModuleUrl("../../bridge/launcher.js");
        const importNodeOnly = new Function("specifier", "return import(specifier)") as (
          specifier: string,
        ) => Promise<{ launchChrome: (options: Record<string, unknown>) => Promise<{ wsUrl: string; close: () => Promise<void> | void }> }>;
        const { launchChrome } = await importNodeOnly(launcherSpecifier);
        this._launched = await launchChrome(this.launch_options);
        this.cdp_url = this._launched.wsUrl;
      }
    }
    const inputCdpUrl = this.cdp_url;
    this.cdp_url = await webSocketUrlFor(this.cdp_url);
    if (this.server !== null && !Object.hasOwn(this.server, "loopback_cdp_url")) {
      this.server = { ...this.server, loopback_cdp_url: this.cdp_url };
    } else if (this.server?.loopback_cdp_url) {
      const loopbackUrl = this.server.loopback_cdp_url;
      if (loopbackUrl === inputCdpUrl || loopbackUrl === this.cdp_url) {
        this.server = { ...this.server, loopback_cdp_url: this.cdp_url };
      }
    }

    this.ws = new WebSocket(this.cdp_url);
    this.ws.addEventListener("message", (event) => this._onMessage(event.data));
    this.ws.addEventListener("close", () => this._rejectAll(new Error("CDP websocket closed")));
    this.ws.addEventListener("error", () => this._rejectAll(new Error(`CDP websocket error`)));
    await new Promise<void>((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    await Promise.all([
      this._sendFrame("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      }),
      this._sendFrame("Target.setDiscoverTargets", { discover: true }),
    ]);

    const serviceWorkerUrlSuffixes = await this._serviceWorkerUrlSuffixes();
    const trustServiceWorkerTarget =
      this.trust_service_worker_target ||
      this.service_worker_url_includes.length > 0 ||
      serviceWorkerUrlSuffixes.some((suffix) => suffix.split("/").filter(Boolean).length > 1);

    let ext;
    try {
      const importRuntime = new Function("specifier", "return import(specifier)") as (
        specifier: string,
      ) => Promise<typeof import("../../bridge/injector.js")>;
      const { injectExtensionIfNeeded } = await importRuntime(runtimeModuleUrl("../../bridge/injector.js"));
      ext = await injectExtensionIfNeeded({
        send: (method, params, sessionId) => this._sendFrame(method, params, sessionId),
        extensionPath: this.extension_path,
        serviceWorkerUrlIncludes: this.service_worker_url_includes,
        serviceWorkerUrlSuffixes,
        trustMatchedServiceWorker: trustServiceWorkerTarget,
      });
    } catch (error) {
      const html = `<!doctype html><title>Enable CDPMods</title><main style="font:16px system-ui;margin:40px;max-width:820px"><h1>Enable CDPMods</h1><p>A CDPMods client has connected, but was unable to set up the extra Mods.* commands because extension installation over CDP is only allowed in Chrome Canary or Chromium. Google Chrome users must install the extension manually and use chrome://inspect/#remote-debugging to open CDP.</p><ol><li>Download Chrome Canary or Chromium instead. CDPMods can auto-launch these for you.</li><li>Connect to any remote Chrome launched with:<pre>--remote-debugging-address=127.0.0.1
--remote-debugging-port=9222
--enable-unsafe-extension-debugging
--remote-allow-origins=*</pre></li><li>Install the extension manually via chrome://extensions/ &gt; Developer mode &gt; Load unpacked &gt; cdpmods.zip<br><code>${this.extension_path}</code></li></ol></main>`;
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
    this.event_schemas.set("Mods.pong", Mods.PongEvent);

    await Promise.all([
      this._sendFrame("Runtime.enable", {}, this.ext_session_id),
      this._sendFrame("Runtime.addBinding", { name: bindingNameFor("Mods.pong") }, this.ext_session_id),
      this._installCustomEventBindings(),
      this.server === null
        ? Promise.resolve()
        : this._sendRaw(
            wrapCommandIfNeeded("Mods.configure", this._serverConfigureParams(), {
              routes: this.routes,
              cdpSessionId: this.ext_session_id,
            }),
          ),
    ]);

    void this._measurePingLatency().catch(() => {});
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

  async _hydrateCdpAliases() {
    if (!this.hydrate_aliases || this.cdp_aliases_hydrated) return;
    const importRuntime = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<typeof import("../../types/aliases.js")>;
    const { createCdpAliases } = await importRuntime(runtimeModuleUrl("../../types/aliases.js"));
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
    this.cdp_aliases_hydrated = true;
  }

  _hydrateCustomSurface() {
    for (const command of this.custom_commands) {
      const name = normalizeCDPModsName(command.name);
      const paramsSchema = command.paramsSchema ? Mods.PayloadSchemaSpec.parse(command.paramsSchema) : null;
      const resultSchema = command.resultSchema ? Mods.PayloadSchemaSpec.parse(command.resultSchema) : null;
      const normalizedParamsSchema = paramsSchema == null ? null : this._normalizePayloadSchema(paramsSchema);
      const normalizedResultSchema = resultSchema == null ? null : this._normalizePayloadSchema(resultSchema);
      if (normalizedParamsSchema) this.command_params_schemas.set(name, normalizedParamsSchema);
      if (normalizedResultSchema) this.command_result_schemas.set(name, normalizedResultSchema);
      defineCustomCommandMethod(this, name);
    }
    for (const event of this.custom_events) {
      const name = normalizeCDPModsName(event.name);
      const eventSchema = event.eventSchema ? this._normalizePayloadSchema(event.eventSchema) : null;
      if (eventSchema) this.event_schemas.set(name, eventSchema);
    }
  }

  _normalizePayloadSchema(schema) {
    return normalizeCDPModsPayloadSchema(Mods.PayloadSchemaSpec.parse(schema));
  }

  async _serviceWorkerUrlSuffixes() {
    if (this.service_worker_url_suffixes != null) return this.service_worker_url_suffixes;
    if (typeof process !== "object" || !process?.versions?.node || !this.extension_path) return [];
    try {
      const importNodeOnly = new Function("specifier", "return import(specifier)") as (
        specifier: string,
      ) => Promise<{ readFile: (path: string, encoding: string) => Promise<string> }>;
      const { readFile } = await importNodeOnly("node:fs/promises");
      const manifest = JSON.parse(await readFile(`${this.extension_path.replace(/\/$/u, "")}/manifest.json`, "utf8"));
      const serviceWorker = manifest?.background?.service_worker;
      return typeof serviceWorker === "string" && serviceWorker.length > 0 ? [`/${serviceWorker}`] : [];
    } catch {
      return [];
    }
  }

  _serverConfigureParams() {
    return {
      ...(this.server ?? {}),
      custom_commands: this.custom_commands.map(({ name, expression, paramsSchema, resultSchema }) => ({
        name: normalizeCDPModsName(name),
        expression,
        paramsSchema: null,
        resultSchema: null,
      })),
      custom_events: this.custom_events.map(({ name, eventSchema }) => ({
        name: normalizeCDPModsName(name),
        bindingName: bindingNameFor(normalizeCDPModsName(name)),
        eventSchema: null,
      })),
      custom_middlewares: this.custom_middlewares.map(({ name, phase, expression }) => ({
        ...(name == null ? {} : { name: normalizeCDPModsName(name) }),
        phase,
        expression,
      })),
    };
  }

  async _installCustomEventBindings() {
    await Promise.all(
      this.custom_events.map((event) =>
        this._sendFrame("Runtime.addBinding", { name: bindingNameFor(normalizeCDPModsName(event.name)) }, this.ext_session_id),
      ),
    );
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
    if (typeof eventName !== "string" && typeof eventName !== "symbol" && eventName?.parse) {
      const name = normalizeCDPModsName(eventName);
      this.event_schemas.set(name, eventName);
      return super.on(name, listener);
    }
    return super.on(typeof eventName === "symbol" ? eventName : normalizeCDPModsName(eventName), listener);
  }

  once(eventName, listener) {
    if (typeof eventName !== "string" && typeof eventName !== "symbol" && eventName?.parse) {
      const name = normalizeCDPModsName(eventName);
      this.event_schemas.set(name, eventName);
      return super.once(name, listener);
    }
    return super.once(typeof eventName === "symbol" ? eventName : normalizeCDPModsName(eventName), listener);
  }

  async _measurePingLatency() {
    const sentAt = Date.now();
    const pong = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Mods.pong timed out")), 10_000);
      this.once("Mods.pong", (payload) => {
        clearTimeout(timeout);
        resolve(payload || {});
      });
    });
    await this.send("Mods.ping", { sentAt });
    const payload = (await pong) as CDPModsPongEvent;
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
    if (command.target === "self") {
      if (!this.self) throw new Error(`CDPModsClient self route requires a self server.`);
      this._ensureSelfEventListener();
      const [step] = command.steps;
      const cdpSessionId = ((step.params as CDPModsCustomPayload | undefined)?.cdpSessionId as string | undefined) ?? this.ext_session_id;
      return await this.self.handleCommand(step.method, step.params ?? {}, cdpSessionId ?? null);
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

  _ensureSelfEventListener() {
    if (!this.self || this.self_event_listener_registered) return;
    this.self.addEventListener?.((event, data, cdpSessionId) => {
      this.emit(event, this.event_schemas.get(event)?.parse(data) ?? data, cdpSessionId);
    });
    this.self_event_listener_registered = true;
  }

  _sendFrame(method: string, params: ProtocolParams = {}, sessionId: string | null = null) {
    if (!this.ws) return Promise.reject(new Error("CDP websocket is not connected."));
    const id = this.next_id++;
    const message: CdpCommandFrame = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.ws?.send(JSON.stringify(message));
    });
  }

  _rejectAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  _onMessage(buf: unknown) {
    let msg: CdpResponseFrame | CdpEventFrame;
    try {
      const parsed = JSON.parse(typeof buf === "string" ? buf : String(buf));
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
        event.params || {},
        event.sessionId || null,
        this.ext_session_id,
      );
      if (u) this.emit(u.event, this.event_schemas.get(u.event)?.parse(u.data) ?? u.data);
      return;
    }
    if (event.method) {
      this.emit(
        event.method,
        this.event_schemas.get(event.method)?.parse(event.params || {}) ?? event.params ?? {},
        event.sessionId || null,
      );
    }
  }
}

export interface CDPModsClient extends CdpAliases {}
