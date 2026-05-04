import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";

import { launchChrome } from "../bridge/launcher.js";
import { CDPModClient } from "../client/js/CDPModClient.js";
import type { ModElement, ModPage } from "../types/replayable.js";
import {
  clickElement,
  css,
  element,
  elementText,
  frame,
  openModPage,
  queryModElement,
  role,
  textSelector,
  typeElement,
  xpath,
} from "./replayable-test-helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(HERE, "..", "extension");
const HOST_RULES = "MAP parent.magic-cdp.test 127.0.0.1,MAP child.magic-cdp.test 127.0.0.1";

type Fixture = {
  parentUrl: string;
  close(): Promise<void>;
  clickedCount(): number;
};

test(
  "Mod.DOM.elementText resolves a replayable page/frame/node path through an OOPIF",
  { timeout: 45_000 },
  async () => {
    await withFixtureAndClient(async ({ fixture, cdp }) => {
      const page = await openModPage(cdp, "stripe-main", `${fixture.parentUrl}/parent.html`);
      const cardNumber = stripeCardNumberPath(page);

      const result = await elementText(cdp, cardNumber);

      assert.equal(result, "Card number");
    });
  },
);

test(
  "Mod.Input.clickElement accepts only a replayable element path and resolves live ids internally",
  { timeout: 45_000 },
  async () => {
    await withFixtureAndClient(async ({ fixture, cdp }) => {
      const page = await openModPage(cdp, "stripe-main", `${fixture.parentUrl}/parent.html`);
      const payButton = stripePayButtonPath(page);

      await clickElement(cdp, payButton);
      await waitFor(() => fixture.clickedCount() === 1, "expected replayable path click to reach the OOPIF button");
    });
  },
);

test("Mod.Input.typeElement re-resolves the frame path after the owner iframe moves", { timeout: 45_000 }, async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const page = await openModPage(cdp, "stripe-main", `${fixture.parentUrl}/parent.html`);
    const cardInput = stripeCardInputPath(page);

    await clickElement(cdp, moveFrameButtonPath(page));
    await typeElement(cdp, cardInput, "4242424242424242");
  });
});

test("Mod.DOM.queryElement returns a replayable ModElement from a strict selector", { timeout: 45_000 }, async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const page = await openModPage(cdp, "selectors-main", `${fixture.parentUrl}/parent.html`);
    const button = await queryModElement(cdp, "move-button", page, [], role("button", "Move payment frame"));

    assert.equal(button.object, "mod.element");
    assert.equal(button.page.id, page.id);
    assert.equal(await elementText(cdp, button), "Move payment frame");
  });
});

test("ModPageHandle exposes selector-only page and frame actions", { timeout: 45_000 }, async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const page = await cdp.refs.openPage({ id: "dx-main", url: `${fixture.parentUrl}/parent.html` });

    assert.deepEqual(JSON.parse(JSON.stringify(page)), { object: "mod.page", id: "dx-main" });
    assert.equal(await page.text(role("button", "Move payment frame")), "Move payment frame");

    const moveResult = (await page.send("Mod.Input.click", {
      selector: role("button", "Move payment frame"),
    })) as { clicked?: boolean };
    assert.equal(moveResult.clicked, true);

    const stripe = page.frame(css("#payment-frame"));
    assert.equal(await stripe.text(role("textbox", "Card number")), "");

    const input = await stripe.query(role("textbox", "Card number"), { id: "card-input" });
    assert.equal(input.object, "mod.element");
    assert.equal(input.page.id, page.id);
    assert.equal(input.frames.length, 1);

    await stripe.type(role("textbox", "Card number"), "4242424242424242");
    await stripe.click(role("button", "Pay"));
    await waitFor(() => fixture.clickedCount() === 1, "expected selector-only page handle click to reach fixture");
  });
});

