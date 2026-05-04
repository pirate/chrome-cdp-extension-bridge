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
import {
  clickElement,
  element,
  elementText,
  frame,
  openModPage,
  typeElement,
  xpath,
} from "./replayable-test-helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(HERE, "..", "extension");
const HOST_RULES = [
  "MAP parent.magic-cdp.test 127.0.0.1",
  "MAP child.magic-cdp.test 127.0.0.1",
  "MAP grandchild.magic-cdp.test 127.0.0.1",
].join(",");

type Fixture = {
  parentUrl: string;
  childUrl: string;
  grandchildUrl: string;
  close(): Promise<void>;
};

test(
  "Puppeteer OOPIF: cross-site iframe under --site-per-process resolves like a normal iframe",
  { timeout: 45_000 },
  async () => {
    await withFixtureAndClient(async ({ fixture, cdp }) => {
      const pageUrl = `${fixture.parentUrl}/mixed-iframes.html`;
      const page = await openPage(cdp, "mixed-iframes", pageUrl);

      const normal = await elementText(cdp, modElement(page, [frameById("normal-frame")], "/html[1]/body[1]/h1[1]"));
      const oopif = await elementText(cdp, modElement(page, [frameById("oopif-frame")], "/html[1]/body[1]/h1[1]"));
      const resolved = (await cdp.send("Mod.DOM.resolveContext", {
        page,
        frames: [frameById("oopif-frame")],
      })) as { found?: boolean };

      assert.equal(normal, "same-site iframe");
      assert.equal(oopif, "cross-site iframe");
      assert.equal(resolved.found, true);
    });
  },
);

test("Puppeteer OOPIF: iframe can transition from normal iframe to OOPIF", { timeout: 45_000 }, async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const pageUrl = `${fixture.parentUrl}/transition.html`;
    const page = await openPage(cdp, "transition", pageUrl);
    const body = modElement(page, [frameById("transition-frame")], "/html[1]/body[1]");

    assert.equal(await elementText(cdp, body), "normal initial");
    await click(cdp, modElement(page, [], "/html[1]/body[1]/button[1]"));

    await waitFor(
      async () => (await elementText(cdp, body)) === "oopif navigated",
      "expected iframe path to re-resolve after same-site to cross-site navigation",
    );
  });
});

test("Puppeteer OOPIF: OOPIF can transition back to a normal iframe", { timeout: 45_000 }, async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const pageUrl = `${fixture.parentUrl}/transition-back.html`;
    const page = await openPage(cdp, "transition-back", pageUrl);
    const body = modElement(page, [frameById("transition-frame")], "/html[1]/body[1]");

    assert.equal(await elementText(cdp, body), "oopif initial");
    await click(cdp, modElement(page, [], "/html[1]/body[1]/button[1]"));

    await waitFor(
      async () => (await elementText(cdp, body)) === "normal navigated",
      "expected iframe path to re-resolve after cross-site to same-site navigation",
    );
  });
});

test(
  "Puppeteer OOPIF: nested OOPIF paths resolve through multiple cross-site owners",
  { timeout: 45_000 },
  async () => {
    await withFixtureAndClient(async ({ fixture, cdp }) => {
      const pageUrl = `${fixture.parentUrl}/nested-oopif.html`;
      const page = await openPage(cdp, "nested-oopif", pageUrl);

      const text = await elementText(
        cdp,
        modElement(page, [frameById("outer-oopif"), frameById("inner-oopif")], "/html[1]/body[1]/h1[1]"),
      );

      assert.equal(text, "nested grandchild oopif");
    });
  },
);

test("Puppeteer OOPIF: a normal frame inside an OOPIF is addressable", { timeout: 45_000 }, async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const pageUrl = `${fixture.parentUrl}/oopif-with-inner-frame.html`;
    const page = await openPage(cdp, "oopif-with-inner-frame", pageUrl);

    const text = await elementText(
      cdp,
      modElement(page, [frameById("oopif-frame"), frameById("inner-normal-frame")], "/html[1]/body[1]/h1[1]"),
    );

    assert.equal(text, "inner frame inside oopif");
  });
});

test(
  "Puppeteer OOPIF: detached OOPIF owner disappears without breaking parent paths",
  { timeout: 45_000 },
  async () => {
    await withFixtureAndClient(async ({ fixture, cdp }) => {
      const pageUrl = `${fixture.parentUrl}/detached-oopif.html`;
      const page = await openPage(cdp, "detached-oopif", pageUrl);
      const oopifHeading = modElement(page, [frameById("detached-frame")], "/html[1]/body[1]/h1[1]");
      const count = modElement(page, [], "/html[1]/body[1]/p[1]");

      assert.equal(await elementText(cdp, oopifHeading), "detachable oopif");
      await click(cdp, modElement(page, [], "/html[1]/body[1]/button[1]"));

      await waitFor(async () => (await elementText(cdp, count)) === "frames: 0", "expected OOPIF owner to detach");
    });
  },
);

test("Puppeteer OOPIF: click and type interactions work inside an OOPIF", { timeout: 45_000 }, async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const pageUrl = `${fixture.parentUrl}/interactive-oopif.html`;
    const page = await openPage(cdp, "interactive-oopif", pageUrl);
    const frame = [frameById("interactive-frame")];

    await clickElement(cdp, modElement(page, frame, "/html[1]/body[1]/button[1]"));
    await typeElement(cdp, modElement(page, frame, "/html[1]/body[1]/input[1]"), "typed through oopif");

    await waitFor(
      async () =>
        (await elementText(cdp, modElement(page, frame, "/html[1]/body[1]/p[1]"))) === "clicked typed through oopif",
      "expected click and type to mutate OOPIF content",
    );
  });
});

