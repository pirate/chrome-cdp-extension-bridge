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
  elementText as readElementText,
  frame,
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

type TargetInfo = {
  targetId: string;
  type: string;
  url: string;
  openerId?: string;
  canAccessOpener?: boolean;
};

test("upstream Frame Management: resolves nested frame owner chains and parent/child relationships", async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const page = await createPage(cdp, "nested-frames", `${fixture.origin}/nested-frames.html`);

    assert.equal(await elementText(cdp, nestedFrameLabel(page, "uno")), "uno");
    assert.equal(await elementText(cdp, nestedFrameLabel(page, "dos")), "dos");
    assert.equal(await elementText(cdp, nestedFrameLabel(page, "aframe")), "aframe");

    const resolved = (await cdp.send("Mod.DOM.resolveContext", {
      page,
      frames: nestedFrames("uno"),
    })) as { found?: boolean; page?: ModPage };
    assert.equal(resolved.found, true);
    assert.deepEqual(resolved.page, page);
  });
});

test("upstream Frame Management: replays dynamic attach, navigation, detach, and re-attach paths", async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const page = await createPage(cdp, "dynamic", `${fixture.origin}/dynamic.html`);
    const frameLabel = dynamicFrameLabel(page);

    await clickElement(cdp, pageButton(page, 1));
    assert.equal(await elementText(cdp, frameLabel), "attached");

    await clickElement(cdp, pageButton(page, 2));
    assert.equal(await elementText(cdp, frameLabel), "navigated");

    await clickElement(cdp, pageButton(page, 3));
    await assertRejectsMagicPath(cdp, frameLabel, "detached iframe owner should not resolve");

    await clickElement(cdp, pageButton(page, 4));
    assert.equal(await elementText(cdp, frameLabel), "reattached");
  });
});

test("upstream Frame Management: child frame paths stop resolving after main-frame navigation", async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const page = await createPage(cdp, "main-navigation", `${fixture.origin}/nested-frames.html`);
    const targetId = (await waitForTargetUrl(cdp, undefined, `${fixture.origin}/nested-frames.html`)).targetId;
    assert.equal(await elementText(cdp, nestedFrameLabel(page, "uno")), "uno");

    const sessionId = await attachToTarget(cdp, targetId);
    try {
      await cdp._sendFrame("Page.navigate", { url: `${fixture.origin}/empty.html` }, sessionId);
      await waitForTargetUrl(cdp, targetId, `${fixture.origin}/empty.html`);
    } finally {
      await cdp.Target.detachFromTarget({ sessionId }).catch(() => {});
    }

    await assertRejectsMagicPath(cdp, nestedFrameLabel(page, "uno"), "old child frame path should be detached");
    assert.equal(await elementText(cdp, pageHeading(page)), "Empty page");
  });
});

test("upstream Frame Management: resolves FRAME owners in framesets", async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const page = await createPage(cdp, "frameset", `${fixture.origin}/frameset.html`);

    assert.equal(await elementText(cdp, framesetLabel(page, "left")), "left");
    assert.equal(await elementText(cdp, framesetLabel(page, "inner-right")), "inner-right");
  });
});

test("upstream Frame Management: reports iframe inside shadow DOM in the CDP frame tree", async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    await createPage(cdp, "shadow", `${fixture.origin}/shadow.html`);
    const targetId = (await waitForTargetUrl(cdp, undefined, `${fixture.origin}/shadow.html`)).targetId;
    const sessionId = await attachToTarget(cdp, targetId);
    try {
      await cdp._sendFrame("Page.enable", {}, sessionId);
      const tree = (await cdp._sendFrame("Page.getFrameTree", {}, sessionId)) as { frameTree: unknown };
      const urls = frameTreeUrls(tree.frameTree);
      assert.ok(urls.includes(`${fixture.origin}/frame.html?label=shadow`), "expected shadow iframe in frame tree");
    } finally {
      await cdp.Target.detachFromTarget({ sessionId }).catch(() => {});
    }
  });
});

