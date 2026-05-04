import type { z } from "zod";

import type {
  CDPModAddCustomCommandParams,
  CDPModAddCustomEventObjectParams,
  CDPModAddMiddlewareParams,
  CDPModConfigureParams,
  CDPModNamedValue,
  CDPModPingLatency,
  CDPModPongEvent,
  CDPModRoutes,
  ProtocolParams,
  ProtocolPayload,
  ProtocolResult,
  TranslatedCommand,
} from "./cdpmod.js";
import type {
  ModClickResult,
  ModElement,
  ModFillResult,
  ModFrameHop,
  ModHoverResult,
  ModNavigationResult,
  ModOpenPageParams,
  ModPage,
  ModPageEvaluateParams,
  ModPageEvaluateResult,
  ModPageGoBackParams,
  ModPageGoForwardParams,
  ModPageGotoParams,
  ModPageReloadParams,
  ModPageScreenshotParams,
  ModPageScreenshotResult,
  ModPageWaitForLoadStateParams,
  ModPageWaitForLoadStateResult,
  ModPageWaitForSelectorParams,
  ModPageWaitForSelectorResult,
  ModPageWaitForTimeoutResult,
  ModPressResult,
  ModScrollResult,
  ModSelector,
  ModTypeResult,
  ModWaitForPageParams,
} from "./replayable.js";

export type CDPModEventNameInput = string | symbol | (z.ZodType & CDPModNamedValue);
export type CDPModClientCustomCommandParams = Omit<CDPModAddCustomCommandParams, "expression"> & {
  expression?: string | null;
};
export type ModFrameOptions = "IFRAME" | "FRAME" | { assertNodeName?: "IFRAME" | "FRAME" };
export type ModWaitForPageOptions = Omit<ModWaitForPageParams, "opener"> & {
  opener?: ModPage | ModPageHandle;
};
export type ModPageGotoOptions = Omit<ModPageGotoParams, "page" | "url">;
export type ModPageReloadOptions = Omit<ModPageReloadParams, "page">;
export type ModPageGoBackOptions = Omit<ModPageGoBackParams, "page">;
export type ModPageGoForwardOptions = Omit<ModPageGoForwardParams, "page">;
export type ModPageScreenshotOptions = Omit<ModPageScreenshotParams, "page">;
export type ModPageEvaluateOptions = Omit<ModPageEvaluateParams, "page" | "frames" | "expression">;
export type ModPageWaitForSelectorOptions = Omit<ModPageWaitForSelectorParams, "page" | "frames" | "selector">;
export type ModInputScrollOptions = {
  selector?: ModSelector;
  deltaX?: number;
  deltaY: number;
};

export type CDPModClientOptions = {
  cdp_url?: string | null;
  extension_path?: string;
  routes?: CDPModRoutes;
  server?: CDPModConfigureParams | null;
  custom_commands?: CDPModClientCustomCommandParams[];
  custom_events?: CDPModAddCustomEventObjectParams[];
  custom_middlewares?: CDPModAddMiddlewareParams[];
  hydrate_aliases?: boolean;
  service_worker_url_includes?: string[];
  service_worker_url_suffixes?: string[] | null;
  trust_service_worker_target?: boolean;
  require_service_worker_target?: boolean;
  service_worker_ready_expression?: string | null;
  launch_options?: Record<string, unknown>;
  self?: {
    addEventListener?: (
      listener: (event: string, data: ProtocolPayload, cdpSessionId: string | null) => void,
    ) => unknown;
    configure?: (params: CDPModConfigureParams) => Promise<ProtocolResult>;
    handleCommand: (method: string, params?: ProtocolParams, cdpSessionId?: string | null) => Promise<ProtocolResult>;
  } | null;
};

export class ModPageHandle {
  readonly object: "mod.page";
  readonly id: string;

  constructor(client: CDPModClient, page: ModPage, frames?: ModFrameHop[]);

  get ref(): ModPage;
  get frames(): readonly ModFrameHop[];

