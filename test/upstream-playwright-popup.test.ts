import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { launchChrome } from "../bridge/launcher.js";
import { CDPModClient } from "../client/js/CDPModClient.js";
import type { ModElement, ModPage } from "../types/replayable.js";
import {
  clickElement,
  element as modElement,
  elementText,
  openModPage,
  waitForModPage,
  xpath,
} from "./replayable-test-helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(HERE, "..", "extension");

type Fixture = {
  origin: string;
  close(): Promise<void>;
};

test("Playwright popup: window.open creates a bindable ModPage", { timeout: 45_000 }, async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const opener = await openModPage(cdp, "window-open", `${fixture.origin}/window-open.html`);
    const popupPromise = waitForModPage(cdp, "window-open-popup", {
      opener,
      expected: { url: `${fixture.origin}/window-open-popup.html` },
    });

    await sleep(100);
    await click(cdp, element(opener, "/html[1]/body[1]/button[1]"));
    const popup = await popupPromise;

    assert.equal(await text(cdp, element(popup, "/html[1]/body[1]/h1[1]")), "window.open popup");
  });
});

test(
  "Playwright popup: target=_blank rel=opener is bindable through its opener ModPage",
  { timeout: 45_000 },
  async () => {
    await withFixtureAndClient(async ({ fixture, cdp }) => {
      const opener = await openModPage(cdp, "target-blank-opener", `${fixture.origin}/target-blank-opener.html`);
      const popupPromise = waitForModPage(cdp, "target-blank-opener-popup", {
        opener,
        expected: { url: `${fixture.origin}/target-blank-opener-popup.html` },
      });

      await sleep(100);
      await click(cdp, element(opener, "//*[@id='blank-opener']"));
      const popup = await popupPromise;

      assert.equal(await text(cdp, element(popup, "/html[1]/body[1]/h1[1]")), "target blank opener");
    });
  },
);

test("Playwright popup: noopener target is not bindable through its opener ModPage", { timeout: 45_000 }, async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const opener = await openModPage(cdp, "target-blank-noopener", `${fixture.origin}/target-blank-noopener.html`);
    const popupUrl = `${fixture.origin}/target-blank-noopener-popup.html`;
    const openerScopedRejection = assert.rejects(
      waitForModPage(cdp, "target-blank-noopener-popup-via-opener", {
        opener,
        expected: { url: popupUrl },
        timeoutMs: 1000,
      }),
      /timed out|timeout/i,
    );
    const popupWait = waitForModPage(cdp, "target-blank-noopener-popup", { expected: { url: popupUrl } });

    await sleep(100);
    await click(cdp, element(opener, "//*[@id='blank-noopener']"));
    const popupTarget = await waitForTargetUrl(cdp, popupUrl);
    const popup = await popupWait;

    assert.equal(popupTarget.canAccessOpener, false);
    await openerScopedRejection;
    assert.equal(await text(cdp, element(popup, "/html[1]/body[1]/h1[1]")), "target blank noopener");
  });
});

test("Playwright popup: about:blank popup remains bound after navigation", { timeout: 45_000 }, async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const opener = await openModPage(cdp, "about-blank-opener", `${fixture.origin}/about-blank-then-navigate.html`);
    const popupPromise = waitForModPage(cdp, "about-blank-popup", { opener });

    await sleep(100);
    await click(cdp, element(opener, "/html[1]/body[1]/button[1]"));
    const popup = await popupPromise;

    await waitFor(
      async () => (await text(cdp, element(popup, "/html[1]/body[1]/h1[1]"))) === "initial blank popup",
      "expected bound popup page to resolve the initial about:blank popup document",
    );

    await waitForTargetUrl(cdp, `${fixture.origin}/navigated-popup.html`);
    assert.equal(await text(cdp, element(popup, "/html[1]/body[1]/h1[1]")), "navigated popup");
  });
});