test("CDPMod selectors fail when a selector does not resolve to exactly one node", { timeout: 45_000 }, async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const page = await openModPage(cdp, "selectors-main", `${fixture.parentUrl}/ambiguous.html`);

    await assert.rejects(
      () => queryModElement(cdp, "ambiguous-button", page, [], css("button")),
      /exactly one|resolved to 2|Strict/i,
    );
    await assert.rejects(
      () => queryModElement(cdp, "missing-button", page, [], textSelector("missing")),
      /exactly one|resolved to 0|Strict/i,
    );
  });
});

test("Mod.Page.waitFor ignores pages that already existed before the wait started", { timeout: 45_000 }, async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const url = `${fixture.parentUrl}/parent.html`;
    const { targetId } = (await cdp.Target.createTarget({ url })) as { targetId: string };
    await waitForRawTargetUrl(cdp, targetId, url);

    await assert.rejects(
      () => cdp.send("Mod.Page.waitFor", { id: "preexisting-page", expected: { url }, timeoutMs: 1000 }),
      /timed out|timeout/i,
    );
  });
});

function stripeCardNumberPath(page: ModPage): ModElement {
  return element(page, stripeFrames(), xpath("/html[1]/body[1]/label[1]"));
}

function stripeCardInputPath(page: ModPage): ModElement {
  return element(page, stripeFrames(), xpath("/html[1]/body[1]/input[1]"));
}

function stripePayButtonPath(page: ModPage): ModElement {
  return element(page, stripeFrames(), xpath("/html[1]/body[1]/button[1]"));
}

function moveFrameButtonPath(page: ModPage): ModElement {
  return element(page, [], xpath("/html[1]/body[1]/button[1]"));
}

function stripeFrames() {
  return [frame(css("#payment-frame"))];
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
  let clicked = 0;
  const childServer = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/clicked") {
      clicked += 1;
      res.writeHead(204).end();
      return;
    }
    if (req.url === "/stripe.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <html>
          <body>
            <label>Card number</label>
            <input aria-label="Card number" />
            <button id="pay">Pay</button>
            <script>
              document.querySelector("#pay").addEventListener("click", () => {
                fetch("/clicked", { method: "POST" });
              });
            </script>
          </body>
        </html>`);
      return;
    }
    res.writeHead(404).end();
  });
  const childPort = await listen(childServer);

  const parentServer = http.createServer((req, res) => {
    if (req.url === "/parent.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <html>
          <body>
            <button onclick="document.querySelector('#moved-host').appendChild(document.querySelector('#payment-frame'))">
              Move payment frame
            </button>
            <main>
              <section>
                <iframe id="payment-frame" src="http://child.magic-cdp.test:${childPort}/stripe.html"></iframe>
              </section>
            </main>
            <aside id="moved-host"></aside>
          </body>
        </html>`);
      return;
    }
    if (req.url === "/ambiguous.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <html>
          <body>
            <button>Duplicate</button>
            <button>Duplicate</button>
          </body>
        </html>`);
      return;
    }
    if (req.url === "/opens-popup.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
        <html>
          <body>
            <button onclick="window.open('${fixtureOrigin(req)}/popup.html', 'checkout-popup')">Open popup</button>
          </body>
        </html>`);
      return;
    }
    if (req.url === "/popup.html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><body><h1>Popup checkout</h1></body></html>`);
      return;
    }
    res.writeHead(404).end();
  });
  const parentPort = await listen(parentServer);

  return {
    parentUrl: `http://parent.magic-cdp.test:${parentPort}`,
    close: async () => {
      await Promise.all([closeServer(parentServer), closeServer(childServer)]);
    },
    clickedCount: () => clicked,
  };
}

function fixtureOrigin(req: http.IncomingMessage): string {
  const host = req.headers.host;
  assert.equal(typeof host, "string", "fixture request should include host header");
  return `http://${host}`;
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

async function waitForRawTargetUrl(cdp: CDPModClient, targetId: string, href: string): Promise<void> {
  await waitFor(async () => {
    const targets = (await cdp.Target.getTargets()) as { targetInfos?: { targetId?: string; url?: string }[] };
    return targets.targetInfos?.some((target) => target.targetId === targetId && target.url === href);
  }, `expected raw target ${targetId} to navigate to ${href}`);
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
