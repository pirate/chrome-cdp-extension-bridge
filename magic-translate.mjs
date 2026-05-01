// Pure stateless translation between MagicCDP and raw CDP frames.
// No I/O, no maps, no classes. Trivial to port to any language.

export const BINDING_PREFIX = "__MagicCDP_";
export const bindingFor = name => BINDING_PREFIX + name.replaceAll(".", "_");
export const eventFor = binding =>
  binding.startsWith(BINDING_PREFIX) ? binding.slice(BINDING_PREFIX.length).replaceAll("_", ".") : null;

const evalParams = expression => ({
  expression,
  awaitPromise: true,
  returnByValue: true,
  allowUnsafeEvalBlockedByCSP: true,
});

export function wrapEvaluate({ expression, params = {}, cdpSessionId = null } = {}) {
  return evalParams(`
    (async () => {
      const params = ${JSON.stringify(params)};
      const cdp = globalThis.MagicCDP.attachToSession(${JSON.stringify(cdpSessionId)});
      const context = { cdp, MagicCDP: globalThis.MagicCDP, Magic: globalThis.Magic, chrome: globalThis.chrome };
      const value = (${expression});
      return typeof value === "function" ? await value(params, context) : value;
    })()
  `);
}

export function wrapAddCustomCommand({ name, expression, paramsSchema = null, resultSchema = null } = {}) {
  return evalParams(`
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
  `);
}

export function wrapAddCustomEventEval({ name, payloadSchema = null } = {}) {
  return evalParams(`
    globalThis.MagicCDP.addCustomEvent({
      name: ${JSON.stringify(name)},
      bindingName: ${JSON.stringify(bindingFor(name))},
      payloadSchema: ${JSON.stringify(payloadSchema)},
    })
  `);
}

export function wrapCustomCommand(method, params = {}, cdpSessionId = null) {
  return evalParams(
    `globalThis.MagicCDP.handleCommand(${JSON.stringify(method)}, ${JSON.stringify(params)}, ${JSON.stringify({ cdpSessionId })})`
  );
}

export function unwrapEvaluateResult(result) {
  if (result?.exceptionDetails) {
    const ex = result.exceptionDetails;
    throw new Error(ex.exception?.description || ex.text || "Runtime.evaluate failed");
  }
  return result?.result?.value;
}

// Returns { event, data } or null when the binding is not a MagicCDP event,
// or when the payload is scoped to a different cdpSessionId than ourSessionId.
export function unwrapBindingCalled(params, ourSessionId = null) {
  const event = eventFor(params?.name || "");
  if (!event) return null;
  const payload = JSON.parse(params.payload || "{}");
  if (ourSessionId != null && payload.cdpSessionId && payload.cdpSessionId !== ourSessionId) return null;
  const data = Object.prototype.hasOwnProperty.call(payload, "data") ? payload.data : payload;
  return { event, data };
}
