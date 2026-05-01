// launcher.js: find a Chrome/Chromium binary and launch it with CDP enabled.
// Knows nothing about MagicCDP, the extension, or wrap/unwrap. NEVER passes
// --load-extension; the caller (or injector.js over CDP) is responsible for
// getting the extension into the running browser.

import { spawn } from "node:child_process";
import type { StdioOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const CANDIDATE_PATHS = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome-canary",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome-stable",
  "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
].filter((candidate): candidate is string => Boolean(candidate));

const REQUIRED_FLAGS = [
  "--enable-unsafe-extension-debugging",
  "--remote-allow-origins=*",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-background-networking",
  "--disable-sync",
  "--password-store=basic",
  "--use-mock-keychain",
];

export function findChromeBinary(explicit?: string | null) {
  for (const candidate of [explicit, ...CANDIDATE_PATHS]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error(
    `No Chrome/Chromium binary found. Tried: ${[explicit, ...CANDIDATE_PATHS].filter(Boolean).join(", ")}. ` +
      `Set CHROME_PATH or pass executablePath.`,
  );
}

export async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// Launch Chrome with CDP enabled on 127.0.0.1:<port>. Resolves once
// /json/version responds. Returns { proc, port, cdpUrl, profileDir, close }.
export async function launchChrome({
  executablePath,
  port,
  headless = true,
  noSandbox = true,
  extraFlags = [],
  stdio = "ignore",
}: {
  executablePath?: string | null;
  port?: number | null;
  headless?: boolean;
  noSandbox?: boolean;
  extraFlags?: string[];
  stdio?: StdioOptions;
} = {}) {
  const exe = findChromeBinary(executablePath);
  const usePort = port || (await freePort());
  const profileDir = await mkdtemp(path.join(tmpdir(), "magic-cdp."));
  const flags = [
    ...REQUIRED_FLAGS,
    headless ? "--headless=new" : null,
    "--disable-gpu",
    noSandbox ? "--no-sandbox" : null,
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${usePort}`,
    ...extraFlags,
    "about:blank",
  ].filter(Boolean);

  const proc = spawn(exe, flags, { stdio, detached: false });
  const close = async () => {
    try {
      proc.kill("SIGTERM");
    } catch {}
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  };

  const cdpUrl = `http://127.0.0.1:${usePort}`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${cdpUrl}/json/version`);
      if (response.ok) {
        const version = await response.json();
        return { proc, port: usePort, cdpUrl, wsUrl: version.webSocketDebuggerUrl, profileDir, close };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await close();
  throw new Error(`Chrome at ${cdpUrl} did not become ready within 15s`);
}
