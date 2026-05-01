// Extension service worker entry point.
// Just installs MagicCDPServer on globalThis so client-side Runtime.evaluate
// expressions can find it.

import { MagicCDPServer } from "./MagicCDPServer.mjs";

globalThis.MagicCDP = MagicCDPServer;
