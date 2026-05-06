// ModCDPClient (JS): importable, no CLI, no demo code.
//
// Constructor parameter names match across JS / Python / Go ports:
//   cdp_url           upstream CDP URL (string, default null -> autolaunch)
//   extension_path    extension directory (string, default ../../extension)
//   routes            client-side routing dict (default { "Mod.*": "service_worker",
//                       "Custom.*": "service_worker", "*.*": "direct_cdp" })
//   server            { loopback_cdp_url?, routes? } passed to ModCDPServer.configure
//   launch_options    forwarded to launcher.launchChrome when running in Node and autolaunching
//   scan_for_existing_localhost_9222
//                     when true and cdp_url is unset, attach to localhost:9222 before autolaunching
//
// Public methods: connect, send(method, params), on(event, handler), close.

// oxlint-disable typescript-eslint/no-unsafe-declaration-merging -- alias members are assigned by connect().
import type { z } from "zod";

import { createCdpAliases, type CdpAliases } from "../../types/aliases.js";
import {
  bindingNameFor,
  DEFAULT_CLIENT_ROUTES,
  UPSTREAM_EVENT_BINDING_NAME,
  wrapCommandIfNeeded,
  unwrapResponseIfNeeded,
  unwrapEventIfNeeded,
} from "../../bridge/translate.js";
import type {
  CdpCommandFrame,
  CdpError,
  CdpEventFrame,
  CdpResponseFrame,
  RuntimeBindingCalledEvent,
  ModCDPConfigureParams,
  ModCDPCustomPayload,
  ModCDPAddCustomCommandParams,
  ModCDPAddCustomEventObjectParams,
  ModCDPAddMiddlewareParams,
  ModCDPNamedValue,
  ModCDPPingLatency,
  ModCDPPongEvent,
  ModCDPRoutes,
  ProtocolPayload,
  ProtocolParams,
  ProtocolResult,
  TranslatedCommand,
} from "../../types/modcdp.js";
import {
  CdpEventFrameSchema,
  CdpResponseFrameSchema,
  Mod,
  normalizeModCDPName,
  normalizeModCDPPayloadSchema,
} from "../../types/modcdp.js";

const DEFAULT_LIVE_CDP_URL = "http://127.0.0.1:9222";

type PendingCommand = {
  method: string;
  resolve: (value: ProtocolResult) => void;
  reject: (error: Error) => void;
};
type ClientOptions = {
  cdp_url?: string | null;
  extension_path?: string;
  routes?: ModCDPRoutes;
  server?: ModCDPConfigureParams | null;
  custom_commands?: ModCDPClientCustomCommandParams[];
  custom_events?: ModCDPAddCustomEventObjectParams[];
  custom_middlewares?: ModCDPAddMiddlewareParams[];
  hydrate_aliases?: boolean;
  service_worker_url_includes?: string[];
  service_worker_url_suffixes?: string[] | null;
  trust_service_worker_target?: boolean;
  require_service_worker_target?: boolean;
  service_worker_ready_expression?: string | null;
  launch_options?: Record<string, unknown>;
  scan_for_existing_localhost_9222?: boolean;
  self?: {
    addEventListener?: (
      listener: (event: string, data: ProtocolPayload, cdpSessionId: string | null) => void,
    ) => unknown;
    configure?: (params: ModCDPConfigureParams) => Promise<ProtocolResult>;
    handleCommand: (method: string, params?: ProtocolParams, cdpSessionId?: string | null) => Promise<ProtocolResult>;
  } | null;
};
type ModCDPEventNameInput = string | symbol | (z.ZodType & ModCDPNamedValue);
type ModCDPClientCustomCommandParams = Omit<ModCDPAddCustomCommandParams, "expression"> & {
  expression?: string | null;
};

