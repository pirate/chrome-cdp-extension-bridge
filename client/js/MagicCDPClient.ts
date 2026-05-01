// MagicCDPClient (JS): importable, no CLI, no demo code.
//
// Constructor parameter names match across JS / Python / Go ports:
//   cdp_url           upstream CDP URL (string, default null -> autolaunch)
//   extension_path    extension directory (string, default ../../extension)
//   routes            client-side routing dict (default { "Magic.*": "service_worker",
//                       "Custom.*": "service_worker", "*.*": "direct_cdp" })
//   server            { loopback_cdp_url?, routes? } passed to MagicCDPServer.configure
//   launch_options    forwarded to launcher.launchChrome when autolaunching
//
// Public methods: connect, send(method, params), on(event, handler), close.

import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { launchChrome } from "../../bridge/launcher.js";
import { injectExtensionIfNeeded } from "../../bridge/injector.js";
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
import { CdpEventFrameSchema, CdpResponseFrameSchema } from "../../types/magic.js";
import { events } from "../../types/zod.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXTENSION_PATH = path.resolve(HERE, "..", "..", "extension");

type PendingCommand = {
  method: string;
  resolve: (value: ProtocolResult) => void;
  reject: (error: Error) => void;
};
type ClientOptions = {
  cdp_url?: string | null;
  extension_path?: string;
  routes?: MagicRoutes;
  server?: MagicConfigureParams | null;
  launch_options?: Parameters<typeof launchChrome>[0];
};

async function webSocketUrlFor(endpoint: string, name = "cdp_url") {
  if (/^wss?:\/\//i.test(endpoint)) return endpoint;
  const response = await fetch(`${endpoint}/json/version`);
  if (!response.ok) throw new Error(`GET ${endpoint}/json/version -> ${response.status}`);
  const { webSocketDebuggerUrl } = await response.json();
  if (!webSocketDebuggerUrl) throw new Error(`${name} HTTP discovery returned no webSocketDebuggerUrl`);
  return webSocketDebuggerUrl;
}

export class MagicCDPClient extends EventEmitter {
  cdp_url: string | null;
  extension_path: string;
  routes: MagicRoutes;
  server: MagicConfigureParams | null;
  launch_options: Parameters<typeof launchChrome>[0];
  ws: WebSocket | null;
  next_id: number;
  pending: Map<number, PendingCommand>;
  ext_session_id: string | null;
  ext_target_id: string | null;
  extension_id: string | null;
  latency: MagicPingLatency | null;
  _launched: Awaited<ReturnType<typeof launchChrome>> | null;

  constructor({
    cdp_url = null,
    extension_path = DEFAULT_EXTENSION_PATH,
    routes = DEFAULT_CLIENT_ROUTES,
    server = null,
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
    this._launched = null;
  }

  async connect() {
    if (!this.cdp_url) {
      this._launched = await launchChrome(this.launch_options);
      this.cdp_url = this._launched.wsUrl;
    }
    const inputCdpUrl = this.cdp_url;
    this.cdp_url = await webSocketUrlFor(this.cdp_url);
    if (this.server?.loopback_cdp_url) {
      const loopbackUrl = this.server.loopback_cdp_url;
      if (loopbackUrl === inputCdpUrl || loopbackUrl === this.cdp_url) {
        this.server = { ...this.server, loopback_cdp_url: this.cdp_url };
      }
    }

    this.ws = new WebSocket(this.cdp_url);
    this.ws.addEventListener("message", (event) => this._onMessage(event.data));
    this.ws.addEventListener("close", () => this._rejectAll(new Error("CDP websocket closed")));
    this.ws.addEventListener("error", () => this._rejectAll(new Error(`CDP websocket error`)));
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });

    const ext = await injectExtensionIfNeeded({
      send: (method, params, sessionId) => this._sendFrame(method, params, sessionId),
      extensionPath: this.extension_path,
    });
    this.extension_id = ext.extensionId;
    this.ext_target_id = ext.targetId;
    this.ext_session_id = ext.sessionId;
    await this._sendFrame("Runtime.enable", {}, this.ext_session_id);
    await this._sendFrame("Runtime.addBinding", { name: bindingNameFor("Magic.pong") }, this.ext_session_id);

    if (this.server) {
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

  async send(method: string, params: ProtocolParams = {}) {
    return this._sendRaw(
      wrapCommandIfNeeded(method, params, {
        routes: this.routes,
        cdpSessionId: this.ext_session_id,
      }),
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
      this.ws?.send(JSON.stringify(message));
    });
  }

  _rejectAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  _onMessage(buf: string) {
    let msg: CdpResponseFrame | CdpEventFrame;
    try {
      const parsed = JSON.parse(buf);
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
      if (u) this.emit(u.event, u.data);
      return;
    }
    if (event.method) this.emit(event.method, event.params || {}, event.sessionId || null);
  }
}