test("upstream Page/Target: resolves popup opener paths and distinguishes noopener targets", async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const opener = await createPage(cdp, "popup-controls", `${fixture.origin}/popup-controls.html`);
    const openerTargetId = (await waitForTargetUrl(cdp, undefined, `${fixture.origin}/popup-controls.html`)).targetId;

    const openerPopup = `${fixture.origin}/popup.html?kind=opener`;
    const openerPopupPromise = waitForModPage(cdp, "popup-opener", {
      opener,
      expected: { url: openerPopup },
    });
    await sleep(100);
    await clickElement(cdp, pageButton(opener, 1));
    const openerPopupPage = await openerPopupPromise;
    assert.equal(await elementText(cdp, popupHeading(openerPopupPage)), "Popup opener");

    const openerTarget = await waitForTarget(cdp, (target) => target.url === openerPopup);
    assert.equal(openerTarget.openerId, openerTargetId);

    const noopenerPopup = `${fixture.origin}/popup.html?kind=noopener`;
    const noopenerPopupPromise = waitForModPage(cdp, "popup-noopener", {
      expected: { url: noopenerPopup },
    });
    await sleep(100);
    await clickElement(cdp, pageButton(opener, 2));
    const noopenerPopupPage = await noopenerPopupPromise;
    const noopenerTarget = await waitForTarget(cdp, (target) => target.url === noopenerPopup);
    assert.equal(await elementText(cdp, popupHeading(noopenerPopupPage)), "Popup noopener");
    assert.equal(noopenerTarget.canAccessOpener, false);
  });
});

test("upstream Target: observes target URL changes and resolves multiple page targets by URL", async () => {
  await withFixtureAndClient(async ({ fixture, cdp }) => {
    const changingPage = await createPage(cdp, "changing", `${fixture.origin}/empty.html`);
    const changingTargetId = (await waitForTargetUrl(cdp, undefined, `${fixture.origin}/empty.html`)).targetId;
    const sessionId = await attachToTarget(cdp, changingTargetId);
    try {
      await cdp._sendFrame("Page.navigate", { url: `${fixture.origin}/target-a.html` }, sessionId);
      await waitForTargetUrl(cdp, changingTargetId, `${fixture.origin}/target-a.html`);
      assert.equal(await elementText(cdp, pageHeading(changingPage)), "Target A");

      await cdp._sendFrame("Page.navigate", { url: `${fixture.origin}/target-b.html` }, sessionId);
      await waitForTargetUrl(cdp, changingTargetId, `${fixture.origin}/target-b.html`);
      assert.equal(await elementText(cdp, pageHeading(changingPage)), "Target B");
    } finally {
      await cdp.Target.detachFromTarget({ sessionId }).catch(() => {});
    }

    const multiOne = await createPage(cdp, "multi-one", `${fixture.origin}/multi-one.html`);
    const multiTwo = await createPage(cdp, "multi-two", `${fixture.origin}/multi-two.html`);
    assert.equal(await elementText(cdp, pageHeading(multiOne)), "Multi One");
    assert.equal(await elementText(cdp, pageHeading(multiTwo)), "Multi Two");

    const targets = await pageTargets(cdp);
    assert.ok(targets.some((target) => target.url === `${fixture.origin}/multi-one.html`));
    assert.ok(targets.some((target) => target.url === `${fixture.origin}/multi-two.html`));
  });
});

function nestedFrameLabel(page: ModPage, label: "uno" | "dos" | "aframe"): ModElement {
  return elementPath(page, nestedFrames(label), "/html[1]/body[1]/main[1]/h1[1]");
}

function nestedFrames(label: "uno" | "dos" | "aframe"): ModFrameHop[] {
  if (label === "aframe") {
    return [frame(xpath("/html[1]/body[1]/iframe[2]"))];
  }
  return [
    frame(xpath("/html[1]/body[1]/iframe[1]")),
    frame(xpath(label === "uno" ? "/html[1]/body[1]/iframe[1]" : "/html[1]/body[1]/iframe[2]")),
  ];
}

