// @ts-nocheck
// Pure stateless translation between ModCDP and raw CDP frames.
// No I/O, no maps, no classes. Trivial to port to any language.
// Used on both the Node side (proxy + client) and the extension service worker
// side, so the binding payload format only has one definition.

import type {
  ModCDPAddCustomCommandParams,
  ModCDPAddMiddlewareParams,
  ModCDPBindingPayload,
  ModCDPCustomPayload,
  ModCDPEvaluateParams,
  ModCDPPingParams,
  ModCDPRoutes,
  ProtocolParams,
  ProtocolResult,
  RuntimeBindingCalledEvent,
  TranslatedCommand,
  UnwrappedModCDPEvent,
} from "../types/modcdp.js";
import type { cdp } from "../types/cdp.js";

export const BINDING_PREFIX = "__ModCDP_";
export const UPSTREAM_EVENT_BINDING_NAME = "__ModCDP_event_from_upstream__";

export const DEFAULT_CLIENT_ROUTES = {
  "Mod.*": "service_worker",
  "Custom.*": "service_worker",
  "*.*": "service_worker",
} satisfies ModCDPRoutes;

type TranslateOptions = { routes?: ModCDPRoutes; cdpSessionId?: string | null };

export const bindingNameFor = (eventName: string) =>
  BINDING_PREFIX + eventName.replaceAll(".", "_").replaceAll("*", "all");

export const eventNameFor = (bindingName: string) =>
  bindingName.startsWith(BINDING_PREFIX) ? bindingName.slice(BINDING_PREFIX.length).replaceAll("_", ".") : null;

function normalizeModCDPName(
  value:
    | {
        cdp_command_name?: string;
        cdp_event_name?: string;
        id?: string;
        name?: string;
        meta?: () => { cdp_command_name?: unknown; cdp_event_name?: unknown; id?: unknown; name?: unknown };
      }
    | string,
) {
  if (typeof value === "string") return value;
  const meta = typeof value?.meta === "function" ? value.meta() : undefined;
  const name =
    value?.cdp_command_name ??
    value?.cdp_event_name ??
    (typeof meta?.cdp_command_name === "string" ? meta.cdp_command_name : undefined) ??
    (typeof meta?.cdp_event_name === "string" ? meta.cdp_event_name : undefined) ??
    value?.id ??
    (typeof meta?.id === "string" ? meta.id : undefined) ??
    (typeof meta?.name === "string" ? meta.name : undefined) ??
    value?.name;
  if (typeof name !== "string" || !name) throw new Error("Expected a CDP name string or a named CDP schema/alias.");
  return name;
}

export function routeFor(method: string, routes: ModCDPRoutes = {}) {
  if (Object.prototype.hasOwnProperty.call(routes, method)) return routes[method];
  let bestPrefixLen = -1;
  let bestRoute: string | null = null;
  for (const [pattern, route] of Object.entries(routes)) {
    if (pattern === "*.*" || !pattern.endsWith(".*")) continue;
    const prefix = pattern.slice(0, -1);
    if (method.startsWith(prefix) && prefix.length > bestPrefixLen) {
      bestPrefixLen = prefix.length;
      bestRoute = route;
    }
  }
  if (bestRoute !== null) return bestRoute;
  if (Object.prototype.hasOwnProperty.call(routes, "*.*")) return routes["*.*"];
  return "direct_cdp";
}

// --- outbound: ModCDP method -> Runtime.* params on the extension session --

