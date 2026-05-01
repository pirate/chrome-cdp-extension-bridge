// End-to-end demo: stock Playwright connecting through the MagicCDPBridge.
//
// What this proves:
//   - A vanilla `chromium.connectOverCDP(...)` against the proxy
//   - A vanilla `CDPSession.send('Magic.*' / 'Custom.*', ...)` from Playwright
//   - A vanilla `CDPSession.on('Custom.demo', ...)` receiving binding events
//
// Test environment notes:
//   The Playwright-bundled chromium 141 used here exposes the Extensions CDP
//   domain in its protocol descriptor but the loadUnpacked handler returns
//   "Method not available." For that reason we launch upstream with
//   --load-extension via launcher.mjs's extraFlags. injector.mjs notices that
//   a MagicCDP service worker is already present and takes the "discovered"
//   precedence path — Extensions.loadUnpacked is never invoked here. On Chrome
//   Canary or any build where loadUnpacked is implemented, the demo would work
//   identically without --load-extension and the precedence flips to "injected".

import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

import { launchChrome, freePort } from "./launcher.mjs";
import { startProxy } from "./proxy.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(ROOT, "extension");

async function main() {
  const events = [];
  let chrome, proxy, browser;

  try {
    // 1. Launch upstream Chrome ourselves so we can pass --load-extension as a
    //    workaround for the local chromium build (see test environment notes).
    console.log("== launching upstream Chrome (with --load-extension workaround) ==");
    chrome = await launchChrome({ extraFlags: [`--load-extension=${EXTENSION_PATH}`] });
    console.log("upstream cdp:", chrome.cdpUrl);

    // 2. Start the proxy in front of that Chrome. The proxy's ensure-extension
    //    step will discover the already-loaded MagicCDP SW (no injection
    //    needed). Default port 9223 is fine.
    console.log("\n== starting MagicCDPBridge ==");
    const port = await freePort();
    proxy = await startProxy({ port, upstream: chrome.cdpUrl, autoLaunch: false, extensionPath: EXTENSION_PATH });

    // 3. Connect Playwright via vanilla connectOverCDP.
    console.log("\n== connecting Playwright via connectOverCDP through proxy ==");
    browser = await chromium.connectOverCDP(proxy.url);
    const ctx = browser.contexts()[0] ?? await browser.newContext();
    const page = ctx.pages()[0] ?? await ctx.newPage();
    const session = await ctx.newCDPSession(page);

    console.log("\n== prove standard CDP still works through the proxy ==");
    console.log("Browser.getVersion ->", await session.send("Browser.getVersion"));

    console.log("\n== Magic.evaluate from a vanilla Playwright CDPSession ==");
    const info = await session.send("Magic.evaluate", {
      expression: "async () => ({ extensionId: chrome.runtime.id, swUrl: chrome.runtime.getURL('service_worker.js') })",
    });
    console.log("Magic.evaluate result ->", info);

    console.log("\n== Magic.addCustomEvent + session.on('Custom.demo', ...) ==");
    await session.send("Magic.addCustomEvent", { name: "Custom.demo" });
    session.on("Custom.demo", payload => {
      console.log("PLAYWRIGHT RECEIVED Custom.demo ->", payload);
      events.push(payload);
    });

    console.log("\n== Magic.addCustomCommand: Custom.echo emits Custom.demo ==");
    await session.send("Magic.addCustomCommand", {
      name: "Custom.echo",
      expression: "async (params, { cdp }) => { await cdp.emit('Custom.demo', { echo: params.value, ts: Date.now() }); return { ok: true, echoed: params.value }; }",
    });

    console.log("\n== Custom.echo (custom command) sent from Playwright ==");
    const echo1 = await session.send("Custom.echo", { value: "hello-from-playwright" });
    console.log("Custom.echo result ->", echo1);
    const echo2 = await session.send("Custom.echo", { value: "second-roundtrip" });
    console.log("Custom.echo result ->", echo2);

    const waitDeadline = Date.now() + 3000;
    while (events.length < 2 && Date.now() < waitDeadline) await sleep(20);

    console.log("\n== summary ==");
    console.log("events received:", events);
    if (events.length < 2) throw new Error(`expected >=2 Custom.demo events, got ${events.length}`);
    if (echo1.echoed !== "hello-from-playwright") throw new Error("echo1 did not roundtrip");
    if (echo2.echoed !== "second-roundtrip") throw new Error("echo2 did not roundtrip");

    console.log("\nSUCCESS: Playwright CDPSession sent Magic commands and received Magic events through the proxy.");
  } finally {
    try { await browser?.close(); } catch {}
    try { await proxy?.close(); } catch {}
    try { await chrome?.close(); } catch {}
  }
}

main().catch(e => { console.error("DEMO FAILED:", e); process.exitCode = 1; });
