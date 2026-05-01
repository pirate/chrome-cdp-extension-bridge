// JS demo for MagicCDPClient with --direct / --loopback / --debugger modes.
//
// Modes select where non-Magic CDP commands ultimately get serviced:
//   --direct      client sends standard CDP straight to the upstream WS.
//                 (Default. *.* -> direct_cdp on the client.)
//   --loopback    client routes *.* through the extension service worker,
//                 which opens a verified WebSocket back to localhost:9222 and
//                 forwards the command. (*.* -> service_worker on client,
//                 *.* -> loopback_cdp on server.)
//   --debugger    client routes *.* through the extension service worker,
//                 which uses chrome.debugger.sendCommand against the active
//                 tab. (*.* -> service_worker on client, *.* -> chrome_debugger
//                 on server.)
//
// All three modes exercise the same surface: Browser.getVersion (standard),
// Magic.evaluate, Magic.addCustomEvent, Magic.addCustomCommand, Custom.echo
// + Custom.demo event roundtrip.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createInterface } from "node:readline/promises";

import { MagicCDPClient } from "./MagicCDPClient.mjs";
import { launchChrome } from "../../bridge/launcher.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(HERE, "..", "..", "extension");

function parseArgs(argv) {
  const flags = new Set(argv.filter(a => a.startsWith("--")).map(a => a.slice(2)));
  const mode = flags.has("debugger") ? "debugger"
              : flags.has("loopback") ? "loopback"
              : "direct";
  return { mode };
}

function clientOptionsFor(mode, cdp_url) {
  if (mode === "direct") {
    return {
      cdp_url,
      routes: { "Magic.*": "service_worker", "Custom.*": "service_worker", "*.*": "direct_cdp" },
    };
  }
  return {
    cdp_url,
    routes: { "Magic.*": "service_worker", "Custom.*": "service_worker", "*.*": "service_worker" },
    server: {
      routes: {
        "Magic.*": "service_worker",
        "Custom.*": "service_worker",
        "*.*": mode === "loopback" ? "loopback_cdp" : "chrome_debugger",
      },
      loopback_cdp_url: mode === "loopback" ? cdp_url : null,
    },
  };
}

async function main() {
  const { mode } = parseArgs(process.argv.slice(2));
  console.log(`== mode: ${mode} ==`);

  // --load-extension is a workaround for builds where Extensions.loadUnpacked
  // is unavailable (e.g. Playwright-bundled chromium). On Chrome Canary you
  // can drop extraFlags entirely and the injector will install the extension
  // over CDP itself.
  const chrome = await launchChrome({ extraFlags: [`--load-extension=${EXTENSION_PATH}`] });
  console.log("upstream cdp:", chrome.cdpUrl);

  const cdp = MagicCDPClient(clientOptionsFor(mode, chrome.cdpUrl));
  const events = [];
  cdp.on("Custom.demo", payload => { console.log("event ->", payload); events.push(payload); });

  try {
    await cdp.connect();
    console.log("connected; ext", cdp.extension_id, "session", cdp.session_id);

    // standard CDP route differs per mode. --direct goes straight to the
    // upstream WS. --loopback comes back into the browser via a verified
    // ws://localhost:9222. --debugger goes through chrome.debugger which is
    // tab-scoped and rejects browser-level methods like Browser.getVersion --
    // expected, just report.
    try { console.log("Browser.getVersion ->", await cdp.send("Browser.getVersion")); }
    catch (e) { console.log("Browser.getVersion -> (rejected by route:", e.message.replace(/\n/g, " "), ")"); }

    console.log("Magic.evaluate     ->", await cdp.send("Magic.evaluate", {
      expression: "async () => ({ extensionId: chrome.runtime.id })",
    }));

    await cdp.send("Magic.addCustomEvent", { name: "Custom.demo" });
    await cdp.send("Magic.addCustomCommand", {
      name: "Custom.echo",
      expression: "async (params, { cdp }) => { await cdp.emit('Custom.demo', { echo: params.value }); return { echoed: params.value }; }",
    });

    console.log("Custom.echo        ->", await cdp.send("Custom.echo", { value: `hello-from-js-${mode}` }));
    console.log("Custom.echo        ->", await cdp.send("Custom.echo", { value: `second-${mode}` }));

    const deadline = Date.now() + 3000;
    while (events.length < 2 && Date.now() < deadline) await sleep(20);
    if (events.length < 2) throw new Error(`expected >=2 Custom.demo events, got ${events.length}`);

    console.log(`\nSUCCESS (${mode}): ${events.length} events`);

    // Drop into an interactive prompt when stdin is a TTY. Lets you poke at
    // the live browser: type Domain.method({...JS object literal...}) and
    // see the result; events you've subscribed to print as they arrive. Skip
    // the prompt when run non-interactively (CI, piped stdin) so the demo
    // exits cleanly after assertions.
    if (process.stdin.isTTY) {
      cdp.on("Target.attachedToTarget", e => console.log("\n[event] Target.attachedToTarget", e));
      await runRepl(cdp, mode);
    }
  } finally {
    await cdp.close();
    await chrome.close();
  }
}

async function runRepl(cdp, mode) {
  console.log(`\nBrowser remains running. Mode: ${mode}.`);
  console.log("Enter commands as Domain.method({...}). Examples:");
  console.log("  Browser.getVersion({})");
  console.log("  Magic.evaluate({expression: \"chrome.tabs.query({active: true})\"})");
  console.log("  Custom.echo({value: 'hi'})");
  console.log("Type exit or quit to disconnect (browser keeps running).");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      let line;
      try { line = (await rl.question("MagicCDP> ")).trim(); }
      catch { break; }
      if (!line) continue;
      if (line === "exit" || line === "quit") break;
      try {
        const match = line.match(/^([A-Za-z_][\w]*\.[A-Za-z_][\w]*)(?:\(([\s\S]*)\))?$/);
        if (!match) throw new Error("format: Domain.method({...})");
        const [, method, raw = ""] = match;
        const params = raw.trim() ? Function(`"use strict"; return (${raw});`)() : {};
        const result = await cdp.send(method, params);
        console.log(JSON.stringify(result, null, 2));
      } catch (e) {
        console.error("error:", e?.message || e);
      }
    }
  } finally {
    rl.close();
  }
}

main().catch(e => { console.error("DEMO FAILED:", e); process.exitCode = 1; });
