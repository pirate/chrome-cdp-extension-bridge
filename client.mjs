// Demo for MagicCDPClient. Launches a Chromium with the MagicCDP extension
// pre-loaded, connects via the new clean MagicCDP interface, and exercises
// every primitive: Magic.evaluate, Magic.addCustomCommand, Magic.addCustomEvent.
//
//   node client.mjs                      # uses the default chromium path
//   node client.mjs /path/to/chromium    # override binary

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

import { MagicCDPClient } from "./magic-cdp.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.join(rootDir, "extension");
const defaultChrome = path.join(
  process.env.HOME ?? "",
  "Library/Application Support/bb/lib/puppeteer/bin/chromium"
);
const chromePath = process.argv[2] || defaultChrome;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function launchChromium() {
  const port = await freePort();
  const profile = await mkdtemp(path.join(tmpdir(), "magic-cdp-demo."));
  const proc = spawn(
    chromePath,
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--load-extension=${extensionDir}`,
      `--disable-extensions-except=${extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  return {
    cdp_url: `http://127.0.0.1:${port}`,
    cleanup: async () => {
      proc.kill();
      await rm(profile, { recursive: true, force: true });
    },
  };
}

async function timed(latency, name, fn) {
  const start = performance.now();
  const value = await fn();
  latency[name] = Number((performance.now() - start).toFixed(3));
  return value;
}

const browser = await launchChromium();
const latencyMs = {};
let cdp;

try {
  const setupStart = performance.now();
  cdp = new MagicCDPClient({ cdp_url: browser.cdp_url });
  await cdp.connect();
  latencyMs.connectIncludingHandshake = Number(
    (performance.now() - setupStart).toFixed(3)
  );

  // --- normal CDP still routes directly through the raw socket ----------
  const version = await timed(latencyMs, "directBrowserGetVersion", () =>
    cdp.send("Browser.getVersion")
  );

  // --- Magic.evaluate: run code with chrome.* APIs in the SW context ----
  const tabs = await timed(latencyMs, "magicEvaluate", () =>
    cdp.send("Magic.evaluate", {
      script: "async (params) => (await chrome.tabs.query(params))[0] ?? null",
      params: { active: true, lastFocusedWindow: true },
    })
  );

  // --- Magic.addCustomCommand: register a reusable smuggled command -----
  await cdp.send("Magic.addCustomCommand", {
    customMethod: "Custom.getForegroundTabInfo",
    script:
      "async (queryInfo) => (await chrome.tabs.query({ active: true, lastFocusedWindow: true, ...queryInfo }))[0] ?? null",
  });
  const foregroundTab = await timed(
    latencyMs,
    "customCommandRoundTrip",
    () => cdp.send("Custom.getForegroundTabInfo", {})
  );

  // --- Magic.addCustomEvent + emit pipeline -----------------------------
  await cdp.send("Magic.addCustomEvent", {
    customEvent: "Custom.foregroundTabChanged",
  });

  // hook chrome.tabs.onActivated -> Custom.foregroundTabChanged
  await cdp.send("Magic.evaluate", {
    script: `async (_, server) => {
      if (globalThis.__customForegroundHookInstalled) return { reused: true };
      globalThis.__customForegroundHookInstalled = true;
      chrome.tabs.onActivated.addListener((info) => {
        try { server.emit("Custom.foregroundTabChanged", { tabId: info.tabId, windowId: info.windowId }); }
        catch (err) { console.error("foregroundTabChanged emit failed", err); }
      });
      return { installed: true };
    }`,
  });

  // also register a directly-fired demo event so we can exercise the pipe
  // without needing a real tab activation.
  await cdp.send("Magic.addCustomCommand", {
    customMethod: "Custom.fireDemoEvent",
    script:
      "async (data, server) => { server.emit('Custom.demoEvent', data ?? {}); return { fired: true }; }",
  });
  await cdp.send("Magic.addCustomEvent", { customEvent: "Custom.demoEvent" });

  const demoEvent = await timed(latencyMs, "customEventRoundTrip", async () => {
    const received = new Promise((resolve) =>
      cdp.on("Custom.demoEvent", resolve)
    );
    await cdp.send("Custom.fireDemoEvent", { hello: "world" });
    return received;
  });

  console.log("Browser.getVersion ->", version);
  console.log("Magic.evaluate foreground tab ->", tabs);
  console.log("Custom.getForegroundTabInfo ->", foregroundTab);
  console.log("Custom.demoEvent payload ->", demoEvent);
  console.log("ping latency (ms) ->", cdp.latency);
  console.log("latencyMs ->", latencyMs);
} finally {
  if (cdp) await cdp.close();
  await sleep(50);
  await browser.cleanup();
}
