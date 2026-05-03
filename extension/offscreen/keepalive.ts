const CDP_MODS_OFFSCREEN_KEEPALIVE_PORT = "CDPModsOffscreenKeepAlive";
const CDP_MODS_OFFSCREEN_KEEPALIVE_INTERVAL_MS = 1_000;

let port: chrome.runtime.Port | null = null;

function sendKeepAlive() {
  port?.postMessage({ type: "CDPModsOffscreenKeepAlive", at: Date.now() });
}

function connectKeepAlivePort() {
  port = chrome.runtime.connect({ name: CDP_MODS_OFFSCREEN_KEEPALIVE_PORT });
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connectKeepAlivePort, 250);
  });
  sendKeepAlive();
}

connectKeepAlivePort();
setInterval(sendKeepAlive, CDP_MODS_OFFSCREEN_KEEPALIVE_INTERVAL_MS);
