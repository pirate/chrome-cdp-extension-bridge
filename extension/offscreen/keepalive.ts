const CDPMOD_OFFSCREEN_KEEPALIVE_PORT = "CDPModOffscreenKeepAlive";
const CDPMOD_OFFSCREEN_KEEPALIVE_INTERVAL_MS = 1_000;

let port: chrome.runtime.Port | null = null;

function sendKeepAlive() {
  port?.postMessage({ type: "CDPModOffscreenKeepAlive", at: Date.now() });
}

function connectKeepAlivePort() {
  port = chrome.runtime.connect({ name: CDPMOD_OFFSCREEN_KEEPALIVE_PORT });
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connectKeepAlivePort, 250);
  });
  sendKeepAlive();
}

connectKeepAlivePort();
setInterval(sendKeepAlive, CDPMOD_OFFSCREEN_KEEPALIVE_INTERVAL_MS);
