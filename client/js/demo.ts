// JS demo for MagicCDPClient with --direct / --loopback / --debugger modes.
//
// Modes select where non-Magic CDP commands ultimately get serviced:
//   --live        use the running Google Chrome enabled via chrome://inspect.
//   --direct      client sends standard CDP straight to the upstream WS.
//   --loopback    client routes *.* through the extension service worker,
//                 which opens a verified WebSocket back to localhost:9222 and
//                 forwards the command. (*.* -> service_worker on client,
//                 *.* -> loopback_cdp on server. Default mode.)
//   --debugger    client routes *.* through the extension service worker,
//                 which uses chrome.debugger.sendCommand against the active
//                 tab. (*.* -> service_worker on client, *.* -> chrome_debugger
//                 on server.)
//
// All three modes exercise the same surface: Browser.getVersion (standard),
// Magic.evaluate, Magic.addCustomEvent, Magic.addCustomCommand, Custom.echo
// + Custom.demo event roundtrip.

import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { z } from "zod";

import { MagicCDPClient } from "./MagicCDPClient.js";
import { launchChrome } from "../../bridge/launcher.js";
import { cdp as protocol } from "../../types/cdp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH =
  [path.resolve(HERE, "..", "..", "extension"), path.resolve(HERE, "..", "..", "dist", "extension")].find((candidate) =>
    existsSync(path.join(candidate, "service_worker.js")),
  ) ?? path.resolve(HERE, "..", "..", "extension");

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith("--")).map((a) => a.slice(2)));
  const live = flags.has("live");
  const mode = flags.has("debugger")
    ? "debugger"
    : flags.has("direct")
      ? "direct"
      : flags.has("loopback")
        ? "loopback"
        : live
          ? "direct"
          : "loopback";
  return { mode, live };
}

