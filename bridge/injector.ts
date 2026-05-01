// injector.js: inject the MagicCDP extension service worker when needed in a
// running Chrome and return a CDP session attached to it.
//
// The caller hands in a `send(method, params, sessionId?)` function bound to
// the upstream CDP websocket. The injector knows about Extensions.loadUnpacked,
// service-worker URL pattern matching, and probe-by-globalThis.MagicCDP, but
// nothing about chrome binaries, the proxy, or wrap/unwrap.
//
// Precedence (single source of truth — do not duplicate this in proxy/client):
//   1. Look for an existing service-worker target whose JS context already has
//      globalThis.MagicCDP. Use it. (source: "discovered")
//   2. Otherwise call Extensions.loadUnpacked(extensionPath) and wait for that
//      extension's service worker to appear. (source: "injected")
//   3. If Chrome refuses extension loading, bootstrap MagicCDP into every
//      already-running extension service worker target and use the best one.
//      (source: "borrowed")
//   4. Otherwise throw with explicit instructions for all failure modes.

import type { ProtocolParams, ProtocolResult } from "../types/magic.js";
import { commands } from "../types/zod.js";
import { installMagicCDPServer } from "../extension/MagicCDPServer.js";

const EXT_ID_FROM_URL = /^chrome-extension:\/\/([a-z]+)\//;

type SendCDP = (method: string, params?: ProtocolParams, sessionId?: string | null) => Promise<ProtocolResult>;

const bootstrapMagicCDPServerExpression = `
  (() => {
    const installMagicCDPServer = ${installMagicCDPServer.toString()};
    const MagicCDP = installMagicCDPServer(globalThis);
    return {
      ok: Boolean(MagicCDP?.__MagicCDPServerVersion === 1 && MagicCDP?.handleCommand && MagicCDP?.addCustomEvent),
      extensionId: globalThis.chrome?.runtime?.id ?? null,
      hasTabs: Boolean(globalThis.chrome?.tabs?.query),
      hasDebugger: Boolean(globalThis.chrome?.debugger?.sendCommand),
    };
  })()
`;