export type ModCDPCommandSpec<Params = unknown, Result = unknown> = {
  params: Params;
  result: Result;
};
export type ModCDPCommandMap = Record<string, ModCDPCommandSpec>;
type MethodName<TName extends string> = TName extends `${string}.${infer TMethod}` ? TMethod : never;
type DomainName<TName extends string> = TName extends `${infer TDomain}.${string}` ? TDomain : never;
type CommandsForDomain<TCommands extends ModCDPCommandMap, TDomain extends string> = {
  [TName in keyof TCommands as TName extends `${TDomain}.${string}`
    ? MethodName<Extract<TName, string>>
    : never]: undefined extends TCommands[TName]["params"]
    ? (params?: TCommands[TName]["params"]) => Promise<TCommands[TName]["result"]>
    : (params: TCommands[TName]["params"]) => Promise<TCommands[TName]["result"]>;
};
export type ModCDPClientInstance<TCommands extends ModCDPCommandMap = Record<never, never>> = ModCDPClient & {
  [TDomain in DomainName<Extract<keyof TCommands, string>>]: CommandsForDomain<TCommands, TDomain>;
};

class ModCDPEventEmitter {
  private listeners = new Map<string | symbol, Set<(...args: unknown[]) => void>>();

  on(event_name: string | symbol, listener: (...args: unknown[]) => void) {
    const listeners = this.listeners.get(event_name);
    if (listeners) listeners.add(listener);
    else this.listeners.set(event_name, new Set([listener]));
    return this;
  }

  once(event_name: string | symbol, listener: (...args: unknown[]) => void) {
    const wrapped = (...args: unknown[]) => {
      this.listeners.get(event_name)?.delete(wrapped);
      listener(...args);
    };
    return this.on(event_name, wrapped);
  }

  off(event_name: string | symbol, listener: (...args: unknown[]) => void) {
    this.listeners.get(event_name)?.delete(listener);
    return this;
  }

  emit(event_name: string | symbol, ...args: unknown[]) {
    for (const listener of this.listeners.get(event_name) ?? []) listener(...args);
    if (event_name !== "*") {
      for (const listener of this.listeners.get("*") ?? []) listener(event_name, ...args);
    }
    return true;
  }
}

function defineCustomCommandMethod(client: ModCDPClient, name: string) {
  const parts = name.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Custom command must use Domain.method format, got ${name}`);
  }
  const [domain, method] = parts;
  const target = client as unknown as Record<string, Record<string, unknown>>;
  if (method === "*") {
    target[domain] = new Proxy(target[domain] ?? {}, {
      get(existing, property, receiver) {
        if (typeof property !== "string") return Reflect.get(existing, property, receiver);
        if (property in existing) return Reflect.get(existing, property, receiver);
        const command_name = `${domain}.${property}`;
        const alias = (params?: unknown) => client.send(command_name, params ?? {});
        Object.defineProperties(alias, {
          cdp_command_name: { value: command_name, enumerable: true, configurable: true },
          id: { value: command_name, enumerable: true, configurable: true },
          name: { value: command_name, configurable: true },
          kind: { value: "command", enumerable: true, configurable: true },
          meta: {
            value: () => ({
              cdp_command_name: command_name,
              id: command_name,
              name: command_name,
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
  const http_endpoint = /^[a-z][a-z\d+\-.]*:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`;
  const response = await fetch(`${http_endpoint}/json/version`);
  if (!response.ok) {
    if (response.status === 404) {
      const url = new URL(http_endpoint);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = "/devtools/browser";
      url.search = "";
      url.hash = "";
      return url.toString();
    }
    throw new Error(`GET ${http_endpoint}/json/version -> ${response.status}`);
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
    return decodeURIComponent(new URL(/* @vite-ignore */ "../../extension", import.meta.url).pathname);
  }
  return "../../extension";
}

function runtimeModuleUrl(relative_path: string) {
  return new URL(relative_path, import.meta.url).href;
}

function launchOptionsWithExtension(
  launch_options: Record<string, unknown>,
  extension_path: string,
): Record<string, unknown> {
  const extra_args = [
    ...(Array.isArray(launch_options.args) ? launch_options.args : []),
    ...(Array.isArray(launch_options.extra_args) ? launch_options.extra_args : []),
  ];
  if (!extra_args.some((arg) => typeof arg === "string" && arg.startsWith("--load-extension="))) {
    extra_args.push(`--load-extension=${extension_path}`);
  }
  return { ...launch_options, extra_args };
}