test(
  "Playwright popup: multiple popups from one opener bind to explicit ModPage ids",
  { timeout: 45_000 },
  async () => {
    await withFixtureAndClient(async ({ fixture, cdp }) => {
      const opener = await openModPage(cdp, "multiple-popups", `${fixture.origin}/multiple-popups.html`);
      const firstPromise = waitForModPage(cdp, "first-popup", {
        opener,
        expected: { url: `${fixture.origin}/first-popup.html` },
      });

      await sleep(100);
      await click(cdp, element(opener, "//*[@id='first']"));
      const firstPopup = await firstPromise;

      const secondPromise = waitForModPage(cdp, "second-popup", {
        opener,
        expected: { url: `${fixture.origin}/second-popup.html` },
      });

      await sleep(100);
      await click(cdp, element(opener, "//*[@id='second']"));
      const secondPopup = await secondPromise;

      assert.equal(await text(cdp, element(firstPopup, "/html[1]/body[1]/h1[1]")), "first popup");
      assert.equal(await text(cdp, element(secondPopup, "/html[1]/body[1]/h1[1]")), "second popup");
    });
  },
);

test("Playwright popup: popup close invalidates the bound ModPage", { timeout: 45_000 }, async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const opener = await openModPage(cdp, "close-popup-opener", `${fixture.origin}/close-popup.html`);
    const popupPromise = waitForModPage(cdp, "close-popup", {
      opener,
      expected: { url: `${fixture.origin}/closable-popup.html` },
    });

    await sleep(100);
    await click(cdp, element(opener, "//*[@id='open-close-popup']"));
    const popup = await popupPromise;
    const target = await waitForTargetUrl(cdp, `${fixture.origin}/closable-popup.html`);

    assert.equal(await text(cdp, element(popup, "/html[1]/body[1]/h1[1]")), "closable popup");
    await click(cdp, element(popup, "//*[@id='close-me']"));

    await waitFor(async () => !(await targetExists(cdp, target.targetId)), "expected closed popup target to disappear");
    await assert.rejects(() => text(cdp, element(popup, "/html[1]/body[1]/h1[1]")));
  });
});

test("Playwright popup: bound popup follows URL changes", { timeout: 45_000 }, async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const opener = await openModPage(cdp, "url-change-opener", `${fixture.origin}/url-change-opener.html`);
    const popupPromise = waitForModPage(cdp, "changing-popup", {
      opener,
      expected: { url: `${fixture.origin}/changing-popup.html` },
    });

    await sleep(100);
    await click(cdp, element(opener, "//*[@id='open-changing-popup']"));
    const popup = await popupPromise;

    assert.equal(await text(cdp, element(popup, "/html[1]/body[1]/h1[1]")), "before url change");
    await click(cdp, element(popup, "//*[@id='navigate']"));
    await waitForTargetUrl(cdp, `${fixture.origin}/changed-popup.html`);

    assert.equal(await text(cdp, element(popup, "/html[1]/body[1]/h1[1]")), "after url change");
  });
});

function element(page: ModPage, xpathValue: string): ModElement {
  return modElement(page, [], xpath(xpathValue));
}

async function text(cdp: CDPModClient, elementPath: ModElement): Promise<string> {
  return elementText(cdp, elementPath);
}

async function click(cdp: CDPModClient, elementPath: ModElement): Promise<void> {
  await clickElement(cdp, elementPath);
}

type PageTargetInfo = {
  targetId: string;
  type: string;
  url: string;
  openerId?: string;
  canAccessOpener: boolean;
};

async function waitForTargetUrl(cdp: CDPModClient, url: string): Promise<PageTargetInfo> {
  let target: PageTargetInfo | undefined;
  await waitFor(async () => {
    target = (await pageTargets(cdp)).find((candidate) => candidate.url === url);
    return Boolean(target);
  }, `expected page target for ${url}`);
  return target!;
}

