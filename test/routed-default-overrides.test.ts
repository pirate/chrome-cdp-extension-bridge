import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { launchChrome } from "../bridge/launcher.js";
import { CDPModsClient } from "../client/js/CDPModsClient.js";
import { commands, events } from "../types/zod.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(HERE, "..", "extension");

const getTargetsOverride = String.raw`
async (params) => {
  const [upstream, tabs] = await Promise.all([
    CDPMods.sendLoopback("Target.getTargets", params),
    chrome.tabs.query({}),
  ]);

  const tabIdByUrl = new Map();
  for (const tab of tabs) {
    for (const url of [tab.url, tab.pendingUrl].filter(Boolean)) {
      if (!tabIdByUrl.has(url)) tabIdByUrl.set(url, tab.id);
    }
  }

  return {
    ...upstream,
    targetInfos: (upstream.targetInfos || []).map(targetInfo => ({
      ...targetInfo,
      tabId: tabIdByUrl.get(targetInfo.url) ?? null,
    })),
  };
}
`;

const setDiscoverTargetsOverride = String.raw`
async (params) => {
  if (!CDPMods.loopback_cdp_url) throw new Error("loopback_cdp_url is required");

  const state = globalThis.__cdpmodsTargetForwarder ||= { nextId: 1, pending: new Map(), ws: null };
  const needsSocket = !state.ws || state.ws.readyState === WebSocket.CLOSING || state.ws.readyState === WebSocket.CLOSED;

  if (needsSocket) {
    state.ws = await new Promise((resolve, reject) => {
      const ws = new WebSocket(CDPMods.loopback_cdp_url);
      ws.addEventListener("open", () => resolve(ws), { once: true });
      ws.addEventListener("error", reject, { once: true });
    });

    state.ws.addEventListener("message", async event => {
      const msg = JSON.parse(event.data);
      if (msg.id && state.pending.has(msg.id)) {
        const pending = state.pending.get(msg.id);
        state.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(msg.error.message));
        else pending.resolve(msg.result || {});
        return;
      }

      if (msg.method !== "Target.targetCreated") return;
      await CDPMods.emit("Target.targetCreated", msg.params || {});
    });
  }

  state.call = (method, callParams = {}) => new Promise((resolve, reject) => {
    const id = state.nextId++;
    state.pending.set(id, { resolve, reject });
    state.ws.send(JSON.stringify({ id, method, params: callParams }));
  });

  const result = await state.call("Target.setDiscoverTargets", params);
  if (params.discover === false) {
    try { state.ws.close(); } catch {}
    state.ws = null;
  }
  return result;
}
`;

const tabIdFromTargetIdCommand = String.raw`
async ({ targetId }) => {
  const targets = await chrome.debugger.getTargets();
  const target = targets.find(target => target.id === targetId);
  if (target?.tabId != null) return { tabId: target.tabId };
  const tabs = await chrome.tabs.query({});
  const tab = tabs.find(tab => target?.url && (tab.url === target.url || tab.pendingUrl === target.url));
  return { tabId: tab?.id ?? null };
}
`;

const addTabIdMiddleware = String.raw`
async (payload, next) => {
  const seen = new WeakSet();
  const visit = async value => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (!Array.isArray(value) && typeof value.targetId === "string" && value.tabId == null) {
      const { tabId } = await cdp.send("Custom.tabIdFromTargetId", { targetId: value.targetId });
      if (tabId != null) value.tabId = tabId;
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) await visit(child);
  };
  await visit(payload);
  return next(payload);
}
`;

test("service-worker routed standard CDP commands and events can be transformed", { timeout: 45_000 }, async () => {
  const chrome = await launchChrome({
    headless: process.platform === "linux",
    sandbox: process.platform !== "linux",
    extra_args: [`--load-extension=${EXTENSION_PATH}`],
  });
  const cdp = new CDPModsClient({
    cdp_url: chrome.cdpUrl,
    routes: {
      "Target.getTargets": "service_worker",
      "Target.setDiscoverTargets": "service_worker",
    },
    server: {
      loopback_cdp_url: chrome.cdpUrl,
      routes: { "*.*": "loopback_cdp" },
    },
  });

  try {
    await cdp.connect();
    assert.equal(cdp.cdp_url, chrome.wsUrl);
    assert.equal(cdp.server.loopback_cdp_url, chrome.wsUrl);

    const rawTargets = commands["Target.getTargets"].result.parse(await cdp._sendFrame("Target.getTargets"));
    assert.ok(rawTargets.targetInfos?.length > 0, "expected raw Target.getTargets targetInfos");
    assert.equal(
      rawTargets.targetInfos.some((targetInfo) => Object.hasOwn(targetInfo, "tabId")),
      false,
      "raw CDP TargetInfo should not already contain tabId",
    );

    await cdp.send("Mods.addCustomCommand", {
      name: "Custom.tabIdFromTargetId",
      expression: tabIdFromTargetIdCommand,
    });
    await cdp.Mods.addMiddleware({
      name: "*",
      phase: cdp.RESPONSE,
      expression: addTabIdMiddleware,
    });
    const middlewareTargets = await cdp.send("Target.getTargets");
    assert.ok(
      middlewareTargets.targetInfos.some(
        (targetInfo) => targetInfo.type === "page" && Number.isInteger(targetInfo.tabId),
      ),
      "wildcard response middleware should add tabId next to targetId inside TargetInfo",
    );

    await cdp.Mods.addMiddleware({
      name: "*",
      phase: cdp.EVENT,
      expression: addTabIdMiddleware,
    });

    await cdp.Mods.addCustomCommand({
      name: cdp.Target.getTargets,
      expression: getTargetsOverride,
    });

    const enrichedTargets = await cdp.send("Target.getTargets");
    assert.ok(enrichedTargets.targetInfos?.length > 0, "expected enriched Target.getTargets targetInfos");
    assert.equal(
      enrichedTargets.targetInfos.every((targetInfo) => Object.hasOwn(targetInfo, "tabId")),
      true,
      "every routed TargetInfo should include a tabId property",
    );
    assert.ok(
      enrichedTargets.targetInfos.some(
        (targetInfo) => targetInfo.type === "page" && Number.isInteger(targetInfo.tabId),
      ),
      "expected at least one page target to be matched to a chrome.tabs tab id",
    );

    await cdp.Mods.addCustomEvent({ name: cdp.Target.targetCreated });
    await cdp.Mods.addCustomCommand({
      name: cdp.Target.setDiscoverTargets,
      expression: setDiscoverTargetsOverride,
    });

    const forwardedEvent = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for transformed Target.targetCreated")),
        10_000,
      );
      cdp.on("Target.targetCreated", (params) => {
        if (!Object.hasOwn(params.targetInfo || {}, "tabId")) return;
        clearTimeout(timeout);
        resolve(params);
      });
    });

    await cdp.Target.setDiscoverTargets({ discover: true });
    await cdp._sendFrame("Target.createTarget", { url: "about:blank#cdpmods-event-test" });

    const event = events["Target.targetCreated"].parse(await forwardedEvent);
    assert.ok(Object.hasOwn(event.targetInfo, "tabId"), "transformed event targetInfo should include tabId");
  } finally {
    try {
      await cdp.Target.setDiscoverTargets({ discover: false });
    } catch {}
    await cdp.close();
    await chrome.close();
  }
});
