// @ts-nocheck
// Pure stateless translation between CDPMod and raw CDP frames.
// No I/O, no maps, no classes. Trivial to port to any language.
// Used on both the Node side (proxy + client) and the extension service worker
// side, so the binding payload format only has one definition.

import type {
  CDPModAddCustomCommandParams,
  CDPModAddMiddlewareParams,
  CDPModBindingPayload,
  CDPModCustomPayload,
  CDPModEvaluateParams,
  CDPModPingParams,
  CDPModRoutes,
  ProtocolParams,
  ProtocolResult,
  RuntimeBindingCalledEvent,
  TranslatedCommand,
  UnwrappedCDPModEvent,
} from "../types/cdpmod.js";
import type { cdp } from "../types/cdp.js";

export const BINDING_PREFIX = "__CDPMod_";

export const DEFAULT_CLIENT_ROUTES = {
  "Mod.*": "service_worker",
  "Custom.*": "service_worker",
  "*.*": "service_worker",
} satisfies CDPModRoutes;

type TranslateOptions = { routes?: CDPModRoutes; cdpSessionId?: string | null };

export const bindingNameFor = (eventName: string) =>
  BINDING_PREFIX + eventName.replaceAll(".", "_").replaceAll("*", "all");

export const eventNameFor = (bindingName: string) =>
  bindingName.startsWith(BINDING_PREFIX) ? bindingName.slice(BINDING_PREFIX.length).replaceAll("_", ".") : null;

function normalizeCDPModName(
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

export function routeFor(method: string, routes: CDPModRoutes = {}) {
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

// --- outbound: CDPMod method -> Runtime.* params on the extension session --

export function wrapCDPModEvaluate({
  expression,
  params = {},
  cdpSessionId = null,
}: CDPModEvaluateParams): cdp.types.ts.Runtime.EvaluateParams {
  return {
    expression: `
      (async () => {
        const params = ${JSON.stringify(params)};
        const cdp = globalThis.CDPMod.attachToSession(${JSON.stringify(cdpSessionId)});
        const CDPMod = globalThis.CDPMod;
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

export function wrapCDPModAddCustomCommand({
  name,
  expression,
}: CDPModAddCustomCommandParams): cdp.types.ts.Runtime.EvaluateParams {
  const commandName = normalizeCDPModName(name);
  return {
    expression: `
      (() => {
        return globalThis.CDPMod.addCustomCommand({
          name: ${JSON.stringify(commandName)},
          paramsSchema: null,
          resultSchema: null,
          expression: ${JSON.stringify(expression)},
          handler: async (params, cdpSessionId, method) => {
            const cdp = globalThis.CDPMod.attachToSession(cdpSessionId);
            const CDPMod = globalThis.CDPMod;
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

export function wrapCDPModAddCustomEvent({ name }: { name: string }): cdp.types.ts.Runtime.EvaluateParams {
  const eventName = normalizeCDPModName(name);
  return {
    expression: `
      globalThis.CDPMod.addCustomEvent({
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

export function wrapCDPModAddMiddleware({
  name = "*",
  phase,
  expression,
}: CDPModAddMiddlewareParams): cdp.types.ts.Runtime.EvaluateParams {
  const middlewareName = normalizeCDPModName(name);
  return {
    expression: `
      (() => {
        return globalThis.CDPMod.addMiddleware({
          name: ${JSON.stringify(middlewareName)},
          phase: ${JSON.stringify(phase)},
          expression: ${JSON.stringify(expression)},
          handler: async (payload, next, context = {}) => {
            const cdp = globalThis.CDPMod.attachToSession(context.cdpSessionId ?? null);
            const CDPMod = globalThis.CDPMod;
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
    expression: `globalThis.CDPMod.handleCommand(${JSON.stringify(method)}, ${JSON.stringify(params)}, ${JSON.stringify(cdpSessionId)})`,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  };
}

function wrapServiceWorkerCommand(method: string, params: ProtocolParams = {}, cdpSessionId: string | null = null) {
  if (method === "Mod.ping" && !Object.prototype.hasOwnProperty.call(params, "sentAt")) {
    params = { ...(params as CDPModPingParams), sentAt: Date.now() };
  }

  if (method === "Mod.addCustomEvent") {
    const eventParams = params as { name: any };
    const eventName = normalizeCDPModName(eventParams.name);
    return [
      {
        method: "Runtime.addBinding",
        params: { name: bindingNameFor(eventName) },
      },
      {
        method: "Runtime.evaluate",
        params: wrapCDPModAddCustomEvent({ name: eventName }),
        unwrap: "evaluate" as const,
      },
    ];
  }

  let runtimeParams;
  if (method === "Mod.evaluate") {
    const evaluateParams = params as CDPModEvaluateParams;
    runtimeParams = wrapCDPModEvaluate({ ...evaluateParams, cdpSessionId: evaluateParams.cdpSessionId ?? cdpSessionId });
  } else if (method === "Mod.addCustomCommand") {
    runtimeParams = wrapCDPModAddCustomCommand(params as CDPModAddCustomCommandParams);
  } else if (method === "Mod.addMiddleware") {
    runtimeParams = wrapCDPModAddMiddleware(params as CDPModAddMiddlewareParams);
  } else {
    runtimeParams = wrapCustomCommand(
      method,
      params,
      ((params as CDPModCustomPayload).cdpSessionId as string) ?? cdpSessionId,
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

// --- inbound: Runtime.* result/event -> CDPMod value/event ----------------

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

// Returns { event, data } or null when the binding is not a CDPMod event,
// when the payload is scoped to a different cdpSessionId than ourSessionId,
// or when the payload string is not valid JSON.
export function unwrapEventIfNeeded(
  method: string,
  params: RuntimeBindingCalledEvent,
  sessionId: string | null = null,
  ourSessionId: string | null = null,
): UnwrappedCDPModEvent | null {
  if (method !== "Runtime.bindingCalled") return null;
  let payload: CDPModBindingPayload;
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

export function encodeBindingPayload({ event, data, cdpSessionId = null }: CDPModBindingPayload) {
  return JSON.stringify({ event, data, cdpSessionId });
}
