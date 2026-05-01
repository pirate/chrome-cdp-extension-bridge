// End-to-end demo:
//   1. Launch local Chromium with the MagicCDP extension already loaded
//      (--load-extension), with the CDP port open on localhost. This step is
//      what we are saying any user can already do — no MagicCDP client code is
//      involved.
//   2. Spawn the standalone MagicCDPBridge proxy in front of that browser.
//   3. Connect Playwright via vanilla `chromium.connectOverCDP(bridgeUrl)`.
//   4. From an unmodified Playwright CDPSession, send Magic.* / Custom.*
//      commands and receive Custom.* events.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(ROOT, "extension");
const CHROME = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise(r => s.close(r));
  return port;
}

async function waitForUrl(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch {}
    await sleep(60);
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function main() {
  const events = [];
  let chromeProc, bridgeProc, browser, profileDir;

  try {
    // 1. launch Chromium with the MagicCDP extension preloaded
    profileDir = await mkdtemp(path.join(tmpdir(), "magic-cdp-pw."));
    const chromePort = await freePort();
    console.log("== launching Chromium with MagicCDP extension at port", chromePort);
    chromeProc = spawn(CHROME, [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--enable-unsafe-extension-debugging",
      "--remote-allow-origins=*",
      `--remote-debugging-port=${chromePort}`,
      `--user-data-dir=${profileDir}`,
      `--load-extension=${EXT}`,
      "about:blank",
    ], { stdio: ["ignore", "ignore", "ignore"] });
    const chromeVersion = await waitForUrl(`http://127.0.0.1:${chromePort}/json/version`);
    console.log("chromium up:", chromeVersion.Browser);

    // 2. spawn MagicCDPBridge as a separate process in front of Chrome
    const bridgePort = await freePort();
    const bridgeUrl = `http://127.0.0.1:${bridgePort}`;
    console.log("\n== spawning MagicCDPBridge at", bridgeUrl);
    bridgeProc = spawn(process.execPath, [
      path.join(ROOT, "bridge.mjs"),
      "--upstream", `http://127.0.0.1:${chromePort}`,
      "--port", String(bridgePort),
    ], { stdio: ["ignore", "inherit", "inherit"] });
    await waitForUrl(`${bridgeUrl}/json/version`);

    // 3. connect Playwright via vanilla connectOverCDP
    console.log("\n== connecting Playwright via connectOverCDP through bridge ==");
    browser = await chromium.connectOverCDP(bridgeUrl);
    console.log("playwright connected. contexts:", browser.contexts().length);

    const ctx = browser.contexts()[0] ?? await browser.newContext();
    const page = ctx.pages()[0] ?? await ctx.newPage();
    console.log("page url:", page.url());

    // Vanilla Playwright CDPSession scoped to a page target.
    const session = await ctx.newCDPSession(page);

    console.log("\n== prove standard CDP still works through the bridge ==");
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

    console.log("\nSUCCESS: Playwright CDPSession sent Magic commands and received Magic events through the bridge.");
  } finally {
    try { await browser?.close(); } catch {}
    try { bridgeProc?.kill("SIGTERM"); } catch {}
    try { chromeProc?.kill("SIGTERM"); } catch {}
    if (profileDir) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(e => { console.error("DEMO FAILED:", e); process.exitCode = 1; });