function hasCommandExpression(
  command: ModCDPClientCustomCommandParams,
): command is ModCDPClientCustomCommandParams & { expression: string } {
  return typeof command.expression === "string" && command.expression.length > 0;
}

export class ModCDPClient extends ModCDPEventEmitter {
  cdp_url: string | null;
  extension_path: string;
  routes: ModCDPRoutes;
  server: ModCDPConfigureParams | null;
  launch_options: Record<string, unknown>;
  custom_commands: ModCDPClientCustomCommandParams[];
  custom_events: ModCDPAddCustomEventObjectParams[];
  custom_middlewares: ModCDPAddMiddlewareParams[];
  hydrate_aliases: boolean;
  service_worker_url_includes: string[];
  service_worker_url_suffixes: string[] | null;
  trust_service_worker_target: boolean;
  require_service_worker_target: boolean;
  service_worker_ready_expression: string | null;
  ws: WebSocket | null;
  self: ClientOptions["self"];
  scan_for_existing_localhost_9222: boolean;
  next_id: number;
  pending: Map<number, PendingCommand>;
  ext_session_id: string | null;
  ext_target_id: string | null;
  extension_id: string | null;
  latency: ModCDPPingLatency | null;
  connect_timing: Record<string, unknown> | null;
  last_command_timing: Record<string, unknown> | null;
  last_raw_timing: Record<string, unknown> | null;
  event_schemas: Map<string, z.ZodType>;
  command_params_schemas: Map<string, z.ZodType>;
  command_result_schemas: Map<string, z.ZodType>;
  self_event_listener_registered: boolean;
  cdp_aliases_hydrated: boolean;
  event_wait_cleanups: Set<() => void>;
  auto_target_sessions: Map<string, string>;
  auto_session_targets: Map<string, Record<string, unknown>>;
  _prepared_extension: { path: string; close: () => Promise<void> } | null;
  _cdp: {
    send: (method: string, params?: ProtocolParams, sessionId?: string | null) => Promise<ProtocolResult>;
    on: (eventName: string | symbol, listener: (...args: unknown[]) => void) => ModCDPClient;
    once: (eventName: string | symbol, listener: (...args: unknown[]) => void) => ModCDPClient;
  };
  _launched: { wsUrl: string; close: () => Promise<void> | void } | null;

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
    require_service_worker_target = false,
    service_worker_ready_expression = null,
    launch_options = {},
    scan_for_existing_localhost_9222 = false,
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
    this.require_service_worker_target = require_service_worker_target;
    this.service_worker_ready_expression = service_worker_ready_expression;
    this.launch_options = launch_options;
    this.scan_for_existing_localhost_9222 = scan_for_existing_localhost_9222;
    this.self = self;

    this.ws = null;
    this.next_id = 1;
    this.pending = new Map();
    this.ext_session_id = null;
    this.ext_target_id = null;
    this.extension_id = null;
    this.latency = null;
    this.connect_timing = null;
    this.last_command_timing = null;
    this.last_raw_timing = null;
    this.event_schemas = new Map();
    this.command_params_schemas = new Map();
    this.command_result_schemas = new Map();
    this.self_event_listener_registered = false;
    this.cdp_aliases_hydrated = false;
    this.event_wait_cleanups = new Set();
    this.auto_target_sessions = new Map();
    this.auto_session_targets = new Map();
    this._prepared_extension = null;
    this._launched = null;