function dynamicFrameLabel(page: ModPage): ModElement {
  return elementPath(page, [frame(xpath("/html[1]/body[1]/section[1]/iframe[1]"))], "/html[1]/body[1]/main[1]/h1[1]");
}

function framesetLabel(page: ModPage, label: "left" | "inner-right"): ModElement {
  const frames =
    label === "left"
      ? [frame(xpath("/html[1]/frameset[1]/frame[1]"), "FRAME")]
      : [
          frame(xpath("/html[1]/frameset[1]/frame[2]"), "FRAME"),
          frame(xpath("/html[1]/frameset[1]/frame[2]"), "FRAME"),
        ];
  return elementPath(page, frames, "/html[1]/body[1]/main[1]/h1[1]");
}

function pageHeading(page: ModPage): ModElement {
  return elementPath(page, [], "/html[1]/body[1]/main[1]/h1[1]");
}

function pageButton(page: ModPage, buttonNumber: number): ModElement {
  return elementPath(page, [], `/html[1]/body[1]/button[${buttonNumber}]`);
}

function popupHeading(page: ModPage): ModElement {
  return elementPath(page, [], "/html[1]/body[1]/main[1]/h1[1]");
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

async function createPage(cdp: CDPModClient, id: string, url: string): Promise<ModPage> {
  return openModPage(cdp, id, url);
}

async function attachToTarget(cdp: CDPModClient, targetId: string): Promise<string> {
  const { sessionId } = (await cdp.Target.attachToTarget({ targetId, flatten: true })) as { sessionId: string };
  return sessionId;
}

async function elementText(cdp: CDPModClient, element: ModElement): Promise<string> {
  return waitFor(
    async () => {
      const result = await readElementText(cdp, element);
      return typeof result === "string" ? result : false;
    },
    `expected Mod.DOM.elementText to resolve ${JSON.stringify(element)}`,
  );
}

async function assertRejectsMagicPath(cdp: CDPModClient, element: ModElement, message: string): Promise<void> {
  await assert.rejects(() => cdp.send("Mod.DOM.elementText", { element }), undefined, message);
}

async function pageTargets(cdp: CDPModClient): Promise<TargetInfo[]> {
  const result = (await cdp.Target.getTargets()) as { targetInfos?: TargetInfo[] };
  return (result.targetInfos ?? []).filter((target) => target.type === "page");
}

async function waitForTargetUrl(cdp: CDPModClient, targetId: string | undefined, url: string): Promise<TargetInfo> {
  return waitForTarget(cdp, (target) => (targetId ? target.targetId === targetId : true) && target.url === url);
}

async function waitForTarget(cdp: CDPModClient, predicate: (target: TargetInfo) => boolean): Promise<TargetInfo> {
  const target = await waitFor(async () => (await pageTargets(cdp)).find(predicate), "expected matching target");
  assert.ok(target);
  return target;
}

function frameTreeUrls(frameTree: unknown): string[] {
  const urls: string[] = [];
  const visit = (node: any) => {
    if (typeof node?.frame?.url === "string") urls.push(node.frame.url);
    for (const child of node?.childFrames ?? []) visit(child);
  };
  visit(frameTree);
  return urls;
}

async function startFixture(): Promise<Fixture> {
  let origin = "";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
    res.setHeader("content-type", "text/html");

    if (url.pathname === "/nested-frames.html") {
      res.end(html`
        <body>
          <iframe id="twoframes" name="2frames" src="/two-frames.html"></iframe>
          <iframe id="aframe" name="aframe" src="/frame.html?label=aframe"></iframe>
        </body>
      `);
      return;
    }
    if (url.pathname === "/two-frames.html") {
      res.end(html`
        <body>
          <iframe id="uno" name="uno" src="/frame.html?label=uno"></iframe>
          <iframe id="dos" name="dos" src="/frame.html?label=dos"></iframe>
        </body>
      `);
      return;
    }
    if (url.pathname === "/frame.html") {
      res.end(page(url.searchParams.get("label") ?? "frame"));
      return;
    }
    if (url.pathname === "/dynamic.html") {
      res.end(html`
        <body>
          <button onclick="attachDynamic('/dynamic-frame.html?label=attached')">Attach</button>
          <button onclick="document.querySelector('#dynamic-frame').src = '/dynamic-frame.html?label=navigated'">
            Navigate
          </button>
          <button onclick="window.savedFrame = document.querySelector('#dynamic-frame'); window.savedFrame.remove()">
            Detach
          </button>
          <button onclick="window.savedFrame.src = '/dynamic-frame.html?label=reattached'; document.querySelector('#host').appendChild(window.savedFrame)">
            Reattach
          </button>
          <section id="host"></section>
          <script>
            function attachDynamic(src) {
              const frame = document.createElement("iframe");
              frame.id = "dynamic-frame";
              frame.src = src;
              document.querySelector("#host").appendChild(frame);
            }
          </script>
        </body>
      `);
      return;
    }
    if (url.pathname === "/dynamic-frame.html") {
      res.end(page(url.searchParams.get("label") ?? "dynamic"));
      return;
    }
    if (url.pathname === "/frameset.html") {
      res.end(html`
        <frameset cols="50%,50%">
          <frame name="left" src="/frame.html?label=left">
          <frame name="right" src="/inner-frameset.html">
        </frameset>
      `);
      return;
    }
    if (url.pathname === "/inner-frameset.html") {
      res.end(html`
        <frameset rows="50%,50%">
          <frame name="inner-left" src="/frame.html?label=inner-left">
          <frame name="inner-right" src="/frame.html?label=inner-right">
        </frameset>
      `);
      return;
    }
    if (url.pathname === "/shadow.html") {
      res.end(html`
        <body>
          <div id="host"></div>
          <script>
            const root = document.querySelector("#host").attachShadow({ mode: "open" });
            const frame = document.createElement("iframe");
            frame.src = "/frame.html?label=shadow";
            root.appendChild(frame);
          </script>
        </body>
      `);
      return;
    }
    if (url.pathname === "/popup-controls.html") {
      res.end(html`
        <body>
          <button onclick="window.open('/popup.html?kind=opener', '_blank')">Open popup</button>
          <button onclick="window.open('/popup.html?kind=noopener', '_blank', 'noopener')">Open noopener</button>
        </body>
      `);
      return;
    }
    if (url.pathname === "/popup.html") {
      res.end(page(`Popup ${url.searchParams.get("kind") ?? "unknown"}`));
      return;
    }
    if (url.pathname === "/empty.html") {
      res.end(page("Empty page"));
      return;
    }
    if (url.pathname === "/target-a.html") {
      res.end(page("Target A"));
      return;
    }
    if (url.pathname === "/target-b.html") {
      res.end(page("Target B"));
      return;
    }
    if (url.pathname === "/multi-one.html") {
      res.end(page("Multi One"));
      return;
    }
    if (url.pathname === "/multi-two.html") {
      res.end(page("Multi Two"));
      return;
    }

    res.writeHead(404).end(page("Not found"));
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

function page(heading: string): string {
  return html`
    <body>
      <main><h1>${escapeHtml(heading)}</h1></main>
    </body>
  `;
}

function html(strings: TemplateStringsArray, ...values: string[]): string {
  let result = "<!doctype html><html>";
  for (let index = 0; index < strings.length; index += 1) result += strings[index] + (values[index] ?? "");
  return `${result}</html>`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
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

async function waitFor<T>(
  predicate: () => T | undefined | false | Promise<T | undefined | false>,
  message: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${message}${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
