const bindingName = "__bbCustomEvent";
const customBus = new EventTarget();
const subscriptions = new Map();

globalThis.Custom = {
  async ping({ value }) {
    return { value, from: "extension-service-worker" };
  },

  async on({ eventName }) {
    if (!subscriptions.has(eventName)) {
      const listener = event => globalThis[bindingName]?.(JSON.stringify({ event: eventName, data: event.detail }));
      subscriptions.set(eventName, listener);
      customBus.addEventListener(eventName, listener);
    }
    return { subscribed: eventName };
  },

  async firecustomevent({ data }) {
    customBus.dispatchEvent(new CustomEvent("customevent", { detail: data }));
    return { fired: "customevent", data };
  },
};
