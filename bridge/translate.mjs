// Pure stateless translation between MagicCDP and raw CDP frames.
// No I/O, no maps, no classes. Trivial to port to any language.
// Used on both the Node side (proxy + client) and the extension service worker
// side, so the binding payload format only has one definition.

export const BINDING_PREFIX = "__MagicCDP_";

export const bindingNameFor = eventName => BINDING_PREFIX + eventName.replaceAll(".", "_");

export const eventNameFor = bindingName =>
  bindingName.startsWith(BINDING_PREFIX) ? bindingName.slice(BINDING_PREFIX.length).replaceAll("_", ".") : null;

// --- outbound: MagicCDP method -> Runtime.* params on the extension session --

export function wrapMagicEvaluate({ expression, params = {}, cdpSessionId = null } = {}) {
  return {
    expression: `
      (async () => {
        const params = ${JSON.stringify(params)};
        const cdp = globalThis.MagicCDP.attachToSession(${JSON.stringify(cdpSessionId)});
        const context = { cdp, MagicCDP: globalThis.MagicCDP, chrome: globalThis.chrome };
        const value = (${expression});
        return typeof value === "function" ? await value(params, context) : value;
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
        const handler = (${expression});
        return globalThis.MagicCDP.addCustomCommand({
          name: ${JSON.stringify(name)},
          paramsSchema: ${JSON.stringify(paramsSchema)},
          resultSchema: ${JSON.stringify(resultSchema)},
          expression: ${JSON.stringify(expression)},
          handler: async (params, meta) => {
            const cdp = globalThis.MagicCDP.attachToSession(meta.cdpSessionId);
            return await handler(params || {}, { cdp, MagicCDP: globalThis.MagicCDP, chrome: globalThis.chrome, meta });
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