function clientOptionsFor(mode, cdp_url) {
  if (mode === "direct") {
    return {
      cdp_url,
      extension_path: EXTENSION_PATH,
      routes: { "Magic.*": "service_worker", "Custom.*": "service_worker", "*.*": "direct_cdp" },
    };
  }
  return {
    cdp_url,
    extension_path: EXTENSION_PATH,
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

function openLiveInspectPage() {
  if (process.platform === "darwin") {
    spawn("open", ["chrome://inspect/#remote-debugging"], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", ["chrome://inspect/#remote-debugging"], { detached: true, stdio: "ignore" }).unref();
  }
}

async function waitForLiveCdpUrl() {
  const startedAt = Date.now();
  openLiveInspectPage();
  console.log("opened chrome://inspect/#remote-debugging");
  console.log("waiting for Chrome to expose DevToolsActivePort; click Allow when Chrome asks.");

  const candidates =
    process.platform === "darwin"
      ? [
          path.join(process.env.HOME || "", "Library/Application Support/Google/Chrome/DevToolsActivePort"),
          path.join(process.env.HOME || "", "Library/Application Support/Google/Chrome Beta/DevToolsActivePort"),
        ]
      : [
          path.join(process.env.HOME || "", ".config/google-chrome/DevToolsActivePort"),
          path.join(process.env.HOME || "", ".config/chromium/DevToolsActivePort"),
        ];
  while (true) {
    for (const file of candidates) {
      try {
        const info = await stat(file);
        if (info.mtimeMs < startedAt - 1_000) continue;
        const [port, browserPath] = (await readFile(file, "utf8"))
          .trim()
          .split(/\n/)
          .map((line) => line.trim());
        if (port && browserPath) return `ws://127.0.0.1:${port}${browserPath}`;
      } catch {}
    }
    await sleep(250);
  }
}

async function main() {
  const { mode, live } = parseArgs(process.argv.slice(2));
  console.log(`== mode: ${live ? "live/" : ""}${mode} ==`);
  if (!existsSync(path.join(EXTENSION_PATH, "service_worker.js"))) {
    throw new Error(`Built extension not found at ${EXTENSION_PATH}. Run pnpm run build first.`);
  }

  let chrome = null;
  let cdpUrl;
  if (live) {
    cdpUrl = await waitForLiveCdpUrl();
  } else {
    // --load-extension is a workaround for builds where Extensions.loadUnpacked
    // is unavailable (e.g. Playwright-bundled chromium). On Chrome Canary you
    // can drop extraFlags entirely and the injector will install the extension
    // over CDP itself.
    chrome = await launchChrome({
      headless: process.platform === "linux",
      noSandbox: process.platform === "linux",
      extraFlags: [`--load-extension=${EXTENSION_PATH}`],
    });
    cdpUrl = chrome.wsUrl;
  }
  console.log("upstream cdp:", cdpUrl);

  const cdp = new MagicCDPClient(clientOptionsFor(mode, cdpUrl));
  const events = [];
  cdp.on("Custom.demo", (payload) => {
    console.log("event ->", payload);
    events.push(payload);
  });

  try {
    await cdp.connect();
    console.log("connected; ext", cdp.extension_id, "session", cdp.ext_session_id);
    console.log("ping latency      ->", cdp.latency);

    // standard CDP route differs per mode. --direct goes straight to the
    // upstream WS. --loopback comes back into the browser via a verified
    // ws://localhost:9222. --debugger goes through chrome.debugger which is
    // tab-scoped and rejects browser-level methods like Browser.getVersion --
    // expected, just report.
    try {
      console.log("Browser.getVersion ->", await cdp.Browser.getVersion());
    } catch (e) {
      console.log("Browser.getVersion -> (rejected by route:", e.message.replace(/\n/g, " "), ")");
    }

    console.log(
      "Magic.evaluate     ->",
      await cdp.Magic.evaluate({
        expression: "({ extensionId: chrome.runtime.id })",
      }),
    );

    await cdp.Magic.addCustomCommand({
      name: "Custom.tabIdFromTargetId",
      paramsSchema: {
        targetId: protocol.types.zod.Target.TargetID,
      },
      resultSchema: {
        tabId: z.number().nullable(),
      },
      expression: `async ({ targetId }) => {
        if (!chrome.debugger?.getTargets) return { tabId: null };
        const targets = await chrome.debugger.getTargets();
        const target = targets.find(target => target.id === targetId);
        if (target?.tabId != null) return { tabId: target.tabId };
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find(tab => target?.url && (tab.url === target.url || tab.pendingUrl === target.url));
        return { tabId: tab?.id ?? null };
      }`,
    });
    await cdp.Magic.addMiddleware({
      name: "*",
      phase: cdp.RESPONSE,
      expression: `async (payload, next) => {
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
      }`,
    });
    await cdp.Magic.addMiddleware({
      name: "*",
      phase: cdp.EVENT,
      expression: `async (payload, next) => {
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
      }`,
    });

    await cdp.Magic.addCustomEvent({
      name: "Page.foregroundPageChanged",
      eventSchema: {
        targetId: protocol.types.zod.Target.TargetID.nullable(),
        url: z.string().nullable(),
        tabId: z.number().nullable().optional(),
      },
    });
    cdp.on("Page.foregroundPageChanged", (event) => console.log("Page.foregroundPageChanged ->", event));
    await cdp.Magic.evaluate({
      expression: `chrome.tabs.onActivated.addListener(async ({ tabId }) => {
          const targets = chrome.debugger?.getTargets ? await chrome.debugger.getTargets() : [];
          const target = targets.find(target => target.type === "page" && target.tabId === tabId);
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          await cdp.emit("Page.foregroundPageChanged", { targetId: target?.id ?? null, url: target?.url ?? tab?.url ?? null });
        })`,
    });

    await cdp.Magic.addCustomEvent({
      name: "Custom.demo",
      eventSchema: {
        echo: z.string(),
      },
    });
    await cdp.Magic.addCustomCommand({
      name: "Custom.echo",
      paramsSchema: {
        value: z.string(),
      },
      resultSchema: {
        echoed: z.string(),
      },
      expression:
        "async (params) => { await cdp.emit('Custom.demo', { echo: params.value }); return { echoed: params.value }; }",
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
      cdp.on("Magic.pong", (e) => console.log("\n[event] Magic.pong", e));
      await runRepl(cdp, mode);
    }
  } finally {
    await cdp.close();
    await chrome?.close();
  }
}

async function runRepl(cdp, mode) {
  console.log(`\nBrowser remains running. Mode: ${mode}.`);
  console.log("Enter commands as Domain.method({...}). Examples:");
  console.log("  Browser.getVersion({})");
  console.log('  Magic.evaluate({expression: "chrome.tabs.query({active: true})"})');
  console.log("  Custom.echo({value: 'hi'})");
  console.log("Type exit or quit to disconnect (browser keeps running).");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      let line;
      try {
        line = (await rl.question("MagicCDP> ")).trim();
      } catch {
        break;
      }
      if (!line) continue;
      if (line === "exit" || line === "quit") break;
      try {
        const match = line.match(/^([A-Za-z_][\w]*\.[A-Za-z_][\w]*)(?:\(([\s\S]*)\))?$/);
        if (!match) throw new Error("format: Domain.method({...})");
        const [, method, raw = ""] = match;
        const params = raw.trim() ? Function(`"use strict"; return (${raw});`)() : {};
        const [domain, command] = method.split(".");
        const result = cdp[domain]?.[command] ? await cdp[domain][command](params) : await cdp.send(method, params);
        console.log(JSON.stringify(result, null, 2));
      } catch (e) {
        console.error("error:", e?.message || e);
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((e) => {
  console.error("DEMO FAILED:", e);
  process.exitCode = 1;
});
