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
//   3. Otherwise throw with explicit instructions for both failure modes.

import type { ProtocolParams, ProtocolResult } from "../types/magic.js";
import { commands } from "../types/zod.js";
import crypto from "node:crypto";
import path from "node:path";

const SW_URL_RE = /^chrome-extension:\/\/[a-z]+\/service_worker\.js$/;
const EXT_ID_FROM_URL = /^chrome-extension:\/\/([a-z]+)\//;

type SendCDP = (method: string, params?: ProtocolParams, sessionId?: string | null) => Promise<ProtocolResult>;

function unpackedExtensionIdForPath(extensionPath: string) {
  return [...crypto.createHash("sha256").update(path.resolve(extensionPath)).digest().subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15)))
    .join("");
}

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
  // extensionPath is only required as a fallback, when discovery does not turn
  // up an already-loaded MagicCDP service worker. Validate at the point of use
  // (step 2) so callers running against a browser that already has the
  // extension loaded don't have to provide a path at all.

  let wakeupTargetId: string | null = null;
  const expectedExtensionId = extensionPath ? unpackedExtensionIdForPath(extensionPath) : null;
  if (expectedExtensionId) {
    try {
      const { targetId } = commands["Target.createTarget"].result.parse(
        await send("Target.createTarget", {
          url: `chrome-extension://${expectedExtensionId}/offscreen/keepalive.html?magic-cdp-wakeup=${Date.now()}`,
        }),
      );
      wakeupTargetId = targetId;
    } catch {}
  }

  // 1. Discover an existing MagicCDP service worker. Extensions loaded with
  // --load-extension at browser launch take a moment to spin their SW *and*
  // for the SW's top-level module init to run, so we attach to each candidate
  // and re-probe its globalThis until either MagicCDP appears or we time out.
  const attached: { targetId: string; url: string; sessionId: string }[] = []; // [{ targetId, url, sessionId }]
  const discoveryDeadline = Date.now() + discoveryWaitMs;
  while (Date.now() <= discoveryDeadline) {
    const { targetInfos } = commands["Target.getTargets"].result.parse(await send("Target.getTargets"));
    for (const candidate of targetInfos) {
      if (candidate.type !== "service_worker") continue;
      if (!SW_URL_RE.test(candidate.url)) continue;
      if (attached.some((a) => a.targetId === candidate.targetId)) continue;
      const { sessionId } = commands["Target.attachToTarget"].result.parse(
        await send("Target.attachToTarget", { targetId: candidate.targetId, flatten: true }),
      );
      attached.push({ targetId: candidate.targetId, url: candidate.url, sessionId });
    }
    for (const a of attached) {
      const probe = commands["Runtime.evaluate"].result.parse(
        await send(
          "Runtime.evaluate",
          {
            expression: "Boolean(globalThis.MagicCDP?.handleCommand && globalThis.MagicCDP?.addCustomEvent)",
            returnByValue: true,
          },
          a.sessionId,
        ),
      );
      if (probe.result?.value === true) {
        // detach every other speculative session before returning
        for (const other of attached) {
          if (other.sessionId === a.sessionId) continue;
          await send("Target.detachFromTarget", { sessionId: other.sessionId }).catch(() => {});
        }
        if (wakeupTargetId) await send("Target.closeTarget", { targetId: wakeupTargetId }).catch(() => {});
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
  if (wakeupTargetId) await send("Target.closeTarget", { targetId: wakeupTargetId }).catch(() => {});

  // 2. Try Extensions.loadUnpacked.
  if (!extensionPath) {
    throw new Error(
      `No existing MagicCDP service worker was found and no extensionPath was provided to install one.\n` +
        `Either load/install the MagicCDP extension in this Chrome profile, or pass extensionPath to injectExtensionIfNeeded/MagicCDPClient.`,
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
          `  - Extensions.loadUnpacked is unavailable in this Chrome build ("${error.message}").\n\n` +
          `Fixes (any one of these):\n` +
          `  1. In stock Chrome, load the extension once at chrome://extensions and reconnect to the live localhost:9222 browser.\n` +
          `  2. For automated/test browsers, relaunch with --load-extension=${extensionPath}.\n` +
          `  3. Use a Chrome build/profile that exposes Extensions.loadUnpacked over CDP.\n`,
      );
    }
    throw new Error(
      `Extensions.loadUnpacked failed for ${extensionPath}: ${error.message}\n` +
        `If the path is correct and the manifest is valid, load the MagicCDP extension manually in chrome://extensions and reconnect.`,
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
            expression: "Boolean(globalThis.MagicCDP?.handleCommand && globalThis.MagicCDP?.addCustomEvent)",
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
