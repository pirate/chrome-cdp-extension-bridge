// injector.mjs: inject the MagicCDP extension service worker when needed in a
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
//   3. Otherwise throw with explicit instructions for both failure modes,
//      including the --load-extension fallback for Chrome builds where
//      Extensions.loadUnpacked is unavailable.

const SW_URL_RE = /^chrome-extension:\/\/[a-z]+\/service_worker\.js$/;
const EXT_ID_FROM_URL = /^chrome-extension:\/\/([a-z]+)\//;

export async function injectExtensionIfNeeded({ send, extensionPath, timeoutMs = 10_000, discoveryWaitMs = 2_000 } = {}) {
  if (typeof send !== "function") throw new Error("injectExtensionIfNeeded requires { send }");
  // extensionPath is only required as a fallback, when discovery does not turn
  // up an already-loaded MagicCDP service worker. Validate at the point of use
  // (step 2) so callers running against a browser that already has the
  // extension loaded don't have to provide a path at all.

  // 1. Discover an existing MagicCDP service worker. Extensions loaded with
  // --load-extension at browser launch take a moment to spin their SW *and*
  // for the SW's top-level module init to run, so we attach to each candidate
  // and re-probe its globalThis until either MagicCDP appears or we time out.
  const attached = []; // [{ targetId, url, sessionId }]
  const discoveryDeadline = Date.now() + discoveryWaitMs;
  while (Date.now() <= discoveryDeadline) {
    const { targetInfos } = await send("Target.getTargets");
    for (const candidate of targetInfos) {
      if (candidate.type !== "service_worker") continue;
      if (!SW_URL_RE.test(candidate.url)) continue;
      if (attached.some(a => a.targetId === candidate.targetId)) continue;
      const { sessionId } = await send("Target.attachToTarget", { targetId: candidate.targetId, flatten: true });
      attached.push({ targetId: candidate.targetId, url: candidate.url, sessionId });
    }
    for (const a of attached) {
      const probe = await send("Runtime.evaluate", {
        expression: "Boolean(globalThis.MagicCDP?.handleCommand && globalThis.MagicCDP?.addCustomEvent)",
        returnByValue: true,
      }, a.sessionId);
      if (probe.result?.value === true) {
        // detach every other speculative session before returning
        for (const other of attached) {
          if (other.sessionId === a.sessionId) continue;
          await send("Target.detachFromTarget", { sessionId: other.sessionId }).catch(() => {});
        }
        return {
          source: "discovered",
          extensionId: a.url.match(EXT_ID_FROM_URL)[1],
          targetId: a.targetId,
          url: a.url,
          sessionId: a.sessionId,
        };
      }
    }
    if (Date.now() >= discoveryDeadline) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const a of attached) await send("Target.detachFromTarget", { sessionId: a.sessionId }).catch(() => {});

  // 2. Try Extensions.loadUnpacked.
  if (!extensionPath) {
    throw new Error(
      `No existing MagicCDP service worker was found and no extensionPath was provided to install one.\n` +
      `Either start the browser with --load-extension=<path> so the SW exists at connect time, or pass extensionPath to injectExtensionIfNeeded/MagicCDPClient.`,
    );
  }
  let loadResult;
  try {
    loadResult = await send("Extensions.loadUnpacked", { path: extensionPath });
  } catch (error) {
    if (/Method not available|Method.*not.*found|wasn't found/i.test(error.message)) {
      throw new Error(
        `Cannot install MagicCDP extension into the running browser.\n\n` +
        `  - No existing service worker with globalThis.MagicCDP was found in the browser.\n` +
        `  - Extensions.loadUnpacked is unavailable in this Chrome build (\"${error.message}\").\n\n` +
        `Fixes (any one of these):\n` +
        `  1. Relaunch the browser with --load-extension=${extensionPath} (Chromium / Playwright builds).\n` +
        `  2. Use Chrome Canary, which exposes Extensions.loadUnpacked over CDP.\n` +
        `  3. Manually install the extension at chrome://extensions and reuse the running browser.\n`,
      );
    }
    throw new Error(
      `Extensions.loadUnpacked failed for ${extensionPath}: ${error.message}\n` +
      `If the path is correct and the manifest is valid, the browser may not be running with --enable-unsafe-extension-debugging.`,
    );
  }
  const extensionId = loadResult?.id || loadResult?.extensionId;
  if (!extensionId) {
    throw new Error(`Extensions.loadUnpacked returned no extension id (got ${JSON.stringify(loadResult)})`);
  }

  // 3. Wait for the loaded extension's service worker target.
  const swUrl = `chrome-extension://${extensionId}/service_worker.js`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { targetInfos } = await send("Target.getTargets");
    const target = targetInfos.find(t => t.type === "service_worker" && t.url === swUrl);
    if (target) {
      const { sessionId } = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      return { source: "injected", extensionId, targetId: target.targetId, url: swUrl, sessionId };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(
    `Extensions.loadUnpacked installed extension ${extensionId} but its service worker target ` +
    `at ${swUrl} did not appear within ${timeoutMs}ms.`,
  );
}