export function wrapModCDPEvaluate({
  expression,
  params = {},
  cdpSessionId = null,
}: ModCDPEvaluateParams): cdp.types.ts.Runtime.EvaluateParams {
  return {
    expression: `
      (async () => {
        const params = ${JSON.stringify(params)};
        const cdp = globalThis.ModCDP.attachToSession(${JSON.stringify(cdpSessionId)});
        const ModCDP = globalThis.ModCDP;
        const chrome = globalThis.chrome;
        const value = (${expression});
        return typeof value === "function" ? await value(params) : value;
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  };
}

export function wrapModCDPAddCustomCommand({
  name,
  expression,
}: ModCDPAddCustomCommandParams): cdp.types.ts.Runtime.EvaluateParams {
  const commandName = normalizeModCDPName(name);
  return {
    expression: `
      (() => {
        return globalThis.ModCDP.addCustomCommand({
          name: ${JSON.stringify(commandName)},
          paramsSchema: null,
          resultSchema: null,
          expression: ${JSON.stringify(expression)},
          handler: async (params, cdpSessionId, method) => {
            const cdp = globalThis.ModCDP.attachToSession(cdpSessionId);
            const ModCDP = globalThis.ModCDP;
            const chrome = globalThis.chrome;
            const handler = (${expression});
            return await handler(params || {}, method);
          },
        });
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  };
}

export function wrapModCDPAddCustomEvent({ name }: { name: string }): cdp.types.ts.Runtime.EvaluateParams {
  const eventName = normalizeModCDPName(name);
  return {
    expression: `
      globalThis.ModCDP.addCustomEvent({
        name: ${JSON.stringify(eventName)},
        bindingName: ${JSON.stringify(bindingNameFor(eventName))},
        eventSchema: null,
      })
    `,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  };
}

export function wrapModCDPAddMiddleware({
  name = "*",
  phase,
  expression,
}: ModCDPAddMiddlewareParams): cdp.types.ts.Runtime.EvaluateParams {
  const middlewareName = normalizeModCDPName(name);
  return {
    expression: `
      (() => {
        return globalThis.ModCDP.addMiddleware({
          name: ${JSON.stringify(middlewareName)},
          phase: ${JSON.stringify(phase)},
          expression: ${JSON.stringify(expression)},
          handler: async (payload, next, context = {}) => {
            const cdp = globalThis.ModCDP.attachToSession(context.cdpSessionId ?? null);
            const ModCDP = globalThis.ModCDP;
            const chrome = globalThis.chrome;
            const middleware = (${expression});
            return await middleware(payload, next, context);
          },
        });
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  };
}

export function wrapCustomCommand(
  method: string,
  params: ProtocolParams = {},
  cdpSessionId: string | null = null,
): cdp.types.ts.Runtime.EvaluateParams {
  return {
    expression: `globalThis.ModCDP.handleCommand(${JSON.stringify(method)}, ${JSON.stringify(params)}, ${JSON.stringify(cdpSessionId)})`,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  };
}

function wrapServiceWorkerCommand(method: string, params: ProtocolParams = {}, cdpSessionId: string | null = null) {
  if (method === "Mod.ping" && !Object.prototype.hasOwnProperty.call(params, "sentAt")) {
    params = { ...(params as ModCDPPingParams), sentAt: Date.now() };
  }

  if (method === "Mod.addCustomEvent") {
    const eventParams = params as { name: any };
    const eventName = normalizeModCDPName(eventParams.name);
    return [
      {
        method: "Runtime.addBinding",
        params: { name: bindingNameFor(eventName) },
      },
      {
        method: "Runtime.evaluate",
        params: wrapModCDPAddCustomEvent({ name: eventName }),
        unwrap: "evaluate" as const,
      },
    ];
  }

  let runtimeParams;
  if (method === "Mod.evaluate") {
    const evaluateParams = params as ModCDPEvaluateParams;
    runtimeParams = wrapModCDPEvaluate({
      ...evaluateParams,
      cdpSessionId: evaluateParams.cdpSessionId ?? cdpSessionId,
    });
  } else if (method === "Mod.addCustomCommand") {
    runtimeParams = wrapModCDPAddCustomCommand(params as ModCDPAddCustomCommandParams);
  } else if (method === "Mod.addMiddleware") {
    runtimeParams = wrapModCDPAddMiddleware(params as ModCDPAddMiddlewareParams);
  } else {
    runtimeParams = wrapCustomCommand(
      method,
      params,
      ((params as ModCDPCustomPayload).cdpSessionId as string) ?? cdpSessionId,
    );
  }

  return [
    {
      method: "Runtime.evaluate",
      params: runtimeParams,
      unwrap: "evaluate" as const,
    },
  ];
}

export function wrapCommandIfNeeded(
  method: string,
  params: ProtocolParams = {},
  { routes = DEFAULT_CLIENT_ROUTES, cdpSessionId = null }: TranslateOptions = {},
): TranslatedCommand {
  params = params ?? {};
  const route = routeFor(method, routes);
  if (route === "direct_cdp") {
    return {
      route,
      target: "direct_cdp",
      steps: [{ method, params }],
    };
  }
  if (route === "self") {
    return {
      route,
      target: "self",
      steps: [{ method, params }],
    };
  }
  if (route === "service_worker") {
    return {
      route,
      target: "service_worker",
      steps: wrapServiceWorkerCommand(method, params, cdpSessionId),
    };
  }
  throw new Error(`Unsupported client route "${route}" for ${method}`);
}

// --- inbound: Runtime.* result/event -> ModCDP value/event ----------------

function unwrapEvaluateResponse(result: cdp.types.ts.Runtime.EvaluateResult) {
  if (result?.exceptionDetails) {
    const ex = result.exceptionDetails;
    throw new Error(ex.exception?.description || ex.text || "Runtime.evaluate failed");
  }
  return result?.result?.value;
}

export function unwrapResponseIfNeeded(
  result: ProtocolResult | cdp.types.ts.Runtime.EvaluateResult,
  unwrap: string | null = null,
) {
  return unwrap === "evaluate" ? unwrapEvaluateResponse(result as cdp.types.ts.Runtime.EvaluateResult) : (result ?? {});
}

// Returns { event, data } or null when the binding is not a ModCDP event,
// when a custom binding payload is scoped to a different cdpSessionId than
// ourSessionId, or when the payload string is not valid JSON.
export function unwrapEventIfNeeded(
  method: string,
  params: RuntimeBindingCalledEvent,
  sessionId: string | null = null,
  ourSessionId: string | null = null,
): UnwrappedModCDPEvent | null {
  if (method !== "Runtime.bindingCalled") return null;
  let payload: ModCDPBindingPayload;
  try {
    payload = JSON.parse(params.payload || "{}");
  } catch {
    return null;
  }
  if (payload == null || typeof payload !== "object") return null;
  const bindingName = params?.name || "";
  const isUpstreamEventBinding = bindingName === UPSTREAM_EVENT_BINDING_NAME;
  const event = isUpstreamEventBinding ? UPSTREAM_EVENT_BINDING_NAME : eventNameFor(bindingName);
  if (!event) return null;
  const payloadEvent = typeof payload.event === "string" && payload.event.length > 0 ? payload.event : null;
  if (!isUpstreamEventBinding && payloadEvent != null && payloadEvent !== event) return null;
  const resolvedEvent = isUpstreamEventBinding && payloadEvent != null ? payloadEvent : event;
  if (resolvedEvent === UPSTREAM_EVENT_BINDING_NAME) return null;
  if (!isUpstreamEventBinding && ourSessionId != null && payload.cdpSessionId && payload.cdpSessionId !== ourSessionId)
    return null;
  const data = Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
  const sourceSessionId =
    isUpstreamEventBinding && typeof payload.cdpSessionId === "string" ? payload.cdpSessionId : sessionId;
  return { event: resolvedEvent, data, sessionId: sourceSessionId };
}

// --- shared encoder used by the extension service worker --------------------

export function encodeBindingPayload({ event, data, cdpSessionId = null }: ModCDPBindingPayload) {
  return JSON.stringify({ event, data, cdpSessionId });
}
