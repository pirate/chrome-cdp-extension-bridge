// @ts-nocheck
// injector.js: inject the CDPMods extension service worker when needed in a
// running Chrome and return a CDP session attached to it.
//
// The caller hands in a `send(method, params, session_id?)` function bound to
// the upstream CDP websocket. The injector knows about Extensions.loadUnpacked,
// service-worker URL pattern matching, and probe-by-globalThis.CDPMods, but
// nothing about chrome binaries, the proxy, or wrap/unwrap.
//
// Precedence (single source of truth — do not duplicate this in proxy/client):
//   1. Look for an existing service-worker target whose JS context already has
//      globalThis.CDPMods. Use it. (source: "discovered")
//   2. Otherwise call Extensions.loadUnpacked(extension_path) and wait for that
//      extension's service worker to appear. (source: "injected")
//   3. If Chrome refuses extension loading, bootstrap CDPMods into every
//      already-running extension service worker target and use the best one.
//      (source: "borrowed")
//   4. Otherwise throw with explicit instructions for all failure modes.

import type { ProtocolParams, ProtocolResult } from "../types/cdpmods.js";
import { commands } from "../types/zod.js";
import { installCDPModsServer } from "../extension/CDPModsServer.js";

const EXT_ID_FROM_URL = /^chrome-extension:\/\/([a-z]+)\//;
const CDPMODS_READY_EXPRESSION =
  "Boolean(globalThis.CDPMods?.__CDPModsServerVersion === 1 && globalThis.CDPMods?.handleCommand && globalThis.CDPMods?.addCustomEvent)";

type SendCDP = (method: string, params?: ProtocolParams, session_id?: string | null) => Promise<ProtocolResult>;
type TargetInfo = { targetId: string; type?: string; url?: string };

const bootstrap_cdpmods_server_expression = `
  (() => {
    const __name = (fn) => fn;
    const installCDPModsServer = ${installCDPModsServer.toString()};
    const CDPMods = installCDPModsServer(globalThis);
    return {
      ok: Boolean(CDPMods?.__CDPModsServerVersion === 1 && CDPMods?.handleCommand && CDPMods?.addCustomEvent),
      extension_id: globalThis.chrome?.runtime?.id ?? null,
      has_tabs: Boolean(globalThis.chrome?.tabs?.query),
      has_debugger: Boolean(globalThis.chrome?.debugger?.sendCommand),
    };
  })()
`;

