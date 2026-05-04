import type {
  ModBindPageParams,
  ModClickElementParams,
  ModClickParams,
  ModElement,
  ModFillElementParams,
  ModFillParams,
  ModElementTextParams,
  ModFrameHop,
  ModHoverElementParams,
  ModHoverParams,
  ModLoadState,
  ModNavigationResult,
  ModOpenPageParams,
  ModPageEvaluateParams,
  ModPageGoBackParams,
  ModPageGoForwardParams,
  ModPageGotoParams,
  ModPageReloadParams,
  ModPageScreenshotParams,
  ModPageWaitForLoadStateParams,
  ModPageWaitForSelectorParams,
  ModPageWaitForTimeoutParams,
  ModPressElementParams,
  ModPressParams,
  ModQueryElementParams,
  ModResolveContextParams,
  ModScrollElementParams,
  ModScrollParams,
  ModSelector,
  ModSelectorTargetParams,
  ModTextParams,
  ModTypeElementParams,
  ModTypeParams,
  ModWaitForPageParams,
} from "../types/replayable.js";

type CdpMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
};

type CdpCall = (
  method: string,
  params?: Record<string, unknown>,
  sessionId?: string | null,
  timeoutMs?: number,
) => Promise<any>;

type TargetInfoLike = {
  targetId: string;
  type: string;
  url?: string;
  title?: string;
  openerId?: string;
  canAccessOpener?: boolean;
  openerFrameId?: string;
  parentFrameId?: string;
  browserContextId?: string;
};

type ReplayOnlyTargetRecord = {
  targetId: string;
  createdSeq: number;
  destroyedSeq?: number;
  latest: TargetInfoLike;
  urlHistory: Array<{ seq: number; url: string }>;
};

type DomNode = {
  nodeId?: number;
  parentId?: number;
  backendNodeId?: number;
  nodeType?: number;
  nodeName?: string;
  localName?: string;
  nodeValue?: string;
  shadowRootType?: string;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
  contentDocument?: DomNode;
  frameId?: string;
};

type ResolvedContext = {
  call: CdpCall;
  targetInfo: TargetInfoLike;
  pageSessionId: string;
  sessionId: string;
  root: DomNode;
  frameDepth: number;
  cleanupSessionIds: string[];
};

const MOUSE_MOVE = "mouseMoved";
const MOUSE_DOWN = "mousePressed";
const MOUSE_UP = "mouseReleased";
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;
const POPUP_OPENING_MOUSE_UP_TIMEOUT_MS = 1_000;

const replayOnlyTargetJournals = new Map<string, ReplayOnlyTargetJournal>();

function getReplayOnlyTargetJournal(loopbackCdpUrl: string): ReplayOnlyTargetJournal {
  let journal = replayOnlyTargetJournals.get(loopbackCdpUrl);
  if (!journal) {
    journal = new ReplayOnlyTargetJournal(loopbackCdpUrl);
    replayOnlyTargetJournals.set(loopbackCdpUrl, journal);
  }
  return journal;
}

function parseOpenPageParams(raw: ModOpenPageParams): ModOpenPageParams {
  const params = record(raw, "Mod.Page.open");
  return {
    id: optionalString(params.id, "Mod.Page.open id"),
    url: requiredString(params.url, "Mod.Page.open url"),
  };
}

function parseBindPageParams(raw: ModBindPageParams): ModBindPageParams {
  const params = record(raw, "Mod.Page.bind");
  return {
    page: requiredPage(params.page, "Mod.Page.bind page"),
    targetId: requiredString(params.targetId, "Mod.Page.bind targetId"),
  };
}

function parseWaitForPageParams(raw: ModWaitForPageParams): ModWaitForPageParams {
  const params = record(raw, "Mod.Page.waitFor");
  return {
    id: optionalString(params.id, "Mod.Page.waitFor id"),
    opener: params.opener === undefined ? undefined : requiredPage(params.opener, "Mod.Page.waitFor opener"),
    expected: optionalPageExpectation(params.expected, "Mod.Page.waitFor expected"),
    timeoutMs: positiveInt(params.timeoutMs, 10_000, "Mod.Page.waitFor timeoutMs"),
  };
}

function parsePageGotoParams(raw: ModPageGotoParams): ModPageGotoParams {
  const params = record(raw, "Mod.Page.goto");
  return {
    page: requiredPage(params.page, "Mod.Page.goto page"),
    url: requiredString(params.url, "Mod.Page.goto url"),
    waitUntil: optionalLoadState(params.waitUntil, "Mod.Page.goto waitUntil"),
    timeoutMs: nonnegativeInt(params.timeoutMs, 30_000, "Mod.Page.goto timeoutMs"),
  };
}

function parsePageReloadParams(raw: ModPageReloadParams): ModPageReloadParams {
  const params = record(raw, "Mod.Page.reload");
  return {
    page: requiredPage(params.page, "Mod.Page.reload page"),
    waitUntil: optionalLoadState(params.waitUntil, "Mod.Page.reload waitUntil"),
    timeoutMs: nonnegativeInt(params.timeoutMs, 30_000, "Mod.Page.reload timeoutMs"),
    ignoreCache: typeof params.ignoreCache === "boolean" ? params.ignoreCache : undefined,
  };
}

function parsePageGoBackParams(raw: ModPageGoBackParams): ModPageGoBackParams {
  const params = record(raw, "Mod.Page.goBack");
  return {
    page: requiredPage(params.page, "Mod.Page.goBack page"),
    waitUntil: optionalLoadState(params.waitUntil, "Mod.Page.goBack waitUntil"),
    timeoutMs: nonnegativeInt(params.timeoutMs, 30_000, "Mod.Page.goBack timeoutMs"),
  };
}

function parsePageGoForwardParams(raw: ModPageGoForwardParams): ModPageGoForwardParams {
  const params = record(raw, "Mod.Page.goForward");
  return {
    page: requiredPage(params.page, "Mod.Page.goForward page"),
    waitUntil: optionalLoadState(params.waitUntil, "Mod.Page.goForward waitUntil"),
    timeoutMs: nonnegativeInt(params.timeoutMs, 30_000, "Mod.Page.goForward timeoutMs"),
  };
}

function parsePageWaitForLoadStateParams(raw: ModPageWaitForLoadStateParams): ModPageWaitForLoadStateParams {
  const params = record(raw, "Mod.Page.waitForLoadState");
  const state = optionalLoadState(params.state, "Mod.Page.waitForLoadState state");
  if (!state) throw new Error("Mod.Page.waitForLoadState state must be a load state.");
  return {
    page: requiredPage(params.page, "Mod.Page.waitForLoadState page"),
    state,
    timeoutMs: nonnegativeInt(params.timeoutMs, 30_000, "Mod.Page.waitForLoadState timeoutMs"),
  };
}

function parsePageWaitForTimeoutParams(raw: ModPageWaitForTimeoutParams): ModPageWaitForTimeoutParams {
  const params = record(raw, "Mod.Page.waitForTimeout");
  return {
    page: requiredPage(params.page, "Mod.Page.waitForTimeout page"),
    ms: nonnegativeInt(params.ms, undefined, "Mod.Page.waitForTimeout ms"),
  };
}

function parsePageScreenshotParams(raw: ModPageScreenshotParams): ModPageScreenshotParams {
  const params = record(raw, "Mod.Page.screenshot");
  const type = params.type === undefined ? "png" : requiredScreenshotType(params.type, "Mod.Page.screenshot type");
  if (params.quality !== undefined && type !== "jpeg" && type !== "webp") {
    throw new Error("Mod.Page.screenshot quality is only supported for jpeg or webp.");
  }
  if (params.clip !== undefined && params.fullPage === true) {
    throw new Error("Mod.Page.screenshot clip cannot be used together with fullPage.");
  }
  return {
    page: requiredPage(params.page, "Mod.Page.screenshot page"),
    fullPage: typeof params.fullPage === "boolean" ? params.fullPage : undefined,
    clip: params.clip === undefined ? undefined : requiredClip(params.clip, "Mod.Page.screenshot clip"),
    type,
    quality:
      params.quality === undefined ? undefined : boundedInt(params.quality, 0, 100, "Mod.Page.screenshot quality"),
    timeoutMs: nonnegativeInt(params.timeoutMs, 30_000, "Mod.Page.screenshot timeoutMs"),
  };
}

