// JS demo for CDPModClient with --direct / --loopback / --debugger modes.
//
// Modes select where non-CDPMod commands ultimately get serviced:
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
// All three modes exercise the same surface: raw Browser.getVersion, raw
// Target.targetCreated event handling, Mod.evaluate, Custom.* commands,
// Custom.* events, and response middleware.

import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { z } from "zod";

import { CDPModClient } from "./CDPModClient.js";

type TargetCreatedPayload = {
  targetInfo?: { targetId?: string } & Record<string, unknown>;
};

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

function serverRoutesFor(mode) {
  return {
    "Mod.*": "service_worker",
    "Custom.*": "service_worker",
    "*.*": mode === "loopback" ? "loopback_cdp" : mode === "debugger" ? "chrome_debugger" : "auto",
  };
}

function clientOptionsFor(mode, cdp_url, launch_options = {}) {
  const directNormalEventRoutes = {
    "Target.setDiscoverTargets": "direct_cdp",
    "Target.createTarget": "direct_cdp",
    "Target.activateTarget": "direct_cdp",
  };
  if (mode === "direct") {
    return {
      cdp_url,
      extension_path: EXTENSION_PATH,
      launch_options,
      routes: {
        "Mod.*": "service_worker",
        "Custom.*": "service_worker",
        "*.*": "direct_cdp",
        ...directNormalEventRoutes,
      },
    };
  }
  return {
    cdp_url,
    extension_path: EXTENSION_PATH,
    launch_options,
    routes: {
      "Mod.*": "service_worker",
      "Custom.*": "service_worker",
      "*.*": "service_worker",
      ...directNormalEventRoutes,
    },
    server: {
      routes: serverRoutesFor(mode),
      ...(mode === "loopback" && cdp_url ? { loopback_cdp_url: cdp_url } : {}),
    },
  };
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned non-object value ${JSON.stringify(value)}`);
  }
  return value;
}

function isTargetCreatedPayload(value: unknown): value is TargetCreatedPayload {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const targetInfo = (value as Record<string, unknown>).targetInfo;
  return targetInfo == null || (typeof targetInfo === "object" && !Array.isArray(targetInfo));
}

async function waitForEvent(cdp, eventName, predicate = (_payload) => true, timeoutMs = 3000) {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cdp.off(eventName, onEvent);
      reject(new Error(`timed out waiting for ${eventName}`));
    }, timeoutMs);
    const onEvent = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timeout);
      cdp.off(eventName, onEvent);
      resolve(payload);
    };
    cdp.on(eventName, onEvent);
  });
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

  let cdpUrl;
  let launch_options = {};
  if (live) {
    cdpUrl = await waitForLiveCdpUrl();
  } else {
    cdpUrl = null;
    launch_options = {
      headless: process.platform === "linux",
      sandbox: process.platform !== "linux",
      extra_args: [`--load-extension=${EXTENSION_PATH}`],
    };
  }

  const cdp = new CDPModClient(clientOptionsFor(mode, cdpUrl, launch_options));
  const foregroundEvents = [];
  const targetCreatedEvents: TargetCreatedPayload[] = [];

  try {
    await cdp.connect();
    console.log("upstream cdp:", cdp.cdp_url);
    cdp.on(cdp.Target.targetCreated, (payload) => {
      const event = isTargetCreatedPayload(payload) ? payload : {};
      console.log("Target.targetCreated ->", event.targetInfo?.targetId);
      targetCreatedEvents.push(event);
    });
    console.log("connected; ext", cdp.extension_id, "session", cdp.ext_session_id);
    console.log("ping latency      ->", cdp.latency);

    const configureResult = assertObject(
      await cdp.Mod.configure({
        routes: serverRoutesFor(mode),
        ...(mode === "loopback" ? { loopback_cdp_url: cdp.cdp_url } : {}),
      }),
      "Mod.configure",
    );
    if (configureResult.routes?.["*.*"] !== serverRoutesFor(mode)["*.*"]) {
      throw new Error(`unexpected Mod.configure result ${JSON.stringify(configureResult)}`);
    }
    console.log("Mod.configure    ->", configureResult.routes);

    const pingSentAt = Date.now();
    const pongPromise = waitForEvent(cdp, "Mod.pong", (event) => event?.sentAt === pingSentAt);
    const pingResult = assertObject(await cdp.Mod.ping({ sentAt: pingSentAt }), "Mod.ping");
    const pong = assertObject(await pongPromise, "Mod.pong");
    if (pingResult.ok !== true || pong.receivedAt == null || pong.from !== "extension-service-worker") {
      throw new Error(`unexpected Mod.ping/Mod.pong result ${JSON.stringify({ pingResult, pong })}`);
    }
    console.log("Mod.ping/pong    ->", { pingResult, pong });

    // Browser.getVersion is browser-scoped and chrome.debugger is tab-scoped,
    // so debugger mode asserts a positive raw CDP Runtime.evaluate instead.
    if (mode === "debugger") {
      try {
        const version = assertObject(await cdp.Browser.getVersion(), "Browser.getVersion");
        if (typeof version.protocolVersion !== "string" || typeof version.product !== "string") {
          throw new Error(`unexpected Browser.getVersion result ${JSON.stringify(version)}`);
        }
        console.log("Browser.getVersion ->", version);
      } catch (e) {
        console.log("Browser.getVersion -> (debugger route rejected:", e.message.replace(/\n/g, " "), ")");
      }
      const runtimeEval = assertObject(
        await cdp.Runtime.evaluate({ expression: "(() => 42)()", returnByValue: true }),
        "Runtime.evaluate",
      );
      if (runtimeEval.result?.value !== 42)
        throw new Error(`unexpected Runtime.evaluate result ${JSON.stringify(runtimeEval)}`);
      console.log("Runtime.evaluate ->", runtimeEval);
    } else {
      const version = assertObject(await cdp.Browser.getVersion(), "Browser.getVersion");
      if (typeof version.protocolVersion !== "string" || typeof version.product !== "string") {
        throw new Error(`unexpected Browser.getVersion result ${JSON.stringify(version)}`);
      }
      console.log("Browser.getVersion ->", version);
    }

    const cdpmodEval = (await cdp.Mod.evaluate({ expression: "({ extensionId: chrome.runtime.id })" })) as {
      extensionId?: string;
    };
    if (cdpmodEval.extensionId !== cdp.extension_id)
      throw new Error(`unexpected Mod.evaluate result ${JSON.stringify(cdpmodEval)}`);
    console.log("Mod.evaluate     ->", cdpmodEval);

    const echoRegistration = assertObject(
      await cdp.Mod.addCustomCommand({
        name: "Custom.echo",
        expression: `async (params, method) => ({ echoed: params.value, method })`,
      }),
      "Mod.addCustomCommand Custom.echo",
    );
    if (echoRegistration.registered !== true || echoRegistration.name !== "Custom.echo") {
      throw new Error(`unexpected Custom.echo registration ${JSON.stringify(echoRegistration)}`);
    }
    const echoResult = assertObject(await cdp.send("Custom.echo", { value: "custom-command-ok" }), "Custom.echo");
    if (echoResult.echoed !== "custom-command-ok" || echoResult.method !== "Custom.echo") {
      throw new Error(`unexpected Custom.echo result ${JSON.stringify(echoResult)}`);
    }
    console.log("Custom.echo      ->", echoResult);

    const tabCommandRegistration = assertObject(
      await cdp.Mod.addCustomCommand({
        name: "Custom.TabIdFromTargetId",
        paramsSchema: {
          targetId: cdp.types.zod.Target.TargetID,
        },
        resultSchema: {
          tabId: z.number().nullable(),
        },
        expression: `async ({ targetId }) => {
        const targets = await chrome.debugger.getTargets();
        const target = targets.find(target => target.id === targetId);
        return { tabId: target?.tabId ?? null };
      }`,
      }),
      "Mod.addCustomCommand Custom.TabIdFromTargetId",
    );
    if (tabCommandRegistration.registered !== true) {
      throw new Error(`unexpected TabIdFromTargetId registration ${JSON.stringify(tabCommandRegistration)}`);
    }
    const targetCommandRegistration = assertObject(
      await cdp.Mod.addCustomCommand({
        name: "Custom.targetIdFromTabId",
        paramsSchema: {
          tabId: z.number(),
        },
        resultSchema: {
          targetId: cdp.types.zod.Target.TargetID.nullable(),
          tabId: z.number().optional(),
        },
        expression: `async ({ tabId }) => {
        const targets = await chrome.debugger.getTargets();
        const target = targets.find(target => target.type === "page" && target.tabId === tabId);
        return { targetId: target?.id ?? null };
      }`,
      }),
      "Mod.addCustomCommand Custom.targetIdFromTabId",
    );
    if (targetCommandRegistration.registered !== true) {
      throw new Error(`unexpected targetIdFromTabId registration ${JSON.stringify(targetCommandRegistration)}`);
    }
    const responseMiddlewareRegistration = assertObject(
      await cdp.Mod.addMiddleware({
        name: "*",
        phase: cdp.RESPONSE,
        expression: `async (payload, next) => {
        const seen = new WeakSet();
        const visit = async value => {
          if (!value || typeof value !== "object" || seen.has(value)) return;
          seen.add(value);
          if (!Array.isArray(value) && typeof value.targetId === "string" && value.tabId == null) {
            const { tabId } = await cdp.send("Custom.TabIdFromTargetId", { targetId: value.targetId });
            if (tabId != null) value.tabId = tabId;
          }
          for (const child of Array.isArray(value) ? value : Object.values(value)) await visit(child);
        };
        await visit(payload);
        return next(payload);
      }`,
      }),
      "Mod.addMiddleware response",
    );
    if (responseMiddlewareRegistration.registered !== true || responseMiddlewareRegistration.phase !== cdp.RESPONSE) {
      throw new Error(`unexpected response middleware registration ${JSON.stringify(responseMiddlewareRegistration)}`);
    }

    const eventMiddlewareRegistration = assertObject(
      await cdp.Mod.addMiddleware({
        name: "*",
        phase: cdp.EVENT,
        expression: `async (payload, next) => {
        const seen = new WeakSet();
        const visit = async value => {
          if (!value || typeof value !== "object" || seen.has(value)) return;
          seen.add(value);
          if (!Array.isArray(value) && typeof value.targetId === "string" && value.tabId == null) {
            const { tabId } = await cdp.send("Custom.TabIdFromTargetId", { targetId: value.targetId });
            if (tabId != null) value.tabId = tabId;
          }
          for (const child of Array.isArray(value) ? value : Object.values(value)) await visit(child);
        };
        await visit(payload);
        return next(payload);
      }`,
      }),
      "Mod.addMiddleware event",
    );
    if (eventMiddlewareRegistration.registered !== true || eventMiddlewareRegistration.phase !== cdp.EVENT) {
      throw new Error(`unexpected event middleware registration ${JSON.stringify(eventMiddlewareRegistration)}`);
    }

    const demoEventRegistration = assertObject(
      await cdp.Mod.addCustomEvent({ name: "Custom.demoEvent" }),
      "Mod.addCustomEvent Custom.demoEvent",
    );
    if (demoEventRegistration.registered !== true || demoEventRegistration.name !== "Custom.demoEvent") {
      throw new Error(`unexpected Custom.demoEvent registration ${JSON.stringify(demoEventRegistration)}`);
    }
    const demoEventPromise = waitForEvent(cdp, "Custom.demoEvent", (event) => event?.value === "custom-event-ok");
    const emitResult = assertObject(
      await cdp.Mod.evaluate({
        expression: `async () => await CDPMod.emit("Custom.demoEvent", { value: "custom-event-ok" })`,
      }),
      "Custom.demoEvent emit",
    );
    if (emitResult.emitted !== true)
      throw new Error(`unexpected Custom.demoEvent emit result ${JSON.stringify(emitResult)}`);
    const demoEvent = assertObject(await demoEventPromise, "Custom.demoEvent");
    console.log("Custom.demoEvent ->", demoEvent);

    const ForegroundTargetChanged = z
      .object({
        targetId: cdp.types.zod.Target.TargetID.nullable(),
        tabId: z.number(),
        url: z.string().nullable().optional(),
      })
      .passthrough()
      .meta({ id: "Custom.foregroundTargetChanged" });
    const foregroundEventRegistration = assertObject(
      await cdp.Mod.addCustomEvent(ForegroundTargetChanged),
      "Mod.addCustomEvent Custom.foregroundTargetChanged",
    );
    if (foregroundEventRegistration.registered !== true) {
      throw new Error(`unexpected foreground event registration ${JSON.stringify(foregroundEventRegistration)}`);
    }
    cdp.on(ForegroundTargetChanged, (event) => {
      console.log("Custom.foregroundTargetChanged ->", event);
      foregroundEvents.push(event);
    });
    await cdp.Mod.evaluate({
      expression: `chrome.tabs.onActivated.addListener(async ({ tabId }) => {
          const targets = await chrome.debugger.getTargets();
          const target = targets.find(target => target.type === "page" && target.tabId === tabId);
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          await cdp.emit("Custom.foregroundTargetChanged", { tabId, targetId: target?.id ?? null, url: target?.url ?? tab?.url ?? null });
        })`,
    });

    await cdp.Target.setDiscoverTargets({ discover: true });
    const createdTarget = await cdp.Target.createTarget({ url: "https://example.com", background: true });
    const targetDeadline = Date.now() + 3000;
    while (
      !targetCreatedEvents.some((event) => event?.targetInfo?.targetId === createdTarget.targetId) &&
      Date.now() < targetDeadline
    ) {
      await sleep(20);
    }
    if (!targetCreatedEvents.some((event) => event?.targetInfo?.targetId === createdTarget.targetId)) {
      throw new Error(`expected Target.targetCreated for ${createdTarget.targetId}`);
    }
    console.log("normal event matched ->", createdTarget.targetId);

    const tabFromTarget = await cdp.send("Custom.TabIdFromTargetId", { targetId: createdTarget.targetId });
    if (typeof tabFromTarget.tabId !== "number")
      throw new Error(`unexpected Custom.TabIdFromTargetId result ${JSON.stringify(tabFromTarget)}`);
    console.log("Custom.TabIdFromTargetId ->", tabFromTarget);

    await cdp.Target.activateTarget({ targetId: createdTarget.targetId });
    const foregroundDeadline = Date.now() + 3000;
    while (
      !foregroundEvents.some((event) => event.targetId === createdTarget.targetId) &&
      Date.now() < foregroundDeadline
    ) {
      await sleep(20);
    }
    const foreground = foregroundEvents.find((event) => event.targetId === createdTarget.targetId);
    if (!foreground) throw new Error(`expected Custom.foregroundTargetChanged for ${createdTarget.targetId}`);
    if (foreground.tabId !== tabFromTarget.tabId)
      throw new Error(`unexpected Custom.foregroundTargetChanged result ${JSON.stringify(foreground)}`);

    const targetFromTab = await cdp.send("Custom.targetIdFromTabId", { tabId: foreground.tabId });
    if (targetFromTab.targetId !== createdTarget.targetId || targetFromTab.tabId !== foreground.tabId) {
      throw new Error(`unexpected Custom.targetIdFromTabId/middleware result ${JSON.stringify(targetFromTab)}`);
    }
    console.log("Custom.targetIdFromTabId ->", targetFromTab);

    console.log(
      `\nSUCCESS (${mode}): normal command, normal event, custom commands, custom event, and middleware all passed`,
    );

    // Drop into an interactive prompt when stdin is a TTY. Lets you poke at
    // the live browser: type Domain.method({...JS object literal...}) and
    // see the result; events you've subscribed to print as they arrive. Skip
    // the prompt when run non-interactively (CI, piped stdin) so the demo
    // exits cleanly after assertions.
    if (process.stdin.isTTY) {
      cdp.on("Mod.pong", (e) => console.log("\n[event] Mod.pong", e));
      await runRepl(cdp, mode);
    }
  } finally {
    await cdp.close();
  }
}

async function runRepl(cdp, mode) {
  console.log(`\nBrowser remains running. Mode: ${mode}.`);
  console.log("Enter commands as Domain.method({...}). Examples:");
  console.log("  Browser.getVersion({})");
  console.log('  Mod.evaluate({expression: "chrome.tabs.query({active: true})"})');
  console.log("  Custom.TabIdFromTargetId({targetId: '...'})");
  console.log("Type exit or quit to disconnect (browser keeps running).");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      let line;
      try {
        line = (await rl.question("CDPMod> ")).trim();
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