export async function injectExtensionIfNeeded({
  send,
  extensionPath,
  timeoutMs = 10_000,
  discoveryWaitMs = 2_000,
}: {
  send: SendCDP;
  extensionPath?: string | null;
  timeoutMs?: number;
  discoveryWaitMs?: number;
}) {
  if (typeof send !== "function") throw new Error("injectExtensionIfNeeded requires { send }");
  const sendWithTimeout = (method: string, params: ProtocolParams = {}, sessionId: string | null = null, ms = 2_000) =>
    Promise.race([
      send(method, params, sessionId),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${method} timed out after ${ms}ms`)), ms)),
    ]);
  // extensionPath is only required as a fallback, when discovery does not turn
  // up an already-loaded MagicCDP service worker. Validate at the point of use
  // (step 2) so callers running against a browser that already has the
  // extension loaded don't have to provide a path at all.

  // 1. Discover an existing MagicCDP service worker. Extensions loaded with
  // --load-extension at browser launch take a moment to spin their SW *and*
  // for the SW's top-level module init to run, so we attach to each candidate
  // and re-probe its globalThis until either MagicCDP appears or we time out.
  const attached: { targetId: string; url: string; sessionId: string }[] = [];
  const discoveryDeadline = Date.now() + discoveryWaitMs;
  while (Date.now() <= discoveryDeadline) {
    const { targetInfos } = commands["Target.getTargets"].result.parse(await send("Target.getTargets"));
    for (const candidate of targetInfos) {
      if (candidate.type !== "service_worker") continue;
      if (!candidate.url.startsWith("chrome-extension://")) continue;
      if (attached.some((a) => a.targetId === candidate.targetId)) continue;
      try {
        const { sessionId } = commands["Target.attachToTarget"].result.parse(
          await sendWithTimeout("Target.attachToTarget", { targetId: candidate.targetId, flatten: true }),
        );
        attached.push({ targetId: candidate.targetId, url: candidate.url, sessionId });
      } catch {}
    }
    for (const a of attached) {
      let probe;
      try {
        probe = commands["Runtime.evaluate"].result.parse(
          await sendWithTimeout(
            "Runtime.evaluate",
            {
              expression:
                "Boolean(globalThis.MagicCDP?.__MagicCDPServerVersion === 1 && globalThis.MagicCDP?.handleCommand && globalThis.MagicCDP?.addCustomEvent)",
              returnByValue: true,
            },
            a.sessionId,
          ),
        );
      } catch {
        continue;
      }
      if (probe.result?.value === true) {
        // detach every other speculative session before returning
        for (const other of attached) {
          if (other.sessionId === a.sessionId) continue;
          await send("Target.detachFromTarget", { sessionId: other.sessionId }).catch(() => {});
        }
        return {
          source: "discovered",
          extensionId: a.url.match(EXT_ID_FROM_URL)?.[1],
          targetId: a.targetId,
          url: a.url,
          sessionId: a.sessionId,
        };
      }
    }
    if (Date.now() >= discoveryDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const a of attached) await send("Target.detachFromTarget", { sessionId: a.sessionId }).catch(() => {});

  // 2. Try Extensions.loadUnpacked.
  let loadUnpackedUnavailableError: Error | null = null;
  if (!extensionPath) {
    loadUnpackedUnavailableError = new Error("No extensionPath was provided.");
  } else {
    let loadResult;
    try {
      loadResult = await send("Extensions.loadUnpacked", { path: extensionPath });
    } catch (error) {
      if (/Method not available|Method.*not.*found|wasn't found/i.test(error.message)) {
        loadUnpackedUnavailableError = error;
      } else {
        throw new Error(
          `Extensions.loadUnpacked failed for ${extensionPath}: ${error.message}\n` +
            `If the path is correct and the manifest is valid, load the MagicCDP extension manually in chrome://extensions and reconnect.`,
        );
      }
    }

    if (!loadUnpackedUnavailableError) {
      const extensionId = loadResult?.id || loadResult?.extensionId;
      if (!extensionId) {
        throw new Error(`Extensions.loadUnpacked returned no extension id (got ${JSON.stringify(loadResult)})`);
      }

      // 3. Wait for the loaded extension's service worker target.
      const swUrl = `chrome-extension://${extensionId}/service_worker.js`;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { targetInfos } = commands["Target.getTargets"].result.parse(await send("Target.getTargets"));
        const target = targetInfos.find((t) => t.type === "service_worker" && t.url === swUrl);
        if (target) {
          const { sessionId } = commands["Target.attachToTarget"].result.parse(
            await send("Target.attachToTarget", { targetId: target.targetId, flatten: true }),
          );
          const probe = commands["Runtime.evaluate"].result.parse(
            await send(
              "Runtime.evaluate",
              {
                expression:
                  "Boolean(globalThis.MagicCDP?.__MagicCDPServerVersion === 1 && globalThis.MagicCDP?.handleCommand && globalThis.MagicCDP?.addCustomEvent)",
                returnByValue: true,
              },
              sessionId,
            ),
          );
          if (probe.result?.value === true) {
            return { source: "injected", extensionId, targetId: target.targetId, url: swUrl, sessionId };
          }
          await send("Target.detachFromTarget", { sessionId }).catch(() => {});
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(
        `Extensions.loadUnpacked installed extension ${extensionId} but its service worker target ` +
          `at ${swUrl} did not appear within ${timeoutMs}ms.`,
      );
    }
  }

  // 4. Chrome's new chrome://inspect auto-connect flow exposes CDP without
  // exposing Extensions.loadUnpacked. In that case, inject the same server into
  // every currently running extension service worker and keep the best session.
  const borrowed: {
    targetId: string;
    url: string;
    sessionId: string;
    extensionId?: string | null;
    hasTabs?: boolean;
    hasDebugger?: boolean;
  }[] = [];
  const { targetInfos } = commands["Target.getTargets"].result.parse(await send("Target.getTargets"));
  for (const target of targetInfos) {
    if (target.type !== "service_worker") continue;
    if (!target.url.startsWith("chrome-extension://")) continue;

    let sessionId: string | null = null;
    try {
      sessionId = commands["Target.attachToTarget"].result.parse(
        await sendWithTimeout("Target.attachToTarget", { targetId: target.targetId, flatten: true }),
      ).sessionId;
      await send("Runtime.enable", {}, sessionId).catch(() => {});
      const bootstrap = commands["Runtime.evaluate"].result.parse(
        await sendWithTimeout(
          "Runtime.evaluate",
          {
            expression: bootstrapMagicCDPServerExpression,
            awaitPromise: true,
            returnByValue: true,
            allowUnsafeEvalBlockedByCSP: true,
          },
          sessionId,
          3_000,
        ),
      );
      const value = bootstrap.result?.value || {};
      if (value.ok) {
        borrowed.push({
          targetId: target.targetId,
          url: target.url,
          sessionId,
          extensionId: value.extensionId || target.url.match(EXT_ID_FROM_URL)?.[1] || null,
          hasTabs: Boolean(value.hasTabs),
          hasDebugger: Boolean(value.hasDebugger),
        });
      } else {
        await send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    } catch {
      if (sessionId) await send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
  }

  borrowed.sort((a, b) => Number(b.hasDebugger) - Number(a.hasDebugger) || Number(b.hasTabs) - Number(a.hasTabs));
  const selected = borrowed[0];
  for (const other of borrowed.slice(1))
    await send("Target.detachFromTarget", { sessionId: other.sessionId }).catch(() => {});
  if (selected) {
    return {
      source: "borrowed",
      extensionId: selected.extensionId,
      targetId: selected.targetId,
      url: selected.url,
      sessionId: selected.sessionId,
    };
  }

  throw new Error(
    `Cannot install or borrow MagicCDP in the running browser.\n\n` +
      `  - No existing service worker with globalThis.MagicCDP was found in the browser.\n` +
      `  - Extensions.loadUnpacked is unavailable ("${loadUnpackedUnavailableError.message}").\n` +
      `  - No running chrome-extension:// service worker target accepted the MagicCDP bootstrap.\n\n` +
      `Fixes (any one of these):\n` +
      `  1. Open or wake an installed extension that has a service worker, then reconnect.\n` +
      `  2. Load the MagicCDP extension once at chrome://extensions and reconnect.\n` +
      (extensionPath ? `  3. For automated/test browsers, relaunch with --load-extension=${extensionPath}.\n` : ""),
  );
}
