// Extension service worker entry point.
// Just installs MagicCDPServer on globalThis so client-side Runtime.evaluate
// expressions can find it.

import { MagicCDPServer } from "./MagicCDPServer.js";

globalThis.MagicCDP = MagicCDPServer;

const MAGIC_CDP_OFFSCREEN_KEEPALIVE_PORT = "MagicCDPOffscreenKeepAlive";
const MAGIC_CDP_OFFSCREEN_KEEPALIVE_PATH = "offscreen/keepalive.html";

let creatingOffscreenKeepAlive: Promise<void> | null = null;
let offscreenKeepAlivePort: chrome.runtime.Port | null = null;

function startOffscreenKeepAlive() {
  void ensureOffscreenKeepAlive().catch(() => {});
}

async function ensureOffscreenKeepAlive() {
  const offscreen = chrome.offscreen;
  if (!offscreen) return;

  const offscreenUrl = chrome.runtime.getURL(MAGIC_CDP_OFFSCREEN_KEEPALIVE_PATH);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });
  if (existingContexts.length > 0) return;

  creatingOffscreenKeepAlive ??= offscreen
    .createDocument({
      url: MAGIC_CDP_OFFSCREEN_KEEPALIVE_PATH,
      reasons: ["BLOBS"],
      justification: "Keep MagicCDP service worker active while CDP clients route commands through it.",
    })
    .finally(() => {
      creatingOffscreenKeepAlive = null;
    });
  await creatingOffscreenKeepAlive;
}

chrome.runtime.onStartup.addListener(startOffscreenKeepAlive);
chrome.runtime.onInstalled.addListener(startOffscreenKeepAlive);
chrome.tabs.onCreated.addListener(startOffscreenKeepAlive);
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== MAGIC_CDP_OFFSCREEN_KEEPALIVE_PORT) return;
  offscreenKeepAlivePort = port;
  port.onMessage.addListener(() => {});
  port.onDisconnect.addListener(() => {
    if (offscreenKeepAlivePort === port) offscreenKeepAlivePort = null;
  });
});

startOffscreenKeepAlive();