function parsePageEvaluateParams(raw: ModPageEvaluateParams): ModPageEvaluateParams {
  const params = record(raw, "Mod.Page.evaluate");
  return {
    page: requiredPage(params.page, "Mod.Page.evaluate page"),
    frames: requiredFrames(params.frames, "Mod.Page.evaluate frames"),
    expression: requiredString(params.expression, "Mod.Page.evaluate expression"),
    arg: params.arg,
    awaitPromise: typeof params.awaitPromise === "boolean" ? params.awaitPromise : true,
    timeoutMs:
      params.timeoutMs === undefined
        ? undefined
        : nonnegativeInt(params.timeoutMs, undefined, "Mod.Page.evaluate timeoutMs"),
  };
}

function parsePageWaitForSelectorParams(raw: ModPageWaitForSelectorParams): ModPageWaitForSelectorParams {
  const params = record(raw, "Mod.Page.waitForSelector");
  return {
    id: optionalString(params.id, "Mod.Page.waitForSelector id"),
    page: requiredPage(params.page, "Mod.Page.waitForSelector page"),
    frames: requiredFrames(params.frames, "Mod.Page.waitForSelector frames"),
    selector: requiredSelector(params.selector, "Mod.Page.waitForSelector selector"),
    state: optionalSelectorState(params.state, "Mod.Page.waitForSelector state") ?? "visible",
    timeoutMs: nonnegativeInt(params.timeoutMs, 30_000, "Mod.Page.waitForSelector timeoutMs"),
  };
}

function parseQueryElementParams(raw: ModQueryElementParams): ModQueryElementParams {
  const params = record(raw, "Mod.DOM.queryElement");
  return {
    id: optionalString(params.id, "Mod.DOM.queryElement id"),
    ...parseSelectorTargetParams(params, "Mod.DOM.queryElement"),
  };
}

function parseTextParams(raw: ModTextParams): ModTextParams {
  return parseSelectorTargetParams(raw, "Mod.DOM.text");
}

function parseClickParams(raw: ModClickParams): ModClickParams {
  return parseSelectorTargetParams(raw, "Mod.Input.click");
}

function parseTypeParams(raw: ModTypeParams): ModTypeParams {
  const params = record(raw, "Mod.Input.type");
  return {
    ...parseSelectorTargetParams(params, "Mod.Input.type"),
    text: requiredString(params.text, "Mod.Input.type text"),
  };
}

function parseHoverParams(raw: ModHoverParams): ModHoverParams {
  return parseSelectorTargetParams(raw, "Mod.Input.hover");
}

function parseFillParams(raw: ModFillParams): ModFillParams {
  const params = record(raw, "Mod.Input.fill");
  return {
    ...parseSelectorTargetParams(params, "Mod.Input.fill"),
    value: requiredString(params.value, "Mod.Input.fill value"),
  };
}

function parsePressParams(raw: ModPressParams): ModPressParams {
  const params = record(raw, "Mod.Input.press");
  return {
    page: requiredPage(params.page, "Mod.Input.press page"),
    frames: requiredFrames(params.frames, "Mod.Input.press frames"),
    key: requiredString(params.key, "Mod.Input.press key"),
  };
}

function parseScrollParams(raw: ModScrollParams): ModScrollParams {
  const params = record(raw, "Mod.Input.scroll");
  return {
    page: requiredPage(params.page, "Mod.Input.scroll page"),
    frames: requiredFrames(params.frames, "Mod.Input.scroll frames"),
    selector:
      params.selector === undefined ? undefined : requiredSelector(params.selector, "Mod.Input.scroll selector"),
    deltaX: typeof params.deltaX === "number" ? params.deltaX : 0,
    deltaY: typeof params.deltaY === "number" ? params.deltaY : 0,
  };
}

function parseSelectorTargetParams(raw: unknown, label: string): ModSelectorTargetParams {
  const params = record(raw, label);
  return {
    page: requiredPage(params.page, `${label} page`),
    frames: requiredFrames(params.frames, `${label} frames`),
    selector: requiredSelector(params.selector, `${label} selector`),
  };
}

function parseResolveContextParams(raw: ModResolveContextParams): ModResolveContextParams {
  const params = record(raw, "Mod.DOM.resolveContext");
  return {
    page: requiredPage(params.page, "Mod.DOM.resolveContext page"),
    frames: requiredFrames(params.frames, "Mod.DOM.resolveContext frames"),
  };
}

function parseElementTextParams(raw: ModElementTextParams): ModElementTextParams {
  return { element: requiredElement(record(raw, "Mod.DOM.elementText").element, "Mod.DOM.elementText element") };
}

function parseClickElementParams(raw: ModClickElementParams): ModClickElementParams {
  return { element: requiredElement(record(raw, "Mod.Input.clickElement").element, "Mod.Input.clickElement element") };
}

function parseTypeElementParams(raw: ModTypeElementParams): ModTypeElementParams {
  const params = record(raw, "Mod.Input.typeElement");
  return {
    element: requiredElement(params.element, "Mod.Input.typeElement element"),
    text: requiredString(params.text, "Mod.Input.typeElement text"),
  };
}

function parseHoverElementParams(raw: ModHoverElementParams): ModHoverElementParams {
  return { element: requiredElement(record(raw, "Mod.Input.hoverElement").element, "Mod.Input.hoverElement element") };
}

function parseFillElementParams(raw: ModFillElementParams): ModFillElementParams {
  const params = record(raw, "Mod.Input.fillElement");
  return {
    element: requiredElement(params.element, "Mod.Input.fillElement element"),
    value: requiredString(params.value, "Mod.Input.fillElement value"),
  };
}

function parsePressElementParams(raw: ModPressElementParams): ModPressElementParams {
  const params = record(raw, "Mod.Input.pressElement");
  return {
    element: requiredElement(params.element, "Mod.Input.pressElement element"),
    key: requiredString(params.key, "Mod.Input.pressElement key"),
  };
}

function parseScrollElementParams(raw: ModScrollElementParams): ModScrollElementParams {
  const params = record(raw, "Mod.Input.scrollElement");
  return {
    element: requiredElement(params.element, "Mod.Input.scrollElement element"),
    deltaX: typeof params.deltaX === "number" ? params.deltaX : 0,
    deltaY: typeof params.deltaY === "number" ? params.deltaY : 0,
  };
}

function requiredElement(value: unknown, label: string): ModElement {
  const obj = record(value, label);
  return {
    object: "mod.element",
    id: typeof obj.id === "string" ? obj.id : undefined,
    page: requiredPage(obj.page, `${label}.page`),
    frames: requiredFrames(obj.frames, `${label}.frames`),
    selector: requiredSelector(obj.selector, `${label}.selector`),
    fingerprint: typeof obj.fingerprint === "object" && obj.fingerprint !== null ? (obj.fingerprint as any) : undefined,
  };
}

function requiredPage(value: unknown, label: string): ModElement["page"] {
  const obj = record(value, label);
  if (obj.object !== "mod.page" || typeof obj.id !== "string" || !obj.id) {
    throw new Error(`${label} must be a ModPage.`);
  }
  return { object: "mod.page", id: obj.id };
}

function requiredFrames(value: unknown, label: string): ModFrameHop[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((hop, index) => {
    const obj = record(hop, `${label}[${index}]`);
    return {
      owner: requiredSelector(obj.owner, `${label}[${index}].owner`),
      assertNodeName: obj.assertNodeName === "FRAME" || obj.assertNodeName === "IFRAME" ? obj.assertNodeName : "IFRAME",
    };
  });
}

