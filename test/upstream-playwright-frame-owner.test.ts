import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { launchChrome } from "../bridge/launcher.js";
import { CDPModClient } from "../client/js/CDPModClient.js";
import type { ModElement, ModFrameHop, ModPage } from "../types/replayable.js";
import { element, elementText, frame, openModPage, typeElement, xpath } from "./replayable-test-helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(HERE, "..", "extension");
const HOST_RULES = "MAP parent.magic-cdp.test 127.0.0.1,MAP child.magic-cdp.test 127.0.0.1";

type Fixture = {
  parentUrl: string;
  childUrl: string;
  close(): Promise<void>;
  clickedCount(): number;
};

test(
  "Playwright contentFrame/frameElement: owner iframe path resolves same-process frame content",
  { timeout: 45_000 },
  async () => {
    await withFixtureAndClient(async ({ fixture, cdp }) => {
      const page = await openPage(cdp, "simple", `${fixture.parentUrl}/simple.html`);

      const result = await elementText(cdp, elementPath(page, simpleFrame(), "/html[1]/body[1]/h1[1]"));

      assert.equal(result, "Hello iframe");
    });
  },
);

test(
  "Playwright ownerFrame: element path resolves the frame that owns a child element",
  { timeout: 45_000 },
  async () => {
    await withFixtureAndClient(async ({ fixture, cdp }) => {
      const page = await openPage(cdp, "simple", `${fixture.parentUrl}/simple.html`);

      await typeElement(
        cdp,
        elementPath(page, simpleFrame(), "/html[1]/body[1]/input[1]"),
        "typed through owner frame",
      );
      const value = await elementText(cdp, elementPath(page, simpleFrame(), "/html[1]/body[1]/output[1]"));

      assert.equal(value, "typed through owner frame");
    });
  },
);

test(
  "Playwright frameElement: nested owner iframe path resolves nested frame content",
  { timeout: 45_000 },
  async () => {
    await withFixtureAndClient(async ({ fixture, cdp }) => {
      const page = await openPage(cdp, "nested", `${fixture.parentUrl}/nested.html`);

      const result = await elementText(cdp, elementPath(page, nestedFrame(), "/html[1]/body[1]/button[1]"));

      assert.equal(result, "Hello nested iframe");
    });
  },
);

test(
  "Playwright contentFrame: owner iframe path resolves cross-process iframe content",
  { timeout: 45_000 },
  async () => {
    await withFixtureAndClient(async ({ fixture, cdp }) => {
      const page = await openPage(cdp, "oopif", `${fixture.parentUrl}/oopif.html`);

      const result = (await cdp.send("Mod.Input.clickElement", {
        element: elementPath(page, oopifFrame(), "/html[1]/body[1]/button[1]"),
      })) as { clicked?: boolean };

      assert.equal(result.clicked, true);
      await waitFor(() => fixture.clickedCount() === 1, "expected click inside cross-process iframe to reach fixture");
    });
  },
);

test("Playwright frameElement: detached owner iframe rejects replayable frame paths", { timeout: 45_000 }, async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const page = await openPage(cdp, "detached", `${fixture.parentUrl}/detached.html`);
    await cdp.send("Mod.Input.clickElement", {
      element: elementPath(page, [], "/html[1]/body[1]/button[1]"),
    });

    await assert.rejects(
      () =>
        cdp.send("Mod.DOM.elementText", {
          element: elementPath(page, [frame(xpath("/html[1]/body[1]/iframe[1]"))], "/html[1]/body[1]/h1[1]"),
        }),
      /iframe|frame|owner|detached|not found/i,
    );
  });
});

test(
  "Playwright frameLocator: non-frame owner elements fail the frame hop assertion",
  { timeout: 45_000 },
  async () => {
    await withFixtureAndClient(async ({ fixture, cdp }) => {
      const page = await openPage(cdp, "non-frame-owner", `${fixture.parentUrl}/non-frame-owner.html`);

      await assert.rejects(
        () =>
          cdp.send("Mod.DOM.elementText", {
            element: elementPath(page, [frame(xpath("/html[1]/body[1]/div[1]"))], "/html[1]/body[1]/button[1]"),
          }),
        /iframe|frame|expected|node/i,
      );
    });
  },
);

test(
  "Playwright frameElement: iframe in shadow DOM remains addressable as a frame owner",
  { timeout: 45_000 },
  async () => {
    await withFixtureAndClient(async ({ fixture, cdp }) => {
      const page = await openPage(cdp, "shadow", `${fixture.parentUrl}/shadow.html`);

      const result = await elementText(
        cdp,
        elementPath(
          page,
          [frame(xpath("/html[1]/body[1]/div[1]/#shadow-root[1]/iframe[1]"))],
          "/html[1]/body[1]/h1[1]",
        ),
      );

      assert.equal(result, "Hello shadow iframe");
    });
  },
);