    this._cdp = {
      send: (method: string, params: ProtocolParams = {}, session_id: string | null = null) =>
        this._sendFrame(method, params, session_id, { record_raw_timing: true }) as Promise<ProtocolResult>,
      on: (event_name: string | symbol, listener: (...args: unknown[]) => void) => this.on(event_name, listener),
      once: (event_name: string | symbol, listener: (...args: unknown[]) => void) => this.once(event_name, listener),
    };
    this._hydrateCustomSurface();
  }

  async connect() {
    const connect_started_at = Date.now();
    await this._hydrateCdpAliases();
    if (this.self && !this.cdp_url) {
      this._ensureSelfEventListener();
      if (this.server !== null) await this.self.configure?.(this._serverConfigureParams());
      const connected_at = Date.now();
      this.connect_timing = {
        started_at: connect_started_at,
        connected_at,
        duration_ms: connected_at - connect_started_at,
      };
      return this;
    }
    if (!this.cdp_url) {
      this.cdp_url = this.scan_for_existing_localhost_9222 ? await liveWebSocketUrlFor() : null;
      if (!this.cdp_url) {
        if (typeof process !== "object" || !process?.versions?.node) {
          throw new Error("ModCDPClient requires cdp_url when running outside Node.");
        }
        const { launchChrome } = (await import(/* @vite-ignore */ runtimeModuleUrl("../../bridge/launcher.js"))) as {
          launchChrome: (
            options: Record<string, unknown>,
          ) => Promise<{ wsUrl: string; close: () => Promise<void> | void }>;
        };
        this._prepared_extension ??= await this._prepareExtensionPath();
        this._launched = await launchChrome(
          launchOptionsWithExtension(this.launch_options, this._prepared_extension.path),
        );
        this.cdp_url = this._launched.wsUrl;
      }
    }
    const input_cdp_url = this.cdp_url;
    const websocket_url = await webSocketUrlFor(this.cdp_url);
    this.cdp_url = websocket_url;
    if (this.server !== null && !Object.hasOwn(this.server, "loopback_cdp_url")) {
      this.server = { ...this.server, loopback_cdp_url: this.cdp_url };
    } else if (this.server?.loopback_cdp_url) {
      const loopback_url = this.server.loopback_cdp_url;
      if (loopback_url === input_cdp_url || loopback_url === this.cdp_url) {
        this.server = { ...this.server, loopback_cdp_url: this.cdp_url };
      }
    }

    const ws = new WebSocket(websocket_url);
    this.ws = ws;
    ws.addEventListener("message", (event) => this._onMessage(event.data));
    ws.addEventListener("close", () => {
      if (this.pending.size > 0) this._rejectAll(new Error("CDP websocket closed"));
    });
    ws.addEventListener("error", () => {
      if (this.pending.size > 0) this._rejectAll(new Error("CDP websocket error"));
    });
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("CDP websocket error"));
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onError);
    });
    await Promise.all([
      this._sendFrame("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      }),
      this._sendFrame("Target.setDiscoverTargets", { discover: true }),
    ]);

    const service_worker_url_suffixes = await this._serviceWorkerUrlSuffixes();
    const trust_service_worker_target =
      this.trust_service_worker_target ||
      this.service_worker_url_includes.length > 0 ||
      service_worker_url_suffixes.some((suffix) => suffix.split("/").filter(Boolean).length > 1);

    let ext;
    const extension_started_at = Date.now();
    const { injectExtensionIfNeeded } = (await import(
      /* @vite-ignore */ runtimeModuleUrl("../../bridge/injector.js")
    )) as typeof import("../../bridge/injector.js");
    this._prepared_extension ??= await this._prepareExtensionPath();
    ext = await injectExtensionIfNeeded({
      send: (method, params, session_id) => this._sendFrame(method, params, session_id) as Promise<ProtocolResult>,
      session_id_for_target: (target_id) => this.auto_target_sessions.get(target_id) ?? null,
      extension_path: this._prepared_extension.path,
      service_worker_url_includes: this.service_worker_url_includes,
      service_worker_url_suffixes,
      trust_matched_service_worker: trust_service_worker_target,
      require_service_worker_target: this.require_service_worker_target,
      service_worker_ready_expression: this.service_worker_ready_expression,
    });
    const extension_completed_at = Date.now();
    this.extension_id = typeof ext.extension_id === "string" ? ext.extension_id : null;
    this.ext_target_id = ext.target_id;
    this.ext_session_id = ext.session_id;
    this.event_schemas.set("Mod.pong", Mod.PongEvent);

    await Promise.all([
      this._sendFrame("Runtime.enable", {}, this.ext_session_id),
      this._sendFrame("Runtime.addBinding", { name: UPSTREAM_EVENT_BINDING_NAME }, this.ext_session_id),
      this._sendFrame("Runtime.addBinding", { name: bindingNameFor("Mod.pong") }, this.ext_session_id),
      this._installCustomEventBindings(),
      this.server === null
        ? Promise.resolve()
        : this._sendRaw(
            wrapCommandIfNeeded("Mod.configure", this._serverConfigureParams(), {
              routes: this.routes,
              cdpSessionId: this.ext_session_id,
            }),
          ),
    ]);

    void this._measurePingLatency().catch(() => {});
    const connected_at = Date.now();
    this.connect_timing = {
      started_at: connect_started_at,
      extension_source: ext.source,
      extension_started_at,
      extension_completed_at,
      extension_duration_ms: extension_completed_at - extension_started_at,
      connected_at,
      duration_ms: connected_at - connect_started_at,
    };
    return this;
  }

  async send(method: string, params: unknown = {}) {
    const started_at = Date.now();
    const command_params = this.command_params_schemas.get(method)?.parse(params ?? {}) ?? params ?? {};
    const command = wrapCommandIfNeeded(method, command_params as ProtocolParams, {
      routes: this.routes,
    });
    const result = await this._sendRaw(command);
    const completed_at = Date.now();
    this.last_command_timing = {
      method,
      target: command.target,
      started_at,
      completed_at,
      duration_ms: completed_at - started_at,
    };
    return this.command_result_schemas.get(method)?.parse(result) ?? result;
  }

  async _hydrateCdpAliases() {
    if (!this.hydrate_aliases || this.cdp_aliases_hydrated) return;
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
      const name = normalizeModCDPName(command.name);
      const paramsSchema = command.paramsSchema ? Mod.PayloadSchemaSpec.parse(command.paramsSchema) : null;
      const resultSchema = command.resultSchema ? Mod.PayloadSchemaSpec.parse(command.resultSchema) : null;
      const normalized_params_schema = paramsSchema == null ? null : this._normalizePayloadSchema(paramsSchema);
      const normalized_result_schema = resultSchema == null ? null : this._normalizePayloadSchema(resultSchema);
      if (normalized_params_schema) this.command_params_schemas.set(name, normalized_params_schema);
      if (normalized_result_schema) this.command_result_schemas.set(name, normalized_result_schema);
      defineCustomCommandMethod(this, name);
    }
    for (const event of this.custom_events) {
      const name = normalizeModCDPName(event.name);
      const eventSchema = event.eventSchema ? this._normalizePayloadSchema(event.eventSchema) : null;
      if (eventSchema) this.event_schemas.set(name, eventSchema);
    }
  }

  _normalizePayloadSchema(schema: unknown) {
    return normalizeModCDPPayloadSchema(Mod.PayloadSchemaSpec.parse(schema));
  }

  async _serviceWorkerUrlSuffixes() {
    if (this.service_worker_url_suffixes != null) return this.service_worker_url_suffixes;
    return ["/service_worker.js", "/background.js"];
  }

  _serverConfigureParams(): ModCDPConfigureParams {
    return {
      ...(this.server ?? {}),
      custom_commands: this.custom_commands.filter(hasCommandExpression).map((command) => ({
        name: normalizeModCDPName(command.name),
        expression: command.expression,
        paramsSchema: null as null,
        resultSchema: null as null,
      })),
      custom_events: this.custom_events.map((event) => ({
        name: normalizeModCDPName(event.name),
        bindingName: bindingNameFor(normalizeModCDPName(event.name)),
        eventSchema: null as null,
      })),
      custom_middlewares: this.custom_middlewares.map(({ name, phase, expression }) => ({
        ...(name == null ? {} : { name: normalizeModCDPName(name) }),
        phase,
        expression,
      })),
    };
  }

  async _prepareExtensionPath() {
    if (this.extension_path.endsWith(".zip") && typeof process === "object" && process?.versions?.node) {
      const nodeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
      const [{ execFileSync }, fs, os, path] = await Promise.all(
        ["node:child_process", "node:fs", "node:os", "node:path"].map(nodeImport),
      );
      const unpacked_path = fs.mkdtempSync(path.join(os.tmpdir(), "modcdp-extension-"));
      execFileSync("unzip", ["-q", this.extension_path, "-d", unpacked_path]);
      return {
        path: unpacked_path,
        close: async () => fs.rmSync(unpacked_path, { recursive: true, force: true }),
      };
    }
    return { path: this.extension_path, close: async () => {} };
  }

  async _installCustomEventBindings() {
    await Promise.all(
      this.custom_events.map((event) =>
        this._sendFrame(
          "Runtime.addBinding",
          { name: bindingNameFor(normalizeModCDPName(event.name)) },
          this.ext_session_id,
        ),
      ),
    );
  }

  async close() {
    for (const cleanup of this.event_wait_cleanups) cleanup();
    this.event_wait_cleanups.clear();
    try {
      this.ws?.close();
    } catch {}
    if (this._prepared_extension) await this._prepared_extension.close();
    this._prepared_extension = null;
    if (this._launched) await this._launched.close();
  }

  on(event_name: ModCDPEventNameInput, listener: (...args: unknown[]) => void) {
    if (typeof event_name !== "string" && typeof event_name !== "symbol") {
      const name = normalizeModCDPName(event_name);
      this.event_schemas.set(name, event_name);
      return super.on(name, listener);
    }
    return super.on(typeof event_name === "symbol" ? event_name : normalizeModCDPName(event_name), listener);
  }

  once(event_name: ModCDPEventNameInput, listener: (...args: unknown[]) => void) {
    if (typeof event_name !== "string" && typeof event_name !== "symbol") {
      const name = normalizeModCDPName(event_name);
      this.event_schemas.set(name, event_name);
      return super.once(name, listener);
    }
    return super.once(typeof event_name === "symbol" ? event_name : normalizeModCDPName(event_name), listener);
  }

  off(event_name: ModCDPEventNameInput, listener: (...args: unknown[]) => void) {
    if (typeof event_name !== "string" && typeof event_name !== "symbol") {
      return super.off(normalizeModCDPName(event_name), listener);
    }
    return super.off(typeof event_name === "symbol" ? event_name : normalizeModCDPName(event_name), listener);
  }

  _waitForEvent(event_name: ModCDPEventNameInput, { timeout_ms = 10_000 }: { timeout_ms?: number } = {}) {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let cancel: () => void = () => {};
    let listener: (...args: unknown[]) => void = () => {};
    const promise = new Promise((resolve) => {
      const cleanup = () => {
        if (timeout != null) clearTimeout(timeout);
        timeout = null;
        this.off(event_name, listener);
        this.event_wait_cleanups.delete(cancel);
      };
      const finish = (value: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      cancel = () => finish(null);
      listener = (payload) => finish(payload || {});
      this.event_wait_cleanups.add(cancel);
      this.on(event_name, listener);
      timeout = setTimeout(() => finish(null), timeout_ms);
    });
    return { promise, cancel };
  }

  async _measurePingLatency() {
    const sentAt = Date.now();
    const pong = this._waitForEvent("Mod.pong");
    try {
      await this.send("Mod.ping", { sentAt });
      const payload = (await pong.promise) as ModCDPPongEvent | null;
      if (payload == null) return this.latency;
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
    } finally {
      pong.cancel();
    }
  }

  async _sendRaw(command: TranslatedCommand) {
    if (command.target === "direct_cdp") {
      const [step] = command.steps;
      return this._sendFrame(step.method, step.params ?? {}) as Promise<ProtocolResult>;
    }
    if (command.target === "self") {
      if (!this.self) throw new Error(`ModCDPClient self route requires a self server.`);
      this._ensureSelfEventListener();
      const [step] = command.steps;
      const cdp_session_id = (step.params as ModCDPCustomPayload | undefined)?.cdpSessionId as string | undefined;
      return await this.self.handleCommand(step.method, step.params ?? {}, cdp_session_id ?? null);
    }
    if (command.target !== "service_worker") {
      throw new Error(`Unsupported command target "${command.target}"`);
    }

    let result: ProtocolResult = {};
    let unwrap = null;
    for (const step of command.steps) {
      result = (await this._sendFrame(step.method, step.params ?? {}, this.ext_session_id)) as ProtocolResult;
      unwrap = step.unwrap ?? null;
    }
    return unwrapResponseIfNeeded(result, unwrap);
  }

  _ensureSelfEventListener() {
    if (!this.self || this.self_event_listener_registered) return;
    this.self.addEventListener?.((event, data, cdp_session_id) => {
      this._recordTargetSession(event, data, cdp_session_id);
      this.emit(event, this.event_schemas.get(event)?.parse(data) ?? data, cdp_session_id);
    });
    this.self_event_listener_registered = true;
  }

  _sendFrame(
    method: string,
    params: ProtocolParams = {},
    session_id: string | null = null,
    options: { record_raw_timing?: boolean } = {},
  ) {
    if (!this.ws) return Promise.reject(new Error("CDP websocket is not connected."));
    const id = this.next_id++;
    const started_at = Date.now();
    const message: CdpCommandFrame = { id, method, params };
    if (session_id) message.sessionId = session_id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        method,
        resolve: (value: ProtocolResult) => {
          if (options.record_raw_timing) {
            const completed_at = Date.now();
            this.last_raw_timing = {
              method,
              started_at,
              completed_at,
              duration_ms: completed_at - started_at,
            };
          }
          resolve(value);
        },
        reject,
      });
      this.ws?.send(JSON.stringify(message));
    });
  }

  _rejectAll(error: Error) {
    const pending_methods = [...this.pending.values()].map((pending) => pending.method);
    const reject_error =
      pending_methods.length === 0 ? error : new Error(`${error.message}; pending=${pending_methods.join(",")}`);
    for (const pending of this.pending.values()) pending.reject(reject_error);
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
        (event.params || {}) as RuntimeBindingCalledEvent,
        event.sessionId || null,
        this.ext_session_id,
      );
      if (u) {
        this._recordTargetSession(u.event, u.data, u.sessionId);
        this.emit(u.event, this.event_schemas.get(u.event)?.parse(u.data) ?? u.data, u.sessionId);
      }
      return;
    }
    if (event.method) {
      const data = event.params || {};
      this._recordTargetSession(event.method, data, event.sessionId || null);
      this.emit(event.method, this.event_schemas.get(event.method)?.parse(data) ?? data, event.sessionId || null);
    }
  }

  _recordTargetSession(method: string, data: unknown, session_id: string | null) {
    const event_data =
      data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    if (method === "Target.attachedToTarget") {
      const attached_session_id = typeof event_data.sessionId === "string" ? event_data.sessionId : session_id;
      const target_info =
        event_data.targetInfo && typeof event_data.targetInfo === "object"
          ? (event_data.targetInfo as Record<string, unknown>)
          : null;
      const target_id = typeof target_info?.targetId === "string" ? target_info.targetId : null;
      if (attached_session_id && target_id && target_info) {
        this.auto_target_sessions.set(target_id, attached_session_id);
        this.auto_session_targets.set(attached_session_id, target_info);
      }
    } else if (method === "Target.detachedFromTarget") {
      const detached_session_id = typeof event_data.sessionId === "string" ? event_data.sessionId : session_id;
      if (detached_session_id) {
        const target_info = this.auto_session_targets.get(detached_session_id);
        const target_id = typeof target_info?.targetId === "string" ? target_info.targetId : null;
        if (target_id) this.auto_target_sessions.delete(target_id);
        this.auto_session_targets.delete(detached_session_id);
      }
    }
  }
}

export interface ModCDPClient extends CdpAliases {}
