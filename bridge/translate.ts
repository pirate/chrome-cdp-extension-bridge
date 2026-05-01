// Pure stateless translation between MagicCDP and raw CDP frames.
// No I/O, no maps, no classes. Trivial to port to any language.
// Used on both the Node side (proxy + client) and the extension service worker
// side, so the binding payload format only has one definition.

import type {
  MagicAddCustomCommandParams,
  MagicAddCustomEventParams,
  MagicAddMiddlewareParams,
  MagicBindingPayload,
  MagicCustomPayload,
  MagicEvaluateParams,
  MagicPingParams,
  MagicRoutes,
  ProtocolParams,
  ProtocolResult,
  RuntimeBindingCalledEvent,
  TranslatedCommand,
  UnwrappedMagicEvent,
} from "../types/magic.js";
import type { cdp } from "../types/cdp.js";

export const BINDING_PREFIX = "__MagicCDP_";

export const DEFAULT_CLIENT_ROUTES = {
  "Magic.*": "service_worker",
  "Custom.*": "service_worker",
  "*.*": "direct_cdp",
} satisfies MagicRoutes;

type TranslateOptions = { routes?: MagicRoutes; cdpSessionId?: string | null };

export const bindingNameFor = (eventName: string) => BINDING_PREFIX + eventName.replaceAll(".", "_");

export const eventNameFor = (bindingName: string) =>
  bindingName.startsWith(BINDING_PREFIX) ? bindingName.slice(BINDING_PREFIX.length).replaceAll("_", ".") : null;

function normalizeMagicName(
  value: { id?: string; name?: string; meta?: () => { id?: unknown; name?: unknown } } | string,
) {
  if (typeof value === "string") return value;
  const meta = typeof value?.meta === "function" ? value.meta() : undefined;
  const name =
    value?.id ??
    (typeof meta?.id === "string" ? meta.id : undefined) ??
    (typeof meta?.name === "string" ? meta.name : undefined) ??
    value?.name;
  if (typeof name !== "string" || !name) throw new Error("Expected a CDP name string or a named CDP schema/alias.");
  return name;
}

export function routeFor(method: string, routes: MagicRoutes = {}) {
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

// --- outbound: MagicCDP method -> Runtime.* params on the extension session --

export function wrapMagicEvaluate({
  expression,
  params = {},
  cdpSessionId = null,
}: MagicEvaluateParams): cdp.types.ts.Runtime.EvaluateParams {
  return {
    expression: `
      (async () => {
        const params = ${JSON.stringify(params)};
        const cdp = globalThis.MagicCDP.attachToSession(${JSON.stringify(cdpSessionId)});
        const MagicCDP = globalThis.MagicCDP;
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

export function wrapMagicAddCustomCommand({
  name,
  expression,
}: MagicAddCustomCommandParams): cdp.types.ts.Runtime.EvaluateParams {
  const commandName = normalizeMagicName(name);
  return {
    expression: `
      (() => {
        return globalThis.MagicCDP.addCustomCommand({
          name: ${JSON.stringify(commandName)},
          paramsSchema: null,
          resultSchema: null,
          expression: ${JSON.stringify(expression)},
          handler: async (params, cdpSessionId) => {
            const cdp = globalThis.MagicCDP.attachToSession(cdpSessionId);
            const MagicCDP = globalThis.MagicCDP;
            const chrome = globalThis.chrome;
            const handler = (${expression});
            return await handler(params || {});
          },
        });
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  };
}

export function wrapMagicAddCustomEvent({ name }: MagicAddCustomEventParams): cdp.types.ts.Runtime.EvaluateParams {
  const eventName = normalizeMagicName(name);
  return {
    expression: `
      globalThis.MagicCDP.addCustomEvent({
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

export function wrapMagicAddMiddleware({
  name = "*",
  phase,
  expression,
}: MagicAddMiddlewareParams): cdp.types.ts.Runtime.EvaluateParams {
  const middlewareName = normalizeMagicName(name);
  return {
    expression: `
      (() => {
        return globalThis.MagicCDP.addMiddleware({
          name: ${JSON.stringify(middlewareName)},
          phase: ${JSON.stringify(phase)},
          expression: ${JSON.stringify(expression)},
          handler: async (payload, next, context = {}) => {
            const cdp = globalThis.MagicCDP.attachToSession(context.cdpSessionId ?? null);
            const MagicCDP = globalThis.MagicCDP;
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
    expression: `globalThis.MagicCDP.handleCommand(${JSON.stringify(method)}, ${JSON.stringify(params)}, ${JSON.stringify(cdpSessionId)})`,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  };
}

function wrapServiceWorkerCommand(method: string, params: ProtocolParams = {}, cdpSessionId: string | null = null) {
  if (method === "Magic.ping" && !Object.prototype.hasOwnProperty.call(params, "sentAt")) {
    params = { ...(params as MagicPingParams), sentAt: Date.now() };
  }

  if (method === "Magic.addCustomEvent") {
    const eventParams = params as MagicAddCustomEventParams;
    const eventName = normalizeMagicName(eventParams.name);
    return [
      {
        method: "Runtime.addBinding",
        params: { name: bindingNameFor(eventName) },
      },
      {
        method: "Runtime.evaluate",
        params: wrapMagicAddCustomEvent({ name: eventName }),
        unwrap: "evaluate" as const,
      },
    ];
  }

  let runtimeParams;
  if (method === "Magic.evaluate") {
    const evaluateParams = params as MagicEvaluateParams;
    runtimeParams = wrapMagicEvaluate({ ...evaluateParams, cdpSessionId: evaluateParams.cdpSessionId ?? cdpSessionId });
  } else if (method === "Magic.addCustomCommand") {
    runtimeParams = wrapMagicAddCustomCommand(params as MagicAddCustomCommandParams);
  } else if (method === "Magic.addMiddleware") {
    runtimeParams = wrapMagicAddMiddleware(params as MagicAddMiddlewareParams);
  } else {
    runtimeParams = wrapCustomCommand(
      method,
      params,
      ((params as MagicCustomPayload).cdpSessionId as string) ?? cdpSessionId,
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
  if (route === "service_worker") {
    return {
      route,
      target: "service_worker",
      steps: wrapServiceWorkerCommand(method, params, cdpSessionId),
    };
  }
  throw new Error(`Unsupported client route "${route}" for ${method}`);
}

// --- inbound: Runtime.* result/event -> MagicCDP value/event ----------------

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

// Returns { event, data } or null when the binding is not a MagicCDP event,
// when the payload is scoped to a different cdpSessionId than ourSessionId,
// or when the payload string is not valid JSON.
export function unwrapEventIfNeeded(
  method: string,
  params: RuntimeBindingCalledEvent,
  sessionId: string | null = null,
  ourSessionId: string | null = null,
): UnwrappedMagicEvent | null {
  if (method !== "Runtime.bindingCalled") return null;
  const event = eventNameFor(params?.name || "");
  if (!event) return null;
  let payload: MagicBindingPayload;
  try {
    payload = JSON.parse(params.payload || "{}");
  } catch {
    return null;
  }
  if (payload == null || typeof payload !== "object") return null;
  if (ourSessionId != null && payload.cdpSessionId && payload.cdpSessionId !== ourSessionId) return null;
  const data = Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
  return { event, data, sessionId };
}

// --- shared encoder used by the extension service worker --------------------

export function encodeBindingPayload({ event, data, cdpSessionId = null }: MagicBindingPayload) {
  return JSON.stringify({ event, data, cdpSessionId });
}
