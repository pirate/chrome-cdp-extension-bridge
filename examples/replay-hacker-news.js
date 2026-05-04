import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

import { CDPModClient } from "cdpmod";
import { chromium } from "playwright";
import { launchChrome } from "../dist/bridge/launcher.js";

const HN_URL = "https://news.ycombinator.com/";
const STORY_RANKS = [1, 2, 3];
const EXTENSION_PATH = fileURLToPath(new URL("../dist/extension/", import.meta.url));
const SERVICE_WORKER_PATH = fileURLToPath(new URL("../dist/extension/service_worker.js", import.meta.url));

const xpath = (value) => ({ kind: "xpath", xpath: value });

const HN_STORY_LIST = "/html[1]/body[1]/center[1]/table[1]/tbody[1]/tr[3]/td[1]/table[1]/tbody[1]";
const HN_ITEM_PAGE = "/html[1]/body[1]/center[1]/table[1]/tbody[1]/tr[3]/td[1]";
const TOP_COMMENT = xpath(`${HN_ITEM_PAGE}/table[2]/tbody[1]/tr[1]/td[1]/table[1]/tbody[1]/tr[1]/td[3]/div[2]/div[1]`);

function storyRow(rank) {
  return 1 + (rank - 1) * 3;
}

function storyTitle(rank) {
  return xpath(`${HN_STORY_LIST}/tr[${storyRow(rank)}]/td[3]/span[1]/a[1]`);
}

function storyCommentsLink(rank) {
  return xpath(`${HN_STORY_LIST}/tr[${storyRow(rank) + 1}]/td[2]/span[1]/a[3]`);
}

const REPLAY_PLAN = STORY_RANKS.map((rank) => ({
  rank,
  title: storyTitle(rank),
  comments: storyCommentsLink(rank),
  topComment: TOP_COMMENT,
}));

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function preview(value, max = 96) {
  const normalized = normalizeText(value);
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function launchOptions() {
  return {
    executable_path: chromium.executablePath(),
    headless: true,
    sandbox: process.platform !== "linux",
    extra_args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  };
}

function clientOptions(cdpUrl) {
  return {
    cdp_url: cdpUrl,
    extension_path: EXTENSION_PATH,
    routes: {
      "Mod.*": "service_worker",
      "*.*": "direct_cdp",
    },
    server: null,
  };
}

async function withReplayClient(fn) {
  if (!existsSync(SERVICE_WORKER_PATH)) {
    throw new Error(`Built extension not found at ${SERVICE_WORKER_PATH}. Run pnpm run build first.`);
  }

  const chrome = await launchChrome(launchOptions());
  const cdp = new CDPModClient(clientOptions(chrome.cdpUrl));
  try {
    await cdp.connect();
    assert.equal(typeof cdp.cdp_url, "string");
    await cdp.send("Mod.configure", {
      loopback_cdp_url: cdp.cdp_url,
      routes: { "*.*": "loopback_cdp" },
    });
    return await fn(cdp);
  } finally {
    await cdp.close().catch(() => {});
    await chrome.close().catch(() => {});
  }
}

async function waitForText(page, selector, label) {
  const deadline = Date.now() + 10_000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const text = normalizeText(await page.text(selector));
      if (text) return text;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }

  const reason = lastError instanceof Error ? lastError.message : "selector returned empty text";
  throw new Error(`Timed out waiting for ${label}: ${reason}`);
}

async function waitForPageUrl(page, expectedUrlPart, label) {
  const deadline = Date.now() + 10_000;
  let lastUrl = "";
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const result = await page.send("Mod.DOM.resolveContext");
      lastUrl = typeof result.pageUrl === "string" ? result.pageUrl : "";
      if (lastUrl.includes(expectedUrlPart)) return lastUrl;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }

  const reason = lastError instanceof Error ? lastError.message : `last URL was "${lastUrl}"`;
  throw new Error(`Timed out waiting for ${label}: ${reason}`);
}

async function runReplayPlan(cdp, label) {
  const rows = [];

  for (const step of REPLAY_PLAN) {
    const { rank } = step;
    const page = await cdp.refs.openPage({ id: `${label}-hn-${rank}`, url: HN_URL });

    const title = await waitForText(page, step.title, `story ${rank} title`);
    const comments = await waitForText(page, step.comments, `story ${rank} comments link`);
    assert.match(
      comments,
      /\b\d+\s+comments?\b/i,
      `HN story ${rank} does not have comments right now; comments link text was "${comments}".`,
    );

    await page.click(step.comments);
    await waitForPageUrl(page, "item?id=", `story ${rank} comments page`);
    const topComment = await waitForText(page, step.topComment, `story ${rank} top comment`);

    rows.push({ rank, title, topComment });
    console.log(`[${label}] #${rank} ${preview(title)}`);
    console.log(`[${label}]    ${preview(topComment)}`);
  }

  return rows;
}

const firstPass = await withReplayClient((cdp) => runReplayPlan(cdp, "record"));
const secondPass = await withReplayClient((cdp) => runReplayPlan(cdp, "replay"));

assert.deepEqual(secondPass, firstPass);
console.log(`Replay matched ${firstPass.length} Hacker News top comments in a fresh browser session.`);
