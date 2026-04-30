// Intentionally empty. The MagicCDPClient bootstraps every server primitive
// (Magic.evaluate, Magic.addCustomCommand, Magic.addCustomEvent, ...) into
// this service worker via Runtime.evaluate at connect() time.
//
// This file only exists so that the browser keeps a service worker target
// alive for the extension, giving the client a guaranteed JS context with
// chrome.* permissions to attach to.