test("Playwright frameLocator: ambiguous iframe owner path fails strict resolution", { timeout: 45_000 }, async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const page = await openPage(cdp, "ambiguous", `${fixture.parentUrl}/ambiguous.html`);

    await assert.rejects(
      () =>
        cdp.send("Mod.DOM.elementText", {
          element: elementPath(page, [frame(xpath("//iframe"))], "/html[1]/body[1]/button[1]"),
        }),
      /strict|ambiguous|multiple|resolved to 3|3 elements/i,
    );
  });
});

function simpleFrame(): ModFrameHop[] {
  return [frame(xpath("/html[1]/body[1]/iframe[1]"))];
}

function nestedFrame(): ModFrameHop[] {
  return [frame(xpath("/html[1]/body[1]/iframe[1]")), frame(xpath("/html[1]/body[1]/div[1]/iframe[1]"))];
}

function oopifFrame(): ModFrameHop[] {
  return [frame(xpath("/html[1]/body[1]/iframe[1]"))];
}

function elementPath(page: ModPage, frames: ModFrameHop[], xpathValue: string): ModElement {
  return element(page, frames, xpath(xpathValue));
}

async function withFixtureAndClient(
  fn: (args: { fixture: Fixture; cdp: CDPModClient }) => Promise<void>,
): Promise<void> {
  const fixture = await startFixture();
  const chrome = await launchChrome({
    executable_path: chromium.executablePath(),
    headless: true,
    sandbox: process.platform !== "linux",
    extra_args: [
      "--enable-unsafe-extension-debugging",
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--site-per-process",
      `--host-resolver-rules=${HOST_RULES}`,
      "--remote-allow-origins=*",
    ],
  });
  const cdp = new CDPModClient({
    cdp_url: chrome.cdpUrl,
    routes: {
      "Mod.*": "service_worker",
      "*.*": "direct_cdp",
    },
    server: {
      loopback_cdp_url: chrome.cdpUrl,
      routes: { "*.*": "loopback_cdp" },
    },
  });

  try {
    await cdp.connect();
    await fn({ fixture, cdp });
  } finally {
    await cdp.close().catch(() => {});
    await chrome.close();
    await fixture.close();
  }
}

async function openPage(cdp: CDPModClient, id: string, url: string): Promise<ModPage> {
  return openModPage(cdp, id, url);
}

async function startFixture(): Promise<Fixture> {
  let clicked = 0;
  const childServer = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/clicked") {
      clicked += 1;
      res.writeHead(204).end();
      return;
    }
    if (req.url === "/oopif-child.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <html>
          <body>
            <button onclick="fetch('/clicked', { method: 'POST' })">Cross-process button</button>
          </body>
        </html>`);
      return;
    }
    res.writeHead(404).end();
  });
  const childPort = await listen(childServer);
  const childUrl = `http://child.magic-cdp.test:${childPort}`;

  const parentServer = http.createServer((req, res) => {
    if (req.url === "/simple.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <html>
          <body>
            <iframe srcdoc="<h1>Hello iframe</h1><input oninput=&quot;document.querySelector('output').textContent = this.value&quot;><output></output>"></iframe>
          </body>
        </html>`);
      return;
    }
    if (req.url === "/nested.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <html>
          <body>
            <iframe srcdoc="<div><iframe srcdoc=&quot;<button>Hello nested iframe</button>&quot;></iframe></div>"></iframe>
          </body>
        </html>`);
      return;
    }
    if (req.url === "/oopif.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <html>
          <body>
            <iframe src="${childUrl}/oopif-child.html"></iframe>
          </body>
        </html>`);
      return;
    }
    if (req.url === "/detached.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <html>
          <body>
            <iframe srcdoc="<h1>Detached iframe</h1>"></iframe>
            <button onclick="document.querySelector('iframe').remove()">Detach frame</button>
          </body>
        </html>`);
      return;
    }
    if (req.url === "/non-frame-owner.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <html>
          <body>
            <div><button>Not in a frame</button></div>
          </body>
        </html>`);
      return;
    }
    if (req.url === "/shadow.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <html>
          <body>
            <div id="host"></div>
            <script>
              const iframe = document.createElement("iframe");
              iframe.srcdoc = "<h1>Hello shadow iframe</h1>";
              document.querySelector("#host").attachShadow({ mode: "open" }).appendChild(iframe);
            </script>
          </body>
        </html>`);
      return;
    }
    if (req.url === "/ambiguous.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <html>
          <body>
            <iframe srcdoc="<button>one</button>"></iframe>
            <iframe srcdoc="<button>two</button>"></iframe>
            <iframe srcdoc="<button>three</button>"></iframe>
          </body>
        </html>`);
      return;
    }
    res.writeHead(404).end();
  });
  const parentPort = await listen(parentServer);

  return {
    parentUrl: `http://parent.magic-cdp.test:${parentPort}`,
    childUrl,
    close: async () => {
      await Promise.all([closeServer(parentServer), closeServer(childServer)]);
    },
    clickedCount: () => clicked,
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate: () => boolean | Promise<boolean | undefined>, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${message}${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}
