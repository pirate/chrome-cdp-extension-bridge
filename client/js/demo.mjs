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
  console.log("upstream cdp:", chrome.wsUrl);

  const cdp = MagicCDPClient(clientOptionsFor(mode, chrome.wsUrl));
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
      expression: "async (params) => { await cdp.emit('Custom.demo', { echo: params.value }); return { echoed: params.value }; }",
    });

    console.log("Custom.echo        ->", await cdp.send("Custom.echo", { value: `hello-from-js-${mode}` }));
    console.log("Custom.echo        ->", await cdp.send("Custom.echo", { value: `second-${mode}` }));

    const deadline = Date.now() + 3000;
    while (events.length < 2 && Date.now() < deadline) await sleep(20);
    if (events.length < 2) throw new Error(`expected >=2 Custom.demo events, got ${events.length}`);

    console.log(`\nSUCCESS (${mode}): ${events.length} events`);
  } finally {
    await cdp.close();
    await chrome.close();
  }
}

main().catch(e => { console.error("DEMO FAILED:", e); process.exitCode = 1; });
