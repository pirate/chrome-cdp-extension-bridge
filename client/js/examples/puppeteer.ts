// Puppeteer through the standalone CDPMods proxy.
//
// This is intentionally a normal Puppeteer connect flow. The proxy endpoint
// exposes the regular CDP discovery endpoints while adding Mods.* and Custom.*
// support to every CDPSession.

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

import { freePort, launchChrome } from "../../../bridge/launcher.js";
import { startProxy } from "../../../bridge/proxy.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const extension_path = path.resolve(here, "../../../extension");

let chrome: Awaited<ReturnType<typeof launchChrome>> | null = null;
let proxy: Awaited<ReturnType<typeof startProxy>> | null = null;
let browser: Awaited<ReturnType<typeof puppeteer.connect>> | null = null;

try {
  chrome = await launchChrome({
    headless: process.platform === "linux",
    sandbox: process.platform !== "linux",
    extra_args: [`--load-extension=${extension_path}`],
  });
  proxy = await startProxy({
    port: await freePort(),
    upstream: chrome.cdpUrl,
    extensionPath: extension_path,
    autoLaunch: false,
  });

  browser = await puppeteer.connect({ browserURL: proxy.url });
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  const cdp = (await page.createCDPSession()) as any;

  const version = await cdp.send("Browser.getVersion");
  assert.equal(typeof version.product, "string");
  console.log("Browser.getVersion ->", version.product);

  const worker_info = await cdp.send("Mods.evaluate", {
    expression: "({ extension_id: chrome.runtime.id, service_worker_url: chrome.runtime.getURL('service_worker.js') })",
  });
  assert.equal(typeof worker_info.extension_id, "string");
  console.log("Mods.evaluate ->", worker_info);

  await cdp.send("Mods.addCustomEvent", { name: "Custom.proxyEvent" });
  const event_received = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for Custom.proxyEvent")), 3000);
    cdp.on("Custom.proxyEvent", (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });

  await cdp.send("Mods.addCustomCommand", {
    name: "Custom.proxyEcho",
    expression: `async (params) => {
      await cdp.emit("Custom.proxyEvent", { source: "puppeteer", value: params.value });
      return { source: "puppeteer", value: params.value };
    }`,
  });

  const echo_result = await cdp.send("Custom.proxyEcho", { value: "hello-from-puppeteer" });
  const event_result = await event_received;
  assert.deepEqual(echo_result, { source: "puppeteer", value: "hello-from-puppeteer" });
  assert.deepEqual(event_result, { source: "puppeteer", value: "hello-from-puppeteer" });
  console.log("Custom.proxyEcho ->", echo_result);
  console.log("Custom.proxyEvent ->", event_result);
} finally {
  await browser?.close().catch(() => {});
  await proxy?.close().catch(() => {});
  await chrome?.close().catch(() => {});
}
