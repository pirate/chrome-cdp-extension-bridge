// @ts-nocheck
// Pure stateless translation between CDPMods and raw CDP frames.
// No I/O, no maps, no classes. Trivial to port to any language.
// Used on both the Node side (proxy + client) and the extension service worker
// side, so the binding payload format only has one definition.

import type {
  CDPModsAddCustomCommandParams,
  CDPModsAddMiddlewareParams,
  CDPModsBindingPayload,
  CDPModsCustomPayload,
  CDPModsEvaluateParams,
  CDPModsPingParams,
  CDPModsRoutes,
  ProtocolParams,
  ProtocolResult,
  RuntimeBindingCalledEvent,
  TranslatedCommand,
  UnwrappedCDPModsEvent,
} from "../types/cdpmods.js";
import type { cdp } from "../types/cdp.js";

export const BINDING_PREFIX = "__CDPMods_";

export const DEFAULT_CLIENT_ROUTES = {
  "Mods.*": "service_worker",
  "Custom.*": "service_worker",
  "*.*": "service_worker",
} satisfies CDPModsRoutes;

type TranslateOptions = { routes?: CDPModsRoutes; cdpSessionId?: string | null };

export const bindingNameFor = (eventName: string) =>
  BINDING_PREFIX + eventName.replaceAll(".", "_").replaceAll("*", "all");

export const eventNameFor = (bindingName: string) =>
  bindingName.startsWith(BINDING_PREFIX) ? bindingName.slice(BINDING_PREFIX.length).replaceAll("_", ".") : null;

function normalizeCDPModsName(
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

export function routeFor(method: string, routes: CDPModsRoutes = {}) {
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

// --- outbound: CDPMods method -> Runtime.* params on the extension session --

export function wrapCDPModsEvaluate({
  expression,
  params = {},
  cdpSessionId = null,
}: CDPModsEvaluateParams): cdp.types.ts.Runtime.EvaluateParams {
  return {
    expression: `
      (async () => {
        const params = ${JSON.stringify(params)};
        const cdp = globalThis.CDPMods.attachToSession(${JSON.stringify(cdpSessionId)});
        const CDPMods = globalThis.CDPMods;
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

export function wrapCDPModsAddCustomCommand({
  name,
  expression,
}: CDPModsAddCustomCommandParams): cdp.types.ts.Runtime.EvaluateParams {
  const commandName = normalizeCDPModsName(name);
  return {
    expression: `
      (() => {
        return globalThis.CDPMods.addCustomCommand({
          name: ${JSON.stringify(commandName)},
          paramsSchema: null,
          resultSchema: null,
          expression: ${JSON.stringify(expression)},
          handler: async (params, cdpSessionId, method) => {
            const cdp = globalThis.CDPMods.attachToSession(cdpSessionId);
            const CDPMods = globalThis.CDPMods;
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

export function wrapCDPModsAddCustomEvent({ name }: { name: string }): cdp.types.ts.Runtime.EvaluateParams {
  const eventName = normalizeCDPModsName(name);
  return {
    expression: `
      globalThis.CDPMods.addCustomEvent({
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

export function wrapCDPModsAddMiddleware({
  name = "*",
  phase,
  expression,
}: CDPModsAddMiddlewareParams): cdp.types.ts.Runtime.EvaluateParams {
  const middlewareName = normalizeCDPModsName(name);
  return {
    expression: `
      (() => {
        return globalThis.CDPMods.addMiddleware({
          name: ${JSON.stringify(middlewareName)},
          phase: ${JSON.stringify(phase)},
          expression: ${JSON.stringify(expression)},
          handler: async (payload, next, context = {}) => {
            const cdp = globalThis.CDPMods.attachToSession(context.cdpSessionId ?? null);
            const CDPMods = globalThis.CDPMods;
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
    expression: `globalThis.CDPMods.handleCommand(${JSON.stringify(method)}, ${JSON.stringify(params)}, ${JSON.stringify(cdpSessionId)})`,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  };
}

function wrapServiceWorkerCommand(method: string, params: ProtocolParams = {}, cdpSessionId: string | null = null) {
  if (method === "Mods.ping" && !Object.prototype.hasOwnProperty.call(params, "sentAt")) {
    params = { ...(params as CDPModsPingParams), sentAt: Date.now() };
  }

  if (method === "Mods.addCustomEvent") {
    const eventParams = params as { name: any };
    const eventName = normalizeCDPModsName(eventParams.name);
    return [
      {
        method: "Runtime.addBinding",
        params: { name: bindingNameFor(eventName) },
      },
      {
        method: "Runtime.evaluate",
        params: wrapCDPModsAddCustomEvent({ name: eventName }),
        unwrap: "evaluate" as const,
      },
    ];
  }

  let runtimeParams;
  if (method === "Mods.evaluate") {
    const evaluateParams = params as CDPModsEvaluateParams;
    runtimeParams = wrapCDPModsEvaluate({ ...evaluateParams, cdpSessionId: evaluateParams.cdpSessionId ?? cdpSessionId });
  } else if (method === "Mods.addCustomCommand") {
    runtimeParams = wrapCDPModsAddCustomCommand(params as CDPModsAddCustomCommandParams);
  } else if (method === "Mods.addMiddleware") {
    runtimeParams = wrapCDPModsAddMiddleware(params as CDPModsAddMiddlewareParams);
  } else {
    runtimeParams = wrapCustomCommand(
      method,
      params,
      ((params as CDPModsCustomPayload).cdpSessionId as string) ?? cdpSessionId,
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

// --- inbound: Runtime.* result/event -> CDPMods value/event ----------------

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

// Returns { event, data } or null when the binding is not a CDPMods event,
// when the payload is scoped to a different cdpSessionId than ourSessionId,
// or when the payload string is not valid JSON.
export function unwrapEventIfNeeded(
  method: string,
  params: RuntimeBindingCalledEvent,
  sessionId: string | null = null,
  ourSessionId: string | null = null,
): UnwrappedCDPModsEvent | null {
  if (method !== "Runtime.bindingCalled") return null;
  let payload: CDPModsBindingPayload;
  try {
    payload = JSON.parse(params.payload || "{}");
  } catch {
    return null;
  }
  if (payload == null || typeof payload !== "object") return null;
  const event = eventNameFor(params?.name || "");
  if (!event) return null;
  if (typeof payload.event === "string" && payload.event.length > 0 && payload.event !== event) return null;
  if (ourSessionId != null && payload.cdpSessionId && payload.cdpSessionId !== ourSessionId) return null;
  const data = Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
  return { event, data, sessionId };
}

// --- shared encoder used by the extension service worker --------------------

export function encodeBindingPayload({ event, data, cdpSessionId = null }: CDPModsBindingPayload) {
  return JSON.stringify({ event, data, cdpSessionId });
}
