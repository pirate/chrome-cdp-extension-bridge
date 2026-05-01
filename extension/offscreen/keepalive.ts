const MAGIC_CDP_OFFSCREEN_KEEPALIVE_PORT = "MagicCDPOffscreenKeepAlive";
const MAGIC_CDP_OFFSCREEN_KEEPALIVE_INTERVAL_MS = 1_000;

let port: chrome.runtime.Port | null = null;

function sendKeepAlive() {
  port?.postMessage({ type: "MagicCDPOffscreenKeepAlive", at: Date.now() });
}

function connectKeepAlivePort() {
  port = chrome.runtime.connect({ name: MAGIC_CDP_OFFSCREEN_KEEPALIVE_PORT });
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connectKeepAlivePort, 250);
  });
  sendKeepAlive();
}

connectKeepAlivePort();
setInterval(sendKeepAlive, MAGIC_CDP_OFFSCREEN_KEEPALIVE_INTERVAL_MS);