async function targetExists(cdp: CDPModClient, targetId: string): Promise<boolean> {
  return (await pageTargets(cdp)).some((target) => target.targetId === targetId);
}

async function pageTargets(cdp: CDPModClient): Promise<PageTargetInfo[]> {
  const result = (await cdp.Target.getTargets()) as { targetInfos?: PageTargetInfo[] };
  return result.targetInfos?.filter((target) => target.type === "page") ?? [];
}

async function withFixtureAndClient(
  fn: (args: { fixture: Fixture; cdp: CDPModClient }) => Promise<void>,
): Promise<void> {
  const fixture = await startFixture();
  const chrome = await launchChrome({
    executable_path: chromium.executablePath(),
    headless: true,
    sandbox: process.platform !== "linux",
    extra_args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
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
  let origin = "";
  const server = http.createServer((req, res) => {
    if (req.url === "/window-open.html") {
      html(res, `<button onclick="window.open('${origin}/window-open-popup.html')">open</button>`);
      return;
    }
    if (req.url === "/window-open-popup.html") {
      html(res, "<h1>window.open popup</h1>");
      return;
    }
    if (req.url === "/target-blank-opener.html") {
      html(
        res,
        `<a id="blank-opener" target="_blank" rel="opener" href="${origin}/target-blank-opener-popup.html">open</a>`,
      );
      return;
    }
    if (req.url === "/target-blank-opener-popup.html") {
      html(res, "<h1>target blank opener</h1>");
      return;
    }
    if (req.url === "/target-blank-noopener.html") {
      html(
        res,
        `<a id="blank-noopener" target="_blank" rel="noopener" href="${origin}/target-blank-noopener-popup.html">open</a>`,
      );
      return;
    }
    if (req.url === "/target-blank-noopener-popup.html") {
      html(res, "<h1>target blank noopener</h1>");
      return;
    }
    if (req.url === "/about-blank-then-navigate.html") {
      html(
        res,
        `<button onclick="
          const popup = window.open('about:blank');
          popup.document.body.innerHTML = '<h1>initial blank popup</h1>';
          setTimeout(() => popup.location.href = '${origin}/navigated-popup.html', 2500);
        ">open</button>`,
      );
      return;
    }
    if (req.url === "/navigated-popup.html") {
      html(res, "<h1>navigated popup</h1>");
      return;
    }
    if (req.url === "/multiple-popups.html") {
      html(
        res,
        `<button id="first" onclick="window.open('${origin}/first-popup.html')">first</button>
         <button id="second" onclick="window.open('${origin}/second-popup.html')">second</button>`,
      );
      return;
    }
    if (req.url === "/first-popup.html") {
      html(res, "<h1>first popup</h1>");
      return;
    }
    if (req.url === "/second-popup.html") {
      html(res, "<h1>second popup</h1>");
      return;
    }
    if (req.url === "/close-popup.html") {
      html(res, `<button id="open-close-popup" onclick="window.open('${origin}/closable-popup.html')">open</button>`);
      return;
    }
    if (req.url === "/closable-popup.html") {
      html(res, `<h1>closable popup</h1><button id="close-me" onclick="window.close()">close</button>`);
      return;
    }
    if (req.url === "/url-change-opener.html") {
      html(
        res,
        `<button id="open-changing-popup" onclick="window.open('${origin}/changing-popup.html')">open</button>`,
      );
      return;
    }
    if (req.url === "/changing-popup.html") {
      html(
        res,
        `<h1>before url change</h1><button id="navigate" onclick="location.href='${origin}/changed-popup.html'">navigate</button>`,
      );
      return;
    }
    if (req.url === "/changed-popup.html") {
      html(res, "<h1>after url change</h1>");
      return;
    }
    res.writeHead(404).end();
  });
  const port = await listen(server);
  origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    close: async () => {
      await closeServer(server);
    },
  };
}

function html(res: http.ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><body>${body}</body></html>`);
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
    await sleep(100);
  }
  throw new Error(`${message}${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