export async function injectExtensionIfNeeded({
  send,
  session_id_for_target = null,
  extension_path,
  service_worker_url_includes = [],
  service_worker_url_suffixes = [],
  trust_matched_service_worker = false,
  require_service_worker_target = false,
  service_worker_ready_expression = null,
}: {
  send: SendCDP;
  session_id_for_target?: ((target_id: string) => string | null | undefined) | null;
  extension_path?: string | null;
  service_worker_url_includes?: string[];
  service_worker_url_suffixes?: string[];
  trust_matched_service_worker?: boolean;
  require_service_worker_target?: boolean;
  service_worker_ready_expression?: string | null;
}) {
  if (typeof send !== "function") throw new Error("injectExtensionIfNeeded requires { send }");
  const ready_expression =
    service_worker_ready_expression == null || service_worker_ready_expression.length === 0
      ? CDPMODS_READY_EXPRESSION
      : `(${CDPMODS_READY_EXPRESSION}) && Boolean(${service_worker_ready_expression})`;
  const sendWithTimeout = (method: string, params: ProtocolParams = {}, session_id: string | null = null, ms = 2_000) =>
    Promise.race([
      send(method, params, session_id),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${method} timed out after ${ms}ms`)), ms)),
    ]);
  // extension_path is only required as a fallback, when discovery does not turn
  // up an already-loaded CDPMods service worker. Validate at the point of use
  // (step 2) so callers running against a browser that already has the
  // extension loaded don't have to provide a path at all.

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const sessionIdForTarget = (target_id: string) => {
    const session_id = session_id_for_target?.(target_id);
    return typeof session_id === "string" && session_id.length > 0 ? session_id : null;
  };
  const probeTarget = async (target: TargetInfo) => {
    const session_id = sessionIdForTarget(target.targetId);
    if (session_id == null) return null;
    const probe = commands["Runtime.evaluate"].result.parse(
      await sendWithTimeout(
        "Runtime.evaluate",
        {
          expression: ready_expression,
          returnByValue: true,
        },
        session_id,
      ),
    );
    if (probe.result?.value !== true) return null;
    return {
      extension_id: target.url?.match(EXT_ID_FROM_URL)?.[1],
      target_id: target.targetId,
      url: target.url,
      session_id,
    };
  };

  // 1. Discover an existing CDPMods service worker from the current CDP target
  // snapshot. If no already-ready worker is visible, move on to the explicit
  // injection path instead of waiting on a guessed preinstalled-extension budget.
  const target_infos = commands["Target.getTargets"].result.parse(await send("Target.getTargets")).targetInfos;
  if (trust_matched_service_worker) {
    const trusted_target = target_infos.find((candidate) => serviceWorkerTargetMatches(candidate)) as TargetInfo | undefined;
    if (trusted_target) {
      const probed = await probeTarget(trusted_target);
      if (probed) return { source: "trusted", ...probed };
    }
  }
  for (const candidate of target_infos) {
    if (candidate.type !== "service_worker") continue;
    if (!candidate.url.startsWith("chrome-extension://")) continue;
    try {
      const probed = await probeTarget(candidate as TargetInfo);
      if (probed) return { source: "discovered", ...probed };
    } catch {
      continue;
    }
  }
  if (require_service_worker_target) {
    throw new Error(
      `Required CDPMods service worker target was not visible in the current CDP target snapshot ` +
        `(${[...service_worker_url_includes, ...service_worker_url_suffixes].join(", ") || "no matcher"}).`,
    );
  }

  // 2. Try Extensions.loadUnpacked.
  let load_unpacked_unavailable_error: Error | null = null;
  if (!extension_path) {
    load_unpacked_unavailable_error = new Error("No extension_path was provided.");
  } else {
    let load_result;
    try {
      load_result = await send("Extensions.loadUnpacked", { path: extension_path });
    } catch (error) {
      if (/Method not available|Method.*not.*found|wasn't found/i.test(error.message)) {
        load_unpacked_unavailable_error = error;
      } else {
        throw new Error(
          `Extensions.loadUnpacked failed for ${extension_path}: ${error.message}\n` +
            `If the path is correct and the manifest is valid, load the CDPMods extension manually in chrome://extensions and reconnect.`,
        );
      }
    }

    if (!load_unpacked_unavailable_error) {
      const extension_id = load_result?.id || load_result?.extensionId;
      if (!extension_id) {
        throw new Error(`Extensions.loadUnpacked returned no extension id (got ${JSON.stringify(load_result)})`);
      }

      // 3. Wait for the loaded extension's service worker target. Custom extensions
      // can name the worker bundle anything; WXT uses background.js.
      const sw_url_prefix = `chrome-extension://${extension_id}/`;
      for (;;) {
        const target_infos = commands["Target.getTargets"].result.parse(await send("Target.getTargets")).targetInfos;
        const target = target_infos.find((candidate) => candidate.type === "service_worker" && candidate.url.startsWith(sw_url_prefix)) as TargetInfo | undefined;
        if (target) {
          const probed = await probeTarget(target);
          if (probed) return { source: "injected", extension_id, target_id: target.targetId, url: target.url, session_id: probed.session_id };
        }
        await sleep(100);
      }
    }
  }

  // 4. Chrome's new chrome://inspect auto-connect flow exposes CDP without
  // exposing Extensions.loadUnpacked. In that case, inject the same server into
  // every currently running extension service worker and keep the best session.
  const borrowed: {
    target_id: string;
    url: string;
    session_id: string;
    extension_id?: string | null;
    has_tabs?: boolean;
    has_debugger?: boolean;
  }[] = [];
  const borrowed_target_infos = commands["Target.getTargets"].result.parse(await send("Target.getTargets")).targetInfos;
  for (const target of borrowed_target_infos) {
    if (target.type !== "service_worker") continue;
    if (!target.url.startsWith("chrome-extension://")) continue;

    let session_id: string | null = null;
    try {
      session_id = sessionIdForTarget(target.targetId);
      if (session_id == null) continue;
      await send("Runtime.enable", {}, session_id).catch(() => {});
      const bootstrap = commands["Runtime.evaluate"].result.parse(
        await sendWithTimeout(
          "Runtime.evaluate",
          {
            expression: bootstrap_cdpmods_server_expression,
            awaitPromise: true,
            returnByValue: true,
            allowUnsafeEvalBlockedByCSP: true,
          },
          session_id,
          3_000,
        ),
      );
      const value = bootstrap.result?.value || {};
      let ready = Boolean(value.ok);
      if (ready && ready_expression !== CDPMODS_READY_EXPRESSION) {
        const probe = commands["Runtime.evaluate"].result.parse(
          await sendWithTimeout(
            "Runtime.evaluate",
            { expression: ready_expression, returnByValue: true },
            session_id,
            2_000,
          ),
        );
        ready = probe.result?.value === true;
      }
      if (ready) {
        borrowed.push({
          target_id: target.targetId,
          url: target.url,
          session_id,
          extension_id: value.extension_id || target.url.match(EXT_ID_FROM_URL)?.[1] || null,
          has_tabs: Boolean(value.has_tabs),
          has_debugger: Boolean(value.has_debugger),
        });
      }
    } catch {}
  }

  borrowed.sort((a, b) => Number(b.has_debugger) - Number(a.has_debugger) || Number(b.has_tabs) - Number(a.has_tabs));
  const selected = borrowed[0];
  if (selected) {
    return {
      source: "borrowed",
      extension_id: selected.extension_id,
      target_id: selected.target_id,
      url: selected.url,
      session_id: selected.session_id,
    };
  }

  throw new Error(
    `Cannot install or borrow CDPMods in the running browser.\n\n` +
      `  - No existing service worker with globalThis.CDPMods was found in the browser.\n` +
      `  - Extensions.loadUnpacked is unavailable ("${load_unpacked_unavailable_error.message}").\n` +
      `  - No running chrome-extension:// service worker target accepted the CDPMods bootstrap.\n\n` +
      `Fixes (any one of these):\n` +
      `  1. Open or wake an installed extension that has a service worker, then reconnect.\n` +
      `  2. Load the CDPMods extension once at chrome://extensions and reconnect.\n` +
      (extension_path ? `  3. For automated/test browsers, relaunch with --load-extension=${extension_path}.\n` : ""),
  );

  function serviceWorkerTargetMatches(candidate: { type?: string; url?: string }) {
    const url = candidate.url ?? "";
    if (candidate.type !== "service_worker") return false;
    if (!url.startsWith("chrome-extension://")) return false;
    if (service_worker_url_includes.length > 0 && !service_worker_url_includes.every((part) => url.includes(part))) {
      return false;
    }
    if (service_worker_url_suffixes.length > 0 && !service_worker_url_suffixes.some((suffix) => url.endsWith(suffix))) {
      return false;
    }
    return service_worker_url_includes.length > 0 || service_worker_url_suffixes.length > 0;
  }
}