function modElement(page: ModPage, frames: ModFrameHop[], xpathValue: string): ModElement {
  return element(page, frames, xpath(xpathValue));
}

function frameById(id: string): ModFrameHop {
  return frame(xpath(`//*[@id=${xpathStringLiteral(id)}]`));
}

async function click(cdp: CDPModClient, modElement: ModElement): Promise<void> {
  await clickElement(cdp, modElement);
}

async function openPage(cdp: CDPModClient, id: string, url: string): Promise<ModPage> {
  return openModPage(cdp, id, url);
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
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--site-per-process",
      `--host-resolver-rules=${HOST_RULES}`,
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

async function startFixture(): Promise<Fixture> {
  let parentUrl = "";
  let childUrl = "";
  let grandchildUrl = "";

  const parentServer = http.createServer((req, res) => {
    if (req.url === "/empty.html") {
      html(res, "<h1>same-site iframe</h1>");
      return;
    }
    if (req.url === "/normal-navigated.html") {
      html(res, "normal navigated");
      return;
    }
    if (req.url === "/mixed-iframes.html") {
      html(
        res,
        `<iframe id="normal-frame" src="${parentUrl}/empty.html"></iframe>
         <iframe id="oopif-frame" src="${childUrl}/oopif.html"></iframe>`,
      );
      return;
    }
    if (req.url === "/transition.html") {
      html(
        res,
        `<button onclick="document.querySelector('#transition-frame').src='${childUrl}/navigated.html'">to oopif</button>
         <iframe id="transition-frame" src="${parentUrl}/normal-initial.html"></iframe>`,
      );
      return;
    }
    if (req.url === "/normal-initial.html") {
      html(res, "normal initial");
      return;
    }
    if (req.url === "/transition-back.html") {
      html(
        res,
        `<button onclick="document.querySelector('#transition-frame').src='${parentUrl}/normal-navigated.html'">to normal</button>
         <iframe id="transition-frame" src="${childUrl}/initial.html"></iframe>`,
      );
      return;
    }
    if (req.url === "/nested-oopif.html") {
      html(res, `<iframe id="outer-oopif" src="${childUrl}/outer-oopif.html"></iframe>`);
      return;
    }
    if (req.url === "/oopif-with-inner-frame.html") {
      html(res, `<iframe id="oopif-frame" src="${childUrl}/with-inner-frame.html"></iframe>`);
      return;
    }
    if (req.url === "/detached-oopif.html") {
      html(
        res,
        `<button onclick="document.querySelector('#detached-frame').remove(); update()">detach</button>
         <p>frames: 1</p>
         <iframe id="detached-frame" src="${childUrl}/detachable.html"></iframe>
         <script>
           function update() {
             document.querySelector('p').textContent = 'frames: ' + document.querySelectorAll('iframe').length;
           }
         </script>`,
      );
      return;
    }
    if (req.url === "/interactive-oopif.html") {
      html(res, `<iframe id="interactive-frame" src="${childUrl}/interactive.html"></iframe>`);
      return;
    }
    notFound(res);
  });
  const parentPort = await listen(parentServer);
  parentUrl = `http://parent.magic-cdp.test:${parentPort}`;

  const childServer = http.createServer((req, res) => {
    if (req.url === "/oopif.html") {
      html(res, "<h1>cross-site iframe</h1>");
      return;
    }
    if (req.url === "/initial.html") {
      html(res, "oopif initial");
      return;
    }
    if (req.url === "/navigated.html") {
      html(res, "oopif navigated");
      return;
    }
    if (req.url === "/outer-oopif.html") {
      html(res, `<iframe id="inner-oopif" src="${grandchildUrl}/nested.html"></iframe>`);
      return;
    }
    if (req.url === "/with-inner-frame.html") {
      html(res, `<iframe id="inner-normal-frame" src="${childUrl}/inner-frame.html"></iframe>`);
      return;
    }
    if (req.url === "/inner-frame.html") {
      html(res, "<h1>inner frame inside oopif</h1>");
      return;
    }
    if (req.url === "/detachable.html") {
      html(res, "<h1>detachable oopif</h1>");
      return;
    }
    if (req.url === "/interactive.html") {
      html(
        res,
        `<button onclick="document.querySelector('p').dataset.clicked='true'; render()">click</button>
         <input oninput="render()" />
         <p>idle</p>
         <script>
           function render() {
             const clicked = document.querySelector('p').dataset.clicked === 'true';
             const value = document.querySelector('input').value;
             document.querySelector('p').textContent = (clicked ? 'clicked ' : '') + value;
           }
         </script>`,
      );
      return;
    }
    notFound(res);
  });
  const childPort = await listen(childServer);
  childUrl = `http://child.magic-cdp.test:${childPort}`;

  const grandchildServer = http.createServer((req, res) => {
    if (req.url === "/nested.html") {
      html(res, "<h1>nested grandchild oopif</h1>");
      return;
    }
    notFound(res);
  });
  const grandchildPort = await listen(grandchildServer);
  grandchildUrl = `http://grandchild.magic-cdp.test:${grandchildPort}`;

  return {
    parentUrl,
    childUrl,
    grandchildUrl,
    close: async () => {
      await Promise.all([closeServer(parentServer), closeServer(childServer), closeServer(grandchildServer)]);
    },
  };
}

function html(res: http.ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><body>${body}</body></html>`);
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404).end();
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

function xpathStringLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat('${value.replaceAll("'", `', "'", '`)}')`;
}
