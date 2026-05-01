import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { launchChrome } from "../bridge/launcher.mjs";
import { MagicCDPClient } from "../client/js/MagicCDPClient.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(HERE, "..", "extension");

const getTargetsOverride = String.raw`
async (params) => {
  const [upstream, tabs] = await Promise.all([
    MagicCDP.sendLoopback("Target.getTargets", params),
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
  if (!MagicCDP.loopback_cdp_url) throw new Error("loopback_cdp_url is required");

  const state = globalThis.__magicTargetForwarder ||= { nextId: 1, pending: new Map(), ws: null };
  const needsSocket = !state.ws || state.ws.readyState === WebSocket.CLOSING || state.ws.readyState === WebSocket.CLOSED;

  if (needsSocket) {
    state.ws = await new Promise((resolve, reject) => {
      const ws = new WebSocket(MagicCDP.loopback_cdp_url);
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

      let tabId = null;
      try {
        const targetUrl = msg.params?.targetInfo?.url;
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(tab => tab.url === targetUrl || tab.pendingUrl === targetUrl);
        tabId = tab?.id ?? null;
      } catch {}

      await MagicCDP.emit("Target.targetCreated", {
        ...(msg.params || {}),
        targetInfo: {
          ...(msg.params?.targetInfo || {}),
          tabId,
        },
      });
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

test("service-worker routed standard CDP commands and events can be transformed", { timeout: 45_000 }, async () => {
  const chrome = await launchChrome({ extraFlags: [`--load-extension=${EXTENSION_PATH}`] });
  const cdp = new MagicCDPClient({
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

    const rawTargets = await cdp._sendFrame("Target.getTargets");
    assert.ok(rawTargets.targetInfos?.length > 0, "expected raw Target.getTargets targetInfos");
    assert.equal(
      rawTargets.targetInfos.some(targetInfo => Object.hasOwn(targetInfo, "tabId")),
      false,
      "raw CDP TargetInfo should not already contain tabId",
    );

    await cdp.send("Magic.addCustomCommand", {
      name: "Target.getTargets",
      expression: getTargetsOverride,
    });

    const enrichedTargets = await cdp.send("Target.getTargets");
    assert.ok(enrichedTargets.targetInfos?.length > 0, "expected enriched Target.getTargets targetInfos");
    assert.equal(
      enrichedTargets.targetInfos.every(targetInfo => Object.hasOwn(targetInfo, "tabId")),
      true,
      "every routed TargetInfo should include a tabId property",
    );
    assert.ok(
      enrichedTargets.targetInfos.some(targetInfo => targetInfo.type === "page" && Number.isInteger(targetInfo.tabId)),
      "expected at least one page target to be matched to a chrome.tabs tab id",
    );

    await cdp.send("Magic.addCustomEvent", { name: "Target.targetCreated" });
    await cdp.send("Magic.addCustomCommand", {
      name: "Target.setDiscoverTargets",
      expression: setDiscoverTargetsOverride,
    });

    const forwardedEvent = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for transformed Target.targetCreated")), 10_000);
      cdp.on("Target.targetCreated", params => {
        if (!Object.hasOwn(params.targetInfo || {}, "tabId")) return;
        clearTimeout(timeout);
        resolve(params);
      });
    });

    await cdp.send("Target.setDiscoverTargets", { discover: true });
    await cdp._sendFrame("Target.createTarget", { url: "about:blank#magic-cdp-event-test" });

    const event = await forwardedEvent;
    assert.ok(Object.hasOwn(event.targetInfo, "tabId"), "transformed event targetInfo should include tabId");
  } finally {
    try { await cdp.send("Target.setDiscoverTargets", { discover: false }); } catch {}
    await cdp.close();
    await chrome.close();
  }
});