  toJSON(): ModPage;
  frame(owner: ModSelector, options?: ModFrameOptions): ModPageHandle;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  goto(url: string, options?: ModPageGotoOptions): Promise<ModNavigationResult>;
  reload(options?: ModPageReloadOptions): Promise<ModNavigationResult>;
  goBack(options?: ModPageGoBackOptions): Promise<ModNavigationResult>;
  goForward(options?: ModPageGoForwardOptions): Promise<ModNavigationResult>;
  waitForLoadState(
    state: ModPageWaitForLoadStateParams["state"],
    options?: Omit<ModPageWaitForLoadStateParams, "page" | "state">,
  ): Promise<ModPageWaitForLoadStateResult>;
  waitForTimeout(ms: number): Promise<ModPageWaitForTimeoutResult>;
  screenshot(options?: ModPageScreenshotOptions): Promise<ModPageScreenshotResult>;
  evaluate(expression: string, options?: ModPageEvaluateOptions): Promise<ModPageEvaluateResult>;
  waitForSelector(
    selector: ModSelector,
    options?: ModPageWaitForSelectorOptions,
  ): Promise<ModPageWaitForSelectorResult>;
  query(selector: ModSelector, options?: { id?: string }): Promise<ModElement>;
  text(selector: ModSelector): Promise<string>;
  click(selector: ModSelector): Promise<ModClickResult>;
  type(selector: ModSelector, text: string): Promise<ModTypeResult>;
  hover(selector: ModSelector): Promise<ModHoverResult>;
  fill(selector: ModSelector, value: string): Promise<ModFillResult>;
  press(key: string): Promise<ModPressResult>;
  scroll(options: ModInputScrollOptions): Promise<ModScrollResult>;
  waitForPage(params: Omit<ModWaitForPageParams, "opener">): Promise<ModPageHandle>;
}

export class CDPModReplayNamespace {
  constructor(client: CDPModClient);

  openPage(params: ModOpenPageParams): Promise<ModPageHandle>;
  waitForPage(params: ModWaitForPageOptions): Promise<ModPageHandle>;
  page(page: ModPage | ModPageHandle): ModPageHandle;
}

export type CDPModCommandSpec<Params = unknown, Result = unknown> = {
  params: Params;
  result: Result;
};
export type CDPModCommandMap = Record<string, CDPModCommandSpec>;
type MethodName<TName extends string> = TName extends `${string}.${infer TMethod}` ? TMethod : never;
type DomainName<TName extends string> = TName extends `${infer TDomain}.${string}` ? TDomain : never;
type CommandsForDomain<TCommands extends CDPModCommandMap, TDomain extends string> = {
  [TName in keyof TCommands as TName extends `${TDomain}.${string}`
    ? MethodName<Extract<TName, string>>
    : never]: undefined extends TCommands[TName]["params"]
    ? (params?: TCommands[TName]["params"]) => Promise<TCommands[TName]["result"]>
    : (params: TCommands[TName]["params"]) => Promise<TCommands[TName]["result"]>;
};
export type CDPModClientInstance<TCommands extends CDPModCommandMap = Record<never, never>> = CDPModClient & {
  [TDomain in DomainName<Extract<keyof TCommands, string>>]: CommandsForDomain<TCommands, TDomain>;
};

export class CDPModClient {
  cdp_url: string | null;
  extension_path: string;
  routes: CDPModRoutes;
  server: CDPModConfigureParams | null;
  launch_options: Record<string, unknown>;
  custom_commands: CDPModClientCustomCommandParams[];
  custom_events: CDPModAddCustomEventObjectParams[];
  custom_middlewares: CDPModAddMiddlewareParams[];
  hydrate_aliases: boolean;
  service_worker_url_includes: string[];
  service_worker_url_suffixes: string[] | null;
  trust_service_worker_target: boolean;
  require_service_worker_target: boolean;
  service_worker_ready_expression: string | null;
  ws: unknown | null;
  self: CDPModClientOptions["self"];
  ext_session_id: string | null;
  ext_target_id: string | null;
  extension_id: string | null;
  latency: CDPModPingLatency | null;
  connect_timing: Record<string, unknown> | null;
  last_command_timing: Record<string, unknown> | null;
  last_raw_timing: Record<string, unknown> | null;
  refs: CDPModReplayNamespace;
  _cdp: {
    send: (method: string, params?: ProtocolParams, sessionId?: string | null) => Promise<ProtocolResult>;
    on: (eventName: string | symbol, listener: (...args: unknown[]) => void) => CDPModClient;
    once: (eventName: string | symbol, listener: (...args: unknown[]) => void) => CDPModClient;
  };

  constructor(options?: CDPModClientOptions);

  connect(): Promise<this>;
  send(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
  on(eventName: CDPModEventNameInput, listener: (...args: unknown[]) => void): this;
  once(eventName: CDPModEventNameInput, listener: (...args: unknown[]) => void): this;
  off(eventName: CDPModEventNameInput, listener: (...args: unknown[]) => void): this;
  _waitForEvent(
    eventName: CDPModEventNameInput,
    options?: { timeout_ms?: number },
  ): { promise: Promise<unknown | CDPModPongEvent | null>; cancel: () => void };
  _sendRaw(command: TranslatedCommand): Promise<ProtocolResult>;
  _sendFrame(
    method: string,
    params?: ProtocolParams,
    sessionId?: string | null,
    options?: { record_raw_timing?: boolean },
  ): Promise<ProtocolResult>;
}
