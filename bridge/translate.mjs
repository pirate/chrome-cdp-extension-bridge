// Pure stateless translation between MagicCDP and raw CDP frames.
// No I/O, no maps, no classes. Trivial to port to any language.
// Used on both the Node side (proxy + client) and the extension service worker
// side, so the binding payload format only has one definition.

export const BINDING_PREFIX = "__MagicCDP_";

export const DEFAULT_CLIENT_ROUTES = {
  "Magic.*": "service_worker",
  "Custom.*": "service_worker",
  "*.*": "direct_cdp",
};

export const bindingNameFor = eventName => BINDING_PREFIX + eventName.replaceAll(".", "_");

export const eventNameFor = bindingName =>
  bindingName.startsWith(BINDING_PREFIX) ? bindingName.slice(BINDING_PREFIX.length).replaceAll("_", ".") : null;

export function routeFor(method, routes = {}) {
  if (Object.prototype.hasOwnProperty.call(routes, method)) return routes[method];
  let bestPrefixLen = -1;
  let bestRoute = null;
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

export function wrapMagicEvaluate({ expression, params = {}, cdpSessionId = null } = {}) {
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

export function wrapMagicAddCustomCommand({ name, expression, paramsSchema = null, resultSchema = null } = {}) {
  return {
    expression: `
      (() => {
        return globalThis.MagicCDP.addCustomCommand({
          name: ${JSON.stringify(name)},
          paramsSchema: ${JSON.stringify(paramsSchema)},
          resultSchema: ${JSON.stringify(resultSchema)},
          expression: ${JSON.stringify(expression)},
          handler: async (params, meta) => {
            const cdp = globalThis.MagicCDP.attachToSession(meta.cdpSessionId);
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

export function wrapMagicAddCustomEvent({ name, payloadSchema = null } = {}) {
  return {
    expression: `
      globalThis.MagicCDP.addCustomEvent({
        name: ${JSON.stringify(name)},
        bindingName: ${JSON.stringify(bindingNameFor(name))},
        payloadSchema: ${JSON.stringify(payloadSchema)},
      })
    `,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  };
}

export function wrapCustomCommand(method, params = {}, cdpSessionId = null) {
  return {
    expression: `globalThis.MagicCDP.handleCommand(${JSON.stringify(method)}, ${JSON.stringify(params)}, ${JSON.stringify({ cdpSessionId })})`,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  };
}

export function wrapMagicConfigure(config = {}) {
  return {
    expression: `
      (async () => {
        const deadline = Date.now() + 5000;
        while (!globalThis.MagicCDP?.configure && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (!globalThis.MagicCDP?.configure) throw new Error("MagicCDP service worker global is unavailable.");
        return globalThis.MagicCDP.configure(${JSON.stringify(config)});
      })()
    `,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  };
}

export function translateServiceWorkerCommand(method, params = {}, cdpSessionId = null) {
  if (method === "Magic.addCustomEvent") {
    return [
      {
        method: "Runtime.addBinding",
        params: { name: bindingNameFor(params.name) },
      },
      {
        method: "Runtime.evaluate",
        params: wrapMagicAddCustomEvent({ name: params.name, payloadSchema: params.payloadSchema ?? null }),
        unwrap: "evaluate",
      },
    ];
  }

  let runtimeParams;
  if (method === "Magic.evaluate") {
    runtimeParams = wrapMagicEvaluate({ ...params, cdpSessionId: params.cdpSessionId ?? cdpSessionId });
  } else if (method === "Magic.addCustomCommand") {
    runtimeParams = wrapMagicAddCustomCommand(params);
  } else {
    runtimeParams = wrapCustomCommand(method, params, params.cdpSessionId ?? cdpSessionId);
  }

  return [
    {
      method: "Runtime.evaluate",
      params: runtimeParams,
      unwrap: "evaluate",
    },
  ];
}

export function translateClientCommand(method, params = {}, { routes = DEFAULT_CLIENT_ROUTES, cdpSessionId = null } = {}) {
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
      steps: translateServiceWorkerCommand(method, params, cdpSessionId),
    };
  }
  throw new Error(`Unsupported client route "${route}" for ${method}`);
}

export function translateServerConfigure(config = {}) {
  return {
    target: "service_worker",
    steps: [
      {
        method: "Runtime.evaluate",
        params: wrapMagicConfigure(config),
        unwrap: "evaluate",
      },
    ],
  };
}

// --- inbound: Runtime.* result/event -> MagicCDP value/event ----------------

export function unwrapEvaluateResult(result) {
  if (result?.exceptionDetails) {
    const ex = result.exceptionDetails;
    throw new Error(ex.exception?.description || ex.text || "Runtime.evaluate failed");
  }
  return result?.result?.value;
}

// Returns { event, data } or null when the binding is not a MagicCDP event,
// when the payload is scoped to a different cdpSessionId than ourSessionId,
// or when the payload string is not valid JSON.
export function unwrapBindingCalled(params, ourSessionId = null) {
  const event = eventNameFor(params?.name || "");
  if (!event) return null;
  let payload;
  try { payload = JSON.parse(params.payload || "{}"); }
  catch { return null; }
  if (payload == null || typeof payload !== "object") return null;
  if (ourSessionId != null && payload.cdpSessionId && payload.cdpSessionId !== ourSessionId) return null;
  const data = Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
  return { event, data };
}

// --- shared encoder used by the extension service worker --------------------

export function encodeBindingPayload({ event, data, cdpSessionId = null }) {
  return JSON.stringify({ event, data, cdpSessionId });
}