function requiredSelector(value: unknown, label: string): ModSelector {
  const obj = record(value, label);
  if (obj.kind === "xpath" && typeof obj.xpath === "string") return { kind: "xpath", xpath: obj.xpath };
  if (obj.kind === "css" && typeof obj.selector === "string") return { kind: "css", selector: obj.selector };
  if (obj.kind === "role" && typeof obj.role === "string") {
    return {
      kind: "role",
      role: obj.role,
      name: typeof obj.name === "string" ? obj.name : undefined,
      exact: typeof obj.exact === "boolean" ? obj.exact : true,
    };
  }
  if (obj.kind === "text" && typeof obj.text === "string") {
    return {
      kind: "text",
      text: obj.text,
      exact: typeof obj.exact === "boolean" ? obj.exact : true,
    };
  }
  throw new Error(`${label} must be a ModSelector.`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function positiveInt(value: unknown, defaultValue: number | undefined, label: string): number {
  const parsed = value === undefined ? defaultValue : value;
  if (!Number.isInteger(parsed) || Number(parsed) <= 0) throw new Error(`${label} must be a positive integer.`);
  return Number(parsed);
}

function nonnegativeInt(value: unknown, defaultValue: number | undefined, label: string): number {
  const parsed = value === undefined ? defaultValue : value;
  if (!Number.isInteger(parsed) || Number(parsed) < 0) throw new Error(`${label} must be a non-negative integer.`);
  return Number(parsed);
}

function boundedInt(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return Number(value);
}

function optionalLoadState(value: unknown, label: string): ModLoadState | undefined {
  if (value === undefined) return undefined;
  if (value === "load" || value === "domcontentloaded" || value === "networkidle") return value;
  throw new Error(`${label} must be load, domcontentloaded, or networkidle.`);
}

function optionalSelectorState(value: unknown, label: string): ModPageWaitForSelectorParams["state"] | undefined {
  if (value === undefined) return undefined;
  if (value === "attached" || value === "detached" || value === "visible" || value === "hidden") return value;
  throw new Error(`${label} must be attached, detached, visible, or hidden.`);
}

function requiredScreenshotType(value: unknown, label: string): ModPageScreenshotParams["type"] {
  if (value === "png" || value === "jpeg" || value === "webp") return value;
  throw new Error(`${label} must be png, jpeg, or webp.`);
}

function optionalPageExpectation(value: unknown, label: string): ModWaitForPageParams["expected"] {
  if (value === undefined) return undefined;
  const obj = record(value, label);
  return {
    url: optionalString(obj.url, `${label}.url`),
    urlIncludes: optionalString(obj.urlIncludes, `${label}.urlIncludes`),
  };
}

function requiredClip(value: unknown, label: string): NonNullable<ModPageScreenshotParams["clip"]> {
  const obj = record(value, label);
  return {
    x: requiredNumber(obj.x, `${label}.x`),
    y: requiredNumber(obj.y, `${label}.y`),
    width: positiveNumber(obj.width, `${label}.width`),
    height: positiveNumber(obj.height, `${label}.height`),
    scale: obj.scale === undefined ? undefined : positiveNumber(obj.scale, `${label}.scale`),
  };
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`);
  return value;
}

function positiveNumber(value: unknown, label: string): number {
  const parsed = requiredNumber(value, label);
  if (parsed <= 0) throw new Error(`${label} must be positive.`);
  return parsed;
}

/**
 * Private replayability-only target journal.
 *
 * This is intentionally not exported and intentionally does not expose sessions,
 * DOM nodes, frame ownership, or attach helpers. It records only the provenance
 * needed to bind replayable ModPage IDs to live Chrome targets.
 *
 * Do not use this as operational truth. Every CDPMod command must still ask CDP
 * for live targets/DOM/frame state before acting; this journal may only bind a
 * replayable page ID to the live target that Chrome reports right now.
 */
class ReplayOnlyTargetJournal {
  private ws: WebSocket | null = null;
  private startPromise: Promise<void> | null = null;
  private nextId = 1;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; method: string }
  >();
  private readonly records = new Map<string, ReplayOnlyTargetRecord>();
  private readonly modPages = new Map<string, { targetId: string; boundSeq: number }>();

  constructor(private readonly loopbackCdpUrl: string) {}

  async ensureStarted(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null;
      });
    }
    await this.startPromise;
  }

  nextSeqSnapshot(): number {
    return this.seq;
  }

  createPageRef(id?: string) {
    const pageId = id || `page_${this.modPages.size + 1}`;
    return { object: "mod.page" as const, id: pageId };
  }

  bindModPage(pageId: string, targetId: string): void {
    const existing = this.modPages.get(pageId);
    if (existing && existing.targetId !== targetId) {
      throw new Error(`ModPage id "${pageId}" is already bound to a different live target.`);
    }
    this.modPages.set(pageId, { targetId, boundSeq: ++this.seq });
  }

  targetForModPage(pageId: string, liveTargets: TargetInfoLike[]): TargetInfoLike {
    const binding = this.modPages.get(pageId);
    if (!binding) {
      throw new Error(`Unknown ModPage id "${pageId}". Pages must be created or bound by CDPMod before use.`);
    }
    const target = liveTargets.find(
      (candidate) => candidate.targetId === binding.targetId && candidate.type === "page",
    );
    if (!target) throw new Error(`ModPage id "${pageId}" no longer has a live page target.`);
    return target;
  }

  isModPageBoundToTarget(targetId: string): boolean {
    return [...this.modPages.values()].some((binding) => binding.targetId === targetId);
  }

  createdAfter(targetId: string, seq: number): boolean {
    return (this.records.get(targetId)?.createdSeq ?? Number.MAX_SAFE_INTEGER) > seq;
  }

  private async start(): Promise<void> {
    this.ws = await openCDPSocket(this.loopbackCdpUrl);
    this.ws.addEventListener("message", (event) => this.onMessage(event));
    this.ws.addEventListener("close", () => this.onClose());
    this.ws.addEventListener("error", () => this.onClose());

    await this.send("Target.setDiscoverTargets", { discover: true });
    const snapshot = await this.send("Target.getTargets");
    for (const targetInfo of snapshot.targetInfos || []) this.upsertTarget(targetInfo);
  }

  private onMessage(event: MessageEvent): void {
    const data = typeof event.data === "string" ? event.data : String(event.data);
    const msg = JSON.parse(data) as CdpMessage;
    if (typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || `${pending.method} failed`));
      else pending.resolve(msg.result || {});
      return;
    }

    if (msg.method === "Target.targetCreated" || msg.method === "Target.targetInfoChanged") {
      this.upsertTarget((msg.params as { targetInfo?: TargetInfoLike } | undefined)?.targetInfo);
    } else if (msg.method === "Target.targetDestroyed") {
      const targetId = (msg.params as { targetId?: string } | undefined)?.targetId;
      if (targetId) this.markDestroyed(targetId);
    }
  }

  private onClose(): void {
    for (const [id, pending] of this.pending.entries()) {
      pending.reject(new Error(`${pending.method} failed because the replay-only target journal socket closed.`));
      this.pending.delete(id);
    }
    this.ws = null;
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Replay-only target journal CDP socket is not open."));
    }
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
  }

  private upsertTarget(targetInfo: TargetInfoLike | undefined): void {
    if (!targetInfo?.targetId) return;
    const existing = this.records.get(targetInfo.targetId);
    const record =
      existing ??
      ({
        targetId: targetInfo.targetId,
        createdSeq: ++this.seq,
        latest: targetInfo,
        urlHistory: [],
      } satisfies ReplayOnlyTargetRecord);

    record.latest = { ...record.latest, ...targetInfo };
    record.destroyedSeq = undefined;

    const url = String(targetInfo.url ?? "");
    const lastUrl = record.urlHistory.at(-1)?.url;
    if (url && url !== lastUrl) record.urlHistory.push({ seq: ++this.seq, url });
    this.records.set(record.targetId, record);
  }

  private markDestroyed(targetId: string): void {
    const record = this.records.get(targetId);
    if (!record) return;
    record.destroyedSeq = ++this.seq;
  }
}

export function registerReplayableBuiltins(CDPModServer: any, _globalScope: typeof globalThis = globalThis) {
  CDPModServer.addBuiltinCommand({
    name: "Mod.Page.open",
    handler: async (rawParams: ModOpenPageParams = {} as ModOpenPageParams) => {
      const params = parseOpenPageParams(rawParams);
      return withCdp(CDPModServer, async ({ call, journal }) => {
        const page = journal.createPageRef(params.id);
        const { targetId } = await call("Target.createTarget", { url: params.url });
        await waitForPageTarget(call, targetId, params.url);
        journal.bindModPage(page.id, targetId);
        return { page };
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Page.bind",
    handler: async (rawParams: ModBindPageParams = {} as ModBindPageParams) => {
      const params = parseBindPageParams(rawParams);
      return withCdp(CDPModServer, async ({ call, journal }) => {
        const target = (await livePageTargets(call)).find((candidate) => candidate.targetId === params.targetId);
        if (!target) throw new Error(`Mod.Page.bind target ${params.targetId} is not a live page target.`);
        journal.bindModPage(params.page.id, params.targetId);
        return { page: params.page };
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Page.waitFor",
    handler: async (rawParams: ModWaitForPageParams = {} as ModWaitForPageParams) => {
      const params = parseWaitForPageParams(rawParams);
      return withCdp(CDPModServer, async ({ call, journal }) => {
        const deadline = Date.now() + params.timeoutMs;
        const startSeq = journal.nextSeqSnapshot();
        const baseline = new Set((await livePageTargets(call)).map((target) => target.targetId));
        const page = journal.createPageRef(params.id);

        while (Date.now() < deadline) {
          const targets = await livePageTargets(call);
          const openerTarget = params.opener ? journal.targetForModPage(params.opener.id, targets) : null;
          const candidates = targets.filter((target) => {
            if (journal.isModPageBoundToTarget(target.targetId)) return false;
            if (baseline.has(target.targetId) && !journal.createdAfter(target.targetId, startSeq)) return false;
            if (openerTarget) {
              if (target.openerId !== openerTarget.targetId) return false;
              if (target.canAccessOpener === false) return false;
            }
            return pageMatchesExpectation(target, params.expected);
          });
          if (candidates.length === 1) {
            journal.bindModPage(page.id, candidates[0].targetId);
            return { page };
          }
          if (candidates.length > 1) {
            throw new Error(`Mod.Page.waitFor expected exactly one new page, found ${candidates.length}.`);
          }
          await sleep(100);
        }
        throw new Error(`Mod.Page.waitFor timed out after ${params.timeoutMs}ms.`);
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Page.goto",
    handler: async (rawParams: ModPageGotoParams = {} as ModPageGotoParams) => {
      const params = parsePageGotoParams(rawParams);
      assertSupportedLoadState(params.waitUntil);
      return withPageSession(CDPModServer, params.page, async ({ call, pageSessionId }) => {
        await call("Page.enable", {}, pageSessionId).catch(() => {});
        const navigation = await call("Page.navigate", { url: params.url }, pageSessionId);
        if (typeof navigation.errorText === "string" && navigation.errorText.length > 0) {
          throw new Error(`Mod.Page.goto failed: ${navigation.errorText}`);
        }
        if (params.waitUntil) await waitForLoadState(call, pageSessionId, params.waitUntil, params.timeoutMs);
        return navigationResult(params.page, await currentPageUrl(call, pageSessionId));
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Page.reload",
    handler: async (rawParams: ModPageReloadParams = {} as ModPageReloadParams) => {
      const params = parsePageReloadParams(rawParams);
      assertSupportedLoadState(params.waitUntil);
      return withPageSession(CDPModServer, params.page, async ({ call, pageSessionId }) => {
        await call("Page.enable", {}, pageSessionId).catch(() => {});
        await call("Page.reload", { ignoreCache: params.ignoreCache ?? false }, pageSessionId);
        if (params.waitUntil) await waitForLoadState(call, pageSessionId, params.waitUntil, params.timeoutMs);
        return navigationResult(params.page, await currentPageUrl(call, pageSessionId));
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Page.goBack",
    handler: async (rawParams: ModPageGoBackParams = {} as ModPageGoBackParams) => {
      const params = parsePageGoBackParams(rawParams);
      assertSupportedLoadState(params.waitUntil);
      return withPageSession(CDPModServer, params.page, async ({ call, pageSessionId }) => {
        const entry = await adjacentHistoryEntry(call, pageSessionId, -1, "Mod.Page.goBack");
        await call("Page.navigateToHistoryEntry", { entryId: entry.id }, pageSessionId);
        if (params.waitUntil) await waitForLoadState(call, pageSessionId, params.waitUntil, params.timeoutMs);
        return navigationResult(params.page, await currentPageUrl(call, pageSessionId, entry.url));
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Page.goForward",
    handler: async (rawParams: ModPageGoForwardParams = {} as ModPageGoForwardParams) => {
      const params = parsePageGoForwardParams(rawParams);
      assertSupportedLoadState(params.waitUntil);
      return withPageSession(CDPModServer, params.page, async ({ call, pageSessionId }) => {
        const entry = await adjacentHistoryEntry(call, pageSessionId, 1, "Mod.Page.goForward");
        await call("Page.navigateToHistoryEntry", { entryId: entry.id }, pageSessionId);
        if (params.waitUntil) await waitForLoadState(call, pageSessionId, params.waitUntil, params.timeoutMs);
        return navigationResult(params.page, await currentPageUrl(call, pageSessionId, entry.url));
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Page.waitForLoadState",
    handler: async (rawParams: ModPageWaitForLoadStateParams = {} as ModPageWaitForLoadStateParams) => {
      const params = parsePageWaitForLoadStateParams(rawParams);
      assertSupportedLoadState(params.state);
      return withPageSession(CDPModServer, params.page, async ({ call, pageSessionId }) => {
        await waitForLoadState(call, pageSessionId, params.state, params.timeoutMs);
        return { page: params.page, state: params.state };
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Page.waitForTimeout",
    handler: async (rawParams: ModPageWaitForTimeoutParams = {} as ModPageWaitForTimeoutParams) => {
      const params = parsePageWaitForTimeoutParams(rawParams);
      await sleep(params.ms);
      return { page: params.page, ms: params.ms };
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Page.screenshot",
    handler: async (rawParams: ModPageScreenshotParams = {} as ModPageScreenshotParams) => {
      const params = parsePageScreenshotParams(rawParams);
      return withPageSession(CDPModServer, params.page, async ({ call, pageSessionId }) => {
        const result = await call(
          "Page.captureScreenshot",
          {
            format: params.type,
            captureBeyondViewport: params.fullPage === true,
            ...(params.quality === undefined ? {} : { quality: params.quality }),
            ...(params.clip === undefined ? {} : { clip: params.clip }),
          },
          pageSessionId,
          params.timeoutMs,
        );
        if (typeof result.data !== "string") throw new Error("Page.captureScreenshot returned no data.");
        return { page: params.page, base64: result.data, mimeType: mimeTypeForScreenshot(params.type) };
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Page.evaluate",
    handler: async (rawParams: ModPageEvaluateParams = {} as ModPageEvaluateParams) => {
      const params = parsePageEvaluateParams(rawParams);
      return withResolvedContext(CDPModServer, params, async ({ call, sessionId, root }) => ({
        value: await evaluateInDocumentContext(call, sessionId, root, params.expression, params.arg, {
          awaitPromise: params.awaitPromise,
          timeoutMs: params.timeoutMs,
        }),
      }));
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Page.waitForSelector",
    handler: async (rawParams: ModPageWaitForSelectorParams = {} as ModPageWaitForSelectorParams) => {
      const params = parsePageWaitForSelectorParams(rawParams);
      const deadline = Date.now() + params.timeoutMs;
      let lastError: unknown = null;
      while (Date.now() <= deadline) {
        try {
          const match = await selectorState(CDPModServer, params);
          if (match.matched) {
            return {
              page: params.page,
              matched: true as const,
              ...(match.node ? { element: elementFromSelectorTarget(params, match.node, params.id) } : {}),
            };
          }
        } catch (error) {
          lastError = error;
        }
        await sleep(100);
      }
      if (lastError instanceof Error) throw lastError;
      throw new Error(`Mod.Page.waitForSelector timed out after ${params.timeoutMs}ms.`);
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.DOM.queryElement",
    handler: async (rawParams: ModQueryElementParams = {} as ModQueryElementParams) => {
      const params = parseQueryElementParams(rawParams);
      return withResolvedContext(CDPModServer, params, async ({ root }) => {
        const node = resolveSelectorStrict(root, params.selector, "element");
        return { element: elementFromSelectorTarget(params, node, params.id) };
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.DOM.resolveContext",
    handler: async (rawParams: ModResolveContextParams = {} as ModResolveContextParams) => {
      const params = parseResolveContextParams(rawParams);
      return withResolvedContext(CDPModServer, params, async (resolved) => ({
        found: true,
        page: params.page,
        pageUrl: resolved.targetInfo.url ?? "",
        frameDepth: resolved.frameDepth,
      }));
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.DOM.text",
    handler: async (rawParams: ModTextParams = {} as ModTextParams) => {
      const params = parseTextParams(rawParams);
      const element = elementFromSelectorTarget(params);
      return withResolvedElement(CDPModServer, element, async ({ node }) => ({
        text: collectText(node).trim(),
        element,
      }));
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Input.click",
    handler: async (rawParams: ModClickParams = {} as ModClickParams) => {
      const params = parseClickParams(rawParams);
      const element = elementFromSelectorTarget(params);
      return withResolvedElement(CDPModServer, element, async ({ call, pageSessionId, sessionId, node }) => {
        await call("Page.bringToFront", {}, pageSessionId).catch(() => {});
        const { x, y } = await centerPoint(call, sessionId, node);
        await call("Input.dispatchMouseEvent", { type: MOUSE_MOVE, x, y }, sessionId);
        await call("Input.dispatchMouseEvent", { type: MOUSE_DOWN, x, y, button: "left", clickCount: 1 }, sessionId);
        await dispatchMouseUp(call, sessionId, x, y);
        return { clicked: true, element };
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Input.type",
    handler: async (rawParams: ModTypeParams = {} as ModTypeParams) => {
      const params = parseTypeParams(rawParams);
      const element = elementFromSelectorTarget(params);
      return withResolvedElement(CDPModServer, element, async ({ call, pageSessionId, sessionId, node }) => {
        await call("Page.bringToFront", {}, pageSessionId).catch(() => {});
        await call("DOM.focus", { backendNodeId: node.backendNodeId }, sessionId);
        await call("Input.insertText", { text: params.text }, sessionId);
        return { typed: true, element };
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Input.hover",
    handler: async (rawParams: ModHoverParams = {} as ModHoverParams) => {
      const params = parseHoverParams(rawParams);
      const element = elementFromSelectorTarget(params);
      return withResolvedElement(CDPModServer, element, async ({ call, pageSessionId, sessionId, node }) => {
        await call("Page.bringToFront", {}, pageSessionId).catch(() => {});
        const { x, y } = await centerPoint(call, sessionId, node);
        await call("Input.dispatchMouseEvent", { type: MOUSE_MOVE, x, y }, sessionId);
        return { hovered: true, element };
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Input.fill",
    handler: async (rawParams: ModFillParams = {} as ModFillParams) => {
      const params = parseFillParams(rawParams);
      const element = elementFromSelectorTarget(params);
      return withResolvedElement(CDPModServer, element, async ({ call, pageSessionId, sessionId, node }) => {
        await call("Page.bringToFront", {}, pageSessionId).catch(() => {});
        const value = await fillElementValue(call, sessionId, node, params.value);
        return { filled: true, value, element };
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Input.press",
    handler: async (rawParams: ModPressParams = {} as ModPressParams) => {
      const params = parsePressParams(rawParams);
      return withResolvedContext(CDPModServer, params, async ({ call, pageSessionId, sessionId }) => {
        await call("Page.bringToFront", {}, pageSessionId).catch(() => {});
        await dispatchKeyPress(call, sessionId, params.key);
        return { pressed: true, key: params.key };
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Input.scroll",
    handler: async (rawParams: ModScrollParams = {} as ModScrollParams) => {
      const params = parseScrollParams(rawParams);
      if (params.selector) {
        const element = elementFromSelectorTarget({ ...params, selector: params.selector });
        return withResolvedElement(CDPModServer, element, async ({ call, pageSessionId, sessionId, node }) => {
          await call("Page.bringToFront", {}, pageSessionId).catch(() => {});
          const { x, y } = await centerPoint(call, sessionId, node);
          await synthesizeScroll(call, sessionId, x, y, params.deltaX, params.deltaY);
          return { scrolled: true, page: params.page, element };
        });
      }

      return withResolvedContext(CDPModServer, params, async ({ call, pageSessionId, sessionId }) => {
        await call("Page.bringToFront", {}, pageSessionId).catch(() => {});
        const { x, y } = await viewportCenter(call, sessionId);
        await synthesizeScroll(call, sessionId, x, y, params.deltaX, params.deltaY);
        return { scrolled: true, page: params.page };
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.DOM.elementText",
    handler: async (rawParams: ModElementTextParams = {} as ModElementTextParams) => {
      const params = parseElementTextParams(rawParams);
      return withResolvedElement(CDPModServer, params.element, async ({ node }) => ({
        text: collectText(node).trim(),
        element: params.element,
      }));
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Input.clickElement",
    handler: async (rawParams: ModClickElementParams = {} as ModClickElementParams) => {
      const params = parseClickElementParams(rawParams);
      return withResolvedElement(CDPModServer, params.element, async ({ call, pageSessionId, sessionId, node }) => {
        await call("Page.bringToFront", {}, pageSessionId).catch(() => {});
        const { x, y } = await centerPoint(call, sessionId, node);
        await call("Input.dispatchMouseEvent", { type: MOUSE_MOVE, x, y }, sessionId);
        await call("Input.dispatchMouseEvent", { type: MOUSE_DOWN, x, y, button: "left", clickCount: 1 }, sessionId);
        await dispatchMouseUp(call, sessionId, x, y);
        return { clicked: true, element: params.element };
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Input.hoverElement",
    handler: async (rawParams: ModHoverElementParams = {} as ModHoverElementParams) => {
      const params = parseHoverElementParams(rawParams);
      return withResolvedElement(CDPModServer, params.element, async ({ call, pageSessionId, sessionId, node }) => {
        await call("Page.bringToFront", {}, pageSessionId).catch(() => {});
        const { x, y } = await centerPoint(call, sessionId, node);
        await call("Input.dispatchMouseEvent", { type: MOUSE_MOVE, x, y }, sessionId);
        return { hovered: true, element: params.element };
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Input.fillElement",
    handler: async (rawParams: ModFillElementParams = {} as ModFillElementParams) => {
      const params = parseFillElementParams(rawParams);
      return withResolvedElement(CDPModServer, params.element, async ({ call, pageSessionId, sessionId, node }) => {
        await call("Page.bringToFront", {}, pageSessionId).catch(() => {});
        const value = await fillElementValue(call, sessionId, node, params.value);
        return { filled: true, value, element: params.element };
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Input.pressElement",
    handler: async (rawParams: ModPressElementParams = {} as ModPressElementParams) => {
      const params = parsePressElementParams(rawParams);
      return withResolvedElement(CDPModServer, params.element, async ({ call, pageSessionId, sessionId, node }) => {
        await call("Page.bringToFront", {}, pageSessionId).catch(() => {});
        await call("DOM.focus", { backendNodeId: node.backendNodeId }, sessionId);
        await dispatchKeyPress(call, sessionId, params.key);
        return { pressed: true, key: params.key };
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Input.scrollElement",
    handler: async (rawParams: ModScrollElementParams = {} as ModScrollElementParams) => {
      const params = parseScrollElementParams(rawParams);
      return withResolvedElement(CDPModServer, params.element, async ({ call, pageSessionId, sessionId, node }) => {
        await call("Page.bringToFront", {}, pageSessionId).catch(() => {});
        const { x, y } = await centerPoint(call, sessionId, node);
        await synthesizeScroll(call, sessionId, x, y, params.deltaX, params.deltaY);
        return { scrolled: true, page: params.element.page, element: params.element };
      });
    },
  });

  CDPModServer.addBuiltinCommand({
    name: "Mod.Input.typeElement",
    handler: async (rawParams: ModTypeElementParams = {} as ModTypeElementParams) => {
      const params = parseTypeElementParams(rawParams);
      return withResolvedElement(CDPModServer, params.element, async ({ call, pageSessionId, sessionId, node }) => {
        await call("Page.bringToFront", {}, pageSessionId).catch(() => {});
        await call("DOM.focus", { backendNodeId: node.backendNodeId }, sessionId);
        await call("Input.insertText", { text: params.text }, sessionId);
        return { typed: true, element: params.element };
      });
    },
  });
}

async function withCdp<T>(
  server: any,
  fn: (ctx: { call: CdpCall; journal: ReplayOnlyTargetJournal }) => Promise<T>,
): Promise<T> {
  if (!server.loopback_cdp_url) throw new Error("CDPMod replayable built-ins require loopback_cdp_url.");

  const journal = getReplayOnlyTargetJournal(server.loopback_cdp_url);
  await journal.ensureStarted();

  const ws = await openCDPSocket(server.loopback_cdp_url);
  const call = createCdpCall(ws);
  try {
    return await fn({ call, journal });
  } finally {
    ws.close();
  }
}

function elementFromSelectorTarget(target: ModSelectorTargetParams, node?: DomNode, id?: string): ModElement {
  return {
    object: "mod.element",
    id,
    page: target.page,
    frames: target.frames || [],
    selector: target.selector,
    fingerprint: node
      ? {
          nodeName: nodeName(node),
          text: collectText(node).trim().slice(0, 200),
        }
      : undefined,
  };
}

async function withResolvedElement<T>(
  server: any,
  element: ModElement,
  fn: (resolved: ResolvedContext & { node: DomNode }) => Promise<T>,
) {
  return withResolvedContext(server, element, async (resolved) => {
    const node = resolveSelectorStrict(resolved.root, element.selector, "element");
    if (!node.backendNodeId) throw new Error(`Resolved element has no backendNodeId.`);
    return fn({ ...resolved, node });
  });
}

async function withPageSession<T>(
  server: any,
  page: ModElement["page"],
  fn: (resolved: {
    call: CdpCall;
    targetInfo: TargetInfoLike;
    pageSessionId: string;
    cleanupSessionIds: string[];
  }) => Promise<T>,
) {
  return withCdp(server, async ({ call, journal }) => {
    const cleanupSessionIds: string[] = [];
    try {
      const targetInfo = journal.targetForModPage(page.id, await livePageTargets(call));
      const { sessionId: pageSessionId } = await call("Target.attachToTarget", {
        targetId: targetInfo.targetId,
        flatten: true,
      });
      cleanupSessionIds.push(pageSessionId);
      return await fn({ call, targetInfo, pageSessionId, cleanupSessionIds });
    } finally {
      for (const sessionId of cleanupSessionIds.reverse()) {
        await call("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    }
  });
}

async function withResolvedContext<T>(
  server: any,
  context: { page: ModElement["page"]; frames?: ModFrameHop[] },
  fn: (resolved: ResolvedContext) => Promise<T>,
) {
  return withCdp(server, async ({ call, journal }) => {
    const cleanupSessionIds: string[] = [];
    try {
      const targetInfo = journal.targetForModPage(context.page.id, await livePageTargets(call));
      const { sessionId: pageSessionId } = await call("Target.attachToTarget", {
        targetId: targetInfo.targetId,
        flatten: true,
      });
      cleanupSessionIds.push(pageSessionId);

      let sessionId = pageSessionId;
      let root = await documentRoot(call, sessionId);

      for (const hop of context.frames || []) {
        const frame = await resolveFrameHop(call, sessionId, root, hop);
        sessionId = frame.sessionId;
        if (frame.cleanupSessionId) cleanupSessionIds.push(frame.cleanupSessionId);
        root = frame.root;
      }

      return await fn({
        call,
        targetInfo,
        pageSessionId,
        sessionId,
        root,
        frameDepth: context.frames?.length ?? 0,
        cleanupSessionIds,
      });
    } finally {
      for (const sessionId of cleanupSessionIds.reverse()) {
        await call("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    }
  });
}

async function resolveFrameHop(call: CdpCall, sessionId: string, root: DomNode, hop: ModFrameHop) {
  const owner = resolveSelectorStrict(root, hop.owner, "frame owner");
  if (!owner.backendNodeId) throw new Error(`Resolved frame owner has no backendNodeId.`);
  const actualName = (owner.nodeName || owner.localName || "").toUpperCase();
  if (actualName !== hop.assertNodeName) {
    throw new Error(`Frame owner resolved to ${actualName}, expected ${hop.assertNodeName}.`);
  }

  if (owner.contentDocument) {
    return { sessionId, root: owner.contentDocument, cleanupSessionId: null };
  }

  const frameId = owner.frameId || (await frameIdForOwner(call, sessionId, owner.backendNodeId));
  if (!frameId) throw new Error(`Could not map frame owner to a frameId.`);

  const iframeTarget = await waitForFrameTarget(call, frameId);
  const { sessionId: childSessionId } = await call("Target.attachToTarget", {
    targetId: iframeTarget.targetId,
    flatten: true,
  });
  return {
    sessionId: childSessionId,
    root: await documentRoot(call, childSessionId),
    cleanupSessionId: childSessionId,
  };
}

async function waitForFrameTarget(call: CdpCall, frameId: string): Promise<TargetInfoLike> {
  const deadline = Date.now() + DEFAULT_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const targets = await call("Target.getTargets");
    const iframeTarget = (targets.targetInfos || []).find(
      (target: TargetInfoLike) =>
        target.targetId === frameId || target.parentFrameId === frameId || target.openerFrameId === frameId,
    );
    if (iframeTarget?.targetId) return iframeTarget;
    await sleep(100);
  }
  throw new Error(`Frame ${frameId} did not expose an attachable target. Same-process contentDocument was absent.`);
}

async function frameIdForOwner(call: CdpCall, sessionId: string, ownerBackendNodeId: number) {
  const tree = await call("Page.getFrameTree", {}, sessionId);
  for (const frame of flattenFrameTree(tree.frameTree)) {
    if (!frame?.id) continue;
    try {
      const owner = await call("DOM.getFrameOwner", { frameId: frame.id }, sessionId);
      if (owner.backendNodeId === ownerBackendNodeId) return frame.id;
    } catch {}
  }
  return null;
}

function flattenFrameTree(tree: any): any[] {
  if (!tree?.frame) return [];
  return [tree.frame, ...(tree.childFrames || []).flatMap(flattenFrameTree)];
}

async function livePageTargets(call: CdpCall): Promise<TargetInfoLike[]> {
  const targets = await call("Target.getTargets");
  return (targets.targetInfos || []).filter((target: TargetInfoLike) => target.type === "page");
}

async function waitForPageTarget(call: CdpCall, targetId: string, url: string): Promise<TargetInfoLike> {
  const deadline = Date.now() + DEFAULT_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const target = (await livePageTargets(call)).find((candidate) => candidate.targetId === targetId);
    if (target && (!url || target.url === url)) return target;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for page target ${targetId} to navigate to ${url}.`);
}

function pageMatchesExpectation(target: TargetInfoLike, expected: ModWaitForPageParams["expected"]): boolean {
  if (!expected) return true;
  if (expected.url && target.url !== expected.url) return false;
  if (expected.urlIncludes && !target.url?.includes(expected.urlIncludes)) return false;
  return true;
}

function navigationResult(page: ModElement["page"], url: string): ModNavigationResult {
  return { page, url, response: null };
}

function assertSupportedLoadState(state: ModLoadState | undefined): void {
  if (state === "networkidle") {
    throw new Error(
      "Mod.Page networkidle waits are not implemented because replayable request/lifecycle state needs an explicit design.",
    );
  }
}

async function adjacentHistoryEntry(call: CdpCall, sessionId: string, offset: -1 | 1, label: string) {
  const history = await call("Page.getNavigationHistory", {}, sessionId);
  const currentIndex = typeof history.currentIndex === "number" ? history.currentIndex : -1;
  const entries = Array.isArray(history.entries) ? history.entries : [];
  const entry = entries[currentIndex + offset];
  if (!entry || typeof entry.id !== "number") {
    throw new Error(`${label} cannot navigate without a ${offset < 0 ? "previous" : "next"} history entry.`);
  }
  return {
    id: entry.id as number,
    url: typeof entry.url === "string" ? entry.url : undefined,
  };
}

async function waitForLoadState(
  call: CdpCall,
  sessionId: string,
  state: ModLoadState,
  timeoutMs: number,
): Promise<void> {
  assertSupportedLoadState(state);
  const deadline = Date.now() + timeoutMs;
  do {
    const readyState = await documentReadyState(call, sessionId);
    if (state === "domcontentloaded" && (readyState === "interactive" || readyState === "complete")) return;
    if (state === "load" && readyState === "complete") return;
    await sleep(100);
  } while (Date.now() <= deadline);
  throw new Error(`Mod.Page.waitForLoadState timed out after ${timeoutMs}ms waiting for ${state}.`);
}

async function documentReadyState(call: CdpCall, sessionId: string): Promise<string> {
  const result = await call("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, sessionId);
  const value = result.result?.value;
  return typeof value === "string" ? value : "";
}

async function currentPageUrl(call: CdpCall, sessionId: string, fallback = "about:blank"): Promise<string> {
  try {
    const result = await call("Runtime.evaluate", { expression: "location.href", returnByValue: true }, sessionId);
    return typeof result.result?.value === "string" ? result.result.value : fallback;
  } catch {
    return fallback;
  }
}

function mimeTypeForScreenshot(type: ModPageScreenshotParams["type"]) {
  if (type === "jpeg") return "image/jpeg" as const;
  if (type === "webp") return "image/webp" as const;
  return "image/png" as const;
}

async function documentRoot(call: CdpCall, sessionId: string) {
  const { root } = await call("DOM.getDocument", { depth: -1, pierce: true }, sessionId);
  if (!root) throw new Error("DOM.getDocument returned no root.");
  return root as DomNode;
}

async function selectorState(
  server: any,
  params: ModPageWaitForSelectorParams,
): Promise<{ matched: boolean; node?: DomNode }> {
  return withResolvedContext(server, params, async ({ call, sessionId, root }) => {
    const matches = selectNodes(root, params.selector);
    if (matches.length > 1) {
      throw new Error(`Strict selector ${describeSelector(params.selector)} resolved to ${matches.length} nodes.`);
    }
    const node = matches[0] ?? null;
    if (params.state === "attached") return node ? { matched: true, node } : { matched: false };
    if (params.state === "detached") return { matched: node == null };
    if (!node) return { matched: params.state === "hidden" };
    const visible = await isNodeVisible(call, sessionId, node);
    if (params.state === "visible") return visible ? { matched: true, node } : { matched: false };
    return { matched: !visible };
  });
}

async function isNodeVisible(call: CdpCall, sessionId: string, node: DomNode): Promise<boolean> {
  if (!node.backendNodeId) return false;
  try {
    const quads = await call("DOM.getContentQuads", { backendNodeId: node.backendNodeId }, sessionId);
    return Array.isArray(quads.quads) && quads.quads.some((quad: unknown) => Array.isArray(quad) && quad.length >= 8);
  } catch {
    return false;
  }
}

function resolveSelectorStrict(root: DomNode, selector: ModSelector, label: string): DomNode {
  const matches = selectNodes(root, selector);
  if (matches.length !== 1) {
    throw new Error(`Strict ${label} selector ${describeSelector(selector)} resolved to ${matches.length} nodes.`);
  }
  return matches[0];
}

function selectNodes(root: DomNode, selector: ModSelector): DomNode[] {
  if (selector.kind === "xpath") return selectXPath(root, selector.xpath);
  if (selector.kind === "css") return selectCss(root, selector.selector);
  if (selector.kind === "role") return selectRole(root, selector);
  return selectText(root, selector);
}

function selectXPath(root: DomNode, xpath: string): DomNode[] {
  if (xpath.startsWith("//")) {
    const step = parseXPathStep(xpath.slice(2), xpath);
    return descendants(root).filter((node) => matchesStep(node, step));
  }

  const parts = xpath
    .split("/")
    .filter(Boolean)
    .map((part) => parseXPathStep(part, xpath));

  let current: DomNode[] = [root];
  for (const [partIndex, part] of parts.entries()) {
    const next: DomNode[] = [];
    for (const node of current) {
      if (partIndex === 0 && matchesStep(node, part)) {
        next.push(node);
        continue;
      }
      const matches = childNodes(node).filter((child) => matchesStep(child, part));
      if (part.index === null) next.push(...matches);
      else if (matches[part.index - 1]) next.push(matches[part.index - 1]);
    }
    current = next;
    if (current.length === 0) return [];
  }
  return current;
}

function parseXPathStep(segment: string, xpath: string) {
  const idMatch = /^(?<name>\*|[A-Za-z0-9:_#-]+)?\[@id=(?<quote>["'])(?<id>.*?)\k<quote>\](?:\[(?<index>\d+)\])?$/.exec(
    segment,
  );
  if (idMatch?.groups) {
    return {
      name: (idMatch.groups.name || "*").toUpperCase(),
      id: idMatch.groups.id,
      index: idMatch.groups.index ? Number(idMatch.groups.index) : null,
    };
  }

  const structuralMatch = /^(?<name>\*|[A-Za-z0-9:_#-]+)(?:\[(?<index>\d+)\])?$/.exec(segment);
  if (!structuralMatch?.groups) throw new Error(`Unsupported XPath segment ${segment} in ${xpath}`);
  return {
    name: structuralMatch.groups.name.toUpperCase(),
    id: null,
    index: structuralMatch.groups.index ? Number(structuralMatch.groups.index) : null,
  };
}

function matchesStep(node: DomNode, step: { name: string; id: string | null }) {
  if (step.name !== "#SHADOW-ROOT" && node.nodeType !== 1) return false;
  if (step.name !== "*" && nodeName(node) !== step.name) return false;
  if (step.id !== null && attribute(node, "id") !== step.id) return false;
  return true;
}

function selectCss(root: DomNode, selector: string): DomNode[] {
  const parts = selector.trim().split(/\s+/).filter(Boolean).map(parseSimpleCssSelector);
  let current: DomNode[] = [root];
  for (const part of parts) {
    current = current.flatMap((node) => descendants(node).filter((candidate) => matchesSimpleCss(candidate, part)));
  }
  return current;
}

function parseSimpleCssSelector(selector: string) {
  const match =
    /^(?<tag>[A-Za-z][A-Za-z0-9_-]*)?(?:#(?<id>[A-Za-z0-9_-]+))?(?:\.(?<className>[A-Za-z0-9_-]+))?(?:\[(?<attr>[A-Za-z0-9:_-]+)(?:=(?<quote>["']?)(?<value>[^\]"']*)\k<quote>)?\])?$/.exec(
      selector,
    );
  if (!match?.groups || (!match.groups.tag && !match.groups.id && !match.groups.className && !match.groups.attr)) {
    throw new Error(`Unsupported CDPMod CSS selector "${selector}".`);
  }
  return {
    tag: match.groups.tag?.toUpperCase() ?? null,
    id: match.groups.id ?? null,
    className: match.groups.className ?? null,
    attr: match.groups.attr ?? null,
    value: match.groups.value ?? null,
  };
}

function matchesSimpleCss(
  node: DomNode,
  selector: {
    tag: string | null;
    id: string | null;
    className: string | null;
    attr: string | null;
    value: string | null;
  },
): boolean {
  if (node.nodeType !== 1) return false;
  if (selector.tag && nodeName(node) !== selector.tag) return false;
  if (selector.id && attribute(node, "id") !== selector.id) return false;
  if (selector.className) {
    const classes = (attribute(node, "class") || "").split(/\s+/).filter(Boolean);
    if (!classes.includes(selector.className)) return false;
  }
  if (selector.attr) {
    const value = attribute(node, selector.attr);
    if (value === null) return false;
    if (selector.value !== null && value !== selector.value) return false;
  }
  return true;
}

function selectRole(root: DomNode, selector: Extract<ModSelector, { kind: "role" }>): DomNode[] {
  return descendants(root).filter((node) => {
    if (roleOf(node) !== selector.role) return false;
    if (selector.name === undefined) return true;
    return stringMatches(accessibleName(node), selector.name, selector.exact);
  });
}

function selectText(root: DomNode, selector: Extract<ModSelector, { kind: "text" }>): DomNode[] {
  const matching = descendants(root).filter((node) => {
    if (node.nodeType !== 1) return false;
    return stringMatches(normalizeText(collectText(node)), selector.text, selector.exact);
  });
  return matching.filter(
    (node) =>
      !childNodes(node).some(
        (child) =>
          child.nodeType === 1 && stringMatches(normalizeText(collectText(child)), selector.text, selector.exact),
      ),
  );
}

function roleOf(node: DomNode): string | null {
  const explicit = attribute(node, "role");
  if (explicit) return explicit;
  const name = nodeName(node);
  if (name === "BUTTON") return "button";
  if (name === "A" && attribute(node, "href")) return "link";
  if (name === "INPUT") {
    const type = (attribute(node, "type") || "text").toLowerCase();
    if (["button", "submit", "reset"].includes(type)) return "button";
    return "textbox";
  }
  if (/^H[1-6]$/.test(name)) return "heading";
  return null;
}

function accessibleName(node: DomNode): string {
  return normalizeText(
    attribute(node, "aria-label") || attribute(node, "alt") || attribute(node, "title") || collectText(node),
  );
}

function stringMatches(actual: string, expected: string, exact = true): boolean {
  const normalizedActual = normalizeText(actual);
  const normalizedExpected = normalizeText(expected);
  return exact ? normalizedActual === normalizedExpected : normalizedActual.includes(normalizedExpected);
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function describeSelector(selector: ModSelector): string {
  return JSON.stringify(selector);
}

function descendants(node: DomNode): DomNode[] {
  return childNodes(node).flatMap((child) => [child, ...descendants(child)]);
}

function childNodes(node: DomNode | null): DomNode[] {
  if (!node) return [];
  return [
    ...(node.children || []),
    ...(node.shadowRoots || []),
    ...(node.contentDocument ? [node.contentDocument] : []),
  ];
}

function nodeName(node: DomNode) {
  if (node.shadowRootType) return "#SHADOW-ROOT";
  return (node.nodeName || node.localName || "").toUpperCase();
}

function attribute(node: DomNode, name: string) {
  const attrs = node.attributes || [];
  for (let index = 0; index < attrs.length; index += 2) {
    if (attrs[index] === name) return attrs[index + 1] ?? null;
  }
  return null;
}

function collectText(node: DomNode): string {
  if (node.nodeType === 3) return node.nodeValue || "";
  return childNodes(node).map(collectText).join("");
}

async function evaluateInDocumentContext(
  call: CdpCall,
  sessionId: string,
  root: DomNode,
  expression: string,
  arg: unknown,
  options: { awaitPromise: boolean; timeoutMs?: number },
): Promise<unknown> {
  const result = await callFunctionOnNode(
    call,
    sessionId,
    root,
    `async function(arg) {
      const value = (${expression});
      return typeof value === "function" ? await value.call(globalThis, arg) : await value;
    }`,
    [{ value: arg }],
    { awaitPromise: options.awaitPromise, timeoutMs: options.timeoutMs },
  );
  throwIfRuntimeException(result, "Mod.Page.evaluate");
  return runtimeRemoteObjectValue(result);
}

async function fillElementValue(call: CdpCall, sessionId: string, node: DomNode, value: string): Promise<string> {
  const result = await callFunctionOnNode(
    call,
    sessionId,
    node,
    `function(value) {
      const element = this;
      if (!element || !element.isConnected) return { status: "error", reason: "not connected", value: "" };
      const win = element.ownerDocument?.defaultView ?? globalThis;
      const dispatch = () => {
        element.dispatchEvent(new win.Event("input", { bubbles: true, composed: true }));
        element.dispatchEvent(new win.Event("change", { bubbles: true }));
      };
      element.focus?.();
      if (element instanceof win.HTMLInputElement || element instanceof win.HTMLTextAreaElement) {
        const proto = element instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (typeof setter === "function") setter.call(element, value);
        else element.value = value;
        dispatch();
        return { status: "done", value: String(element.value ?? "") };
      }
      if (element.isContentEditable) {
        element.textContent = value;
        dispatch();
        return { status: "done", value: String(element.textContent ?? "") };
      }
      return { status: "error", reason: "unsupported element", value: "" };
    }`,
    [{ value }],
    { awaitPromise: true },
  );
  throwIfRuntimeException(result, "Mod.Input.fillElement");
  const fillResult = runtimeRemoteObjectValue(result);
  if (!fillResult || typeof fillResult !== "object") throw new Error("Mod.Input.fillElement returned no fill result.");
  const status = (fillResult as { status?: unknown }).status;
  if (status === "error") {
    const reason = (fillResult as { reason?: unknown }).reason;
    throw new Error(typeof reason === "string" ? reason : "Failed to fill element.");
  }
  const filledValue = (fillResult as { value?: unknown }).value;
  return typeof filledValue === "string" ? filledValue : value;
}

async function callFunctionOnNode(
  call: CdpCall,
  sessionId: string,
  node: DomNode,
  functionDeclaration: string,
  args: Array<Record<string, unknown>>,
  options: { awaitPromise: boolean; timeoutMs?: number },
) {
  if (!node.backendNodeId) throw new Error("Resolved node has no backendNodeId.");
  const resolved = await call("DOM.resolveNode", { backendNodeId: node.backendNodeId }, sessionId);
  const objectId = resolved.object?.objectId;
  if (typeof objectId !== "string") throw new Error("DOM.resolveNode returned no objectId.");
  try {
    return await call(
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration,
        arguments: args,
        awaitPromise: options.awaitPromise,
        returnByValue: true,
      },
      sessionId,
      options.timeoutMs,
    );
  } finally {
    await call("Runtime.releaseObject", { objectId }, sessionId).catch(() => {});
  }
}

function throwIfRuntimeException(result: any, label: string): void {
  if (!result?.exceptionDetails) return;
  const exception = result.exceptionDetails.exception;
  const message =
    (exception && typeof exception.description === "string" ? exception.description : null) ||
    (typeof result.exceptionDetails.text === "string" ? result.exceptionDetails.text : null) ||
    `${label} threw an exception.`;
  throw new Error(message);
}

function runtimeRemoteObjectValue(result: any): unknown {
  const remote = result?.result;
  if (!remote || typeof remote !== "object") return undefined;
  return "value" in remote ? remote.value : undefined;
}

async function centerPoint(call: CdpCall, sessionId: string, node: DomNode) {
  await call("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId }, sessionId).catch(() => {});
  const quads = await call("DOM.getContentQuads", { backendNodeId: node.backendNodeId }, sessionId);
  const quad = quads.quads?.[0];
  if (!quad || quad.length < 8)
    throw new Error(`DOM.getContentQuads returned no quad for backendNodeId ${node.backendNodeId}`);
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  };
}

async function viewportCenter(call: CdpCall, sessionId: string) {
  const metrics = await call("Page.getLayoutMetrics", {}, sessionId);
  const viewport = metrics.cssVisualViewport || metrics.visualViewport || {};
  const width = typeof viewport.clientWidth === "number" ? viewport.clientWidth : 1280;
  const height = typeof viewport.clientHeight === "number" ? viewport.clientHeight : 720;
  return { x: width / 2, y: height / 2 };
}

async function synthesizeScroll(
  call: CdpCall,
  sessionId: string,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await call(
    "Input.synthesizeScrollGesture",
    {
      x,
      y,
      xDistance: -deltaX,
      yDistance: -deltaY,
    },
    sessionId,
  );
}

async function dispatchKeyPress(call: CdpCall, sessionId: string, key: string): Promise<void> {
  await call("Input.dispatchKeyEvent", { type: "keyDown", key }, sessionId);
  await call("Input.dispatchKeyEvent", { type: "keyUp", key }, sessionId);
}

async function dispatchMouseUp(call: CdpCall, sessionId: string, x: number, y: number): Promise<void> {
  try {
    await call(
      "Input.dispatchMouseEvent",
      { type: MOUSE_UP, x, y, button: "left", clickCount: 1 },
      sessionId,
      POPUP_OPENING_MOUSE_UP_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("timed out")) return;
    throw error;
  }
}

async function openCDPSocket(endpoint: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(endpoint);
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
}

function createCdpCall(ws: WebSocket): CdpCall {
  let nextId = 1;
  return (
    method: string,
    params: Record<string, unknown> = {},
    sessionId: string | null = null,
    timeoutMs?: number,
  ) => {
    const id = nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    ws.send(JSON.stringify(message));
    return new Promise((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        ws.removeEventListener("message", listener);
        if (timeout) clearTimeout(timeout);
        timeout = null;
      };
      const listener = (event: MessageEvent) => {
        const data = typeof event.data === "string" ? event.data : String(event.data);
        const msg = JSON.parse(data) as CdpMessage;
        if (msg.id !== id) return;
        cleanup();
        if (msg.error) reject(new Error(msg.error.message || `${method} failed`));
        else resolve(msg.result || {});
      };
      ws.addEventListener("message", listener);
      ws.addEventListener("error", reject, { once: true });
      if (timeoutMs) {
        timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }
    });
  };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
