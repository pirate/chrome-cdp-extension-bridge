const bindingName = "__bbCustomEvent";
const customBus = new EventTarget();
const subscriptions = new Map();
let nextId = 1;

function openWs(url) {
  return new Promise(resolve => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => resolve(ws), { once: true });
  });
}

async function browserCdp(cdpHttpOrigin, method, params = {}) {
  const { webSocketDebuggerUrl } = await fetch(`${cdpHttpOrigin}/json/version`).then(response => response.json());
  const ws = await openWs(webSocketDebuggerUrl);
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));

  const result = await new Promise(resolve => {
    ws.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.id === id) resolve(message.result || {});
    });
  });
  ws.close();
  return result;
}

globalThis.Custom = {
  async ping({ value, cdpHttpOrigin }) {
    const version = await browserCdp(cdpHttpOrigin, "Browser.getVersion");
    return { value, from: "extension-service-worker", browserProduct: version.product };
  },

  async on({ eventName }) {
    if (!subscriptions.has(eventName)) {
      const listener = event => globalThis[bindingName]?.(JSON.stringify({ event: eventName, data: event.detail }));
      subscriptions.set(eventName, listener);
      customBus.addEventListener(eventName, listener);
    }
    return { subscribed: eventName };
  },

  async firecustomevent({ data, cdpHttpOrigin }) {
    await browserCdp(cdpHttpOrigin, "Browser.getVersion");
    customBus.dispatchEvent(new CustomEvent("customevent", { detail: data }));
    return { fired: "customevent", data };
  },
};
