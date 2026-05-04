import assert from "node:assert/strict";

import { CDPModClient } from "../client/js/CDPModClient.js";
import type { ModElement, ModFrameHop, ModPage, ModSelector } from "../types/replayable.js";
import { ModElementSchema, ModPageSchema } from "../types/replayable.js";

export function xpath(value: string): ModSelector {
  return { kind: "xpath", xpath: value };
}

export function css(value: string): ModSelector {
  return { kind: "css", selector: value };
}

export function role(role: string, name?: string, exact = true): ModSelector {
  return { kind: "role", role, name, exact };
}

export function textSelector(text: string, exact = true): ModSelector {
  return { kind: "text", text, exact };
}

export function frame(owner: ModSelector, assertNodeName: "IFRAME" | "FRAME" = "IFRAME"): ModFrameHop {
  return { owner, assertNodeName };
}

export function element(page: ModPage, frames: ModFrameHop[], selector: ModSelector, id?: string): ModElement {
  return ModElementSchema.parse({
    object: "mod.element",
    id,
    page,
    frames,
    selector,
  });
}

export async function openModPage(cdp: CDPModClient, id: string, url: string): Promise<ModPage> {
  const result = (await cdp.send("Mod.Page.open", { id, url })) as { page: unknown };
  return ModPageSchema.parse(result.page);
}

export async function waitForModPage(
  cdp: CDPModClient,
  id: string,
  params: { opener?: ModPage; expected?: { url?: string; urlIncludes?: string }; timeoutMs?: number },
): Promise<ModPage> {
  const result = (await cdp.send("Mod.Page.waitFor", { id, ...params })) as { page: unknown };
  return ModPageSchema.parse(result.page);
}

export async function queryModElement(
  cdp: CDPModClient,
  id: string,
  page: ModPage,
  frames: ModFrameHop[],
  selector: ModSelector,
): Promise<ModElement> {
  const result = (await cdp.send("Mod.DOM.queryElement", { id, page, frames, selector })) as { element: unknown };
  return ModElementSchema.parse(result.element);
}

export async function elementText(cdp: CDPModClient, modElement: ModElement): Promise<string> {
  return ((await cdp.send("Mod.DOM.elementText", { element: modElement })) as { text: string }).text;
}

export async function clickElement(cdp: CDPModClient, modElement: ModElement): Promise<void> {
  const result = (await cdp.send("Mod.Input.clickElement", { element: modElement })) as { clicked?: boolean };
  assert.equal(result.clicked, true);
}

export async function typeElement(cdp: CDPModClient, modElement: ModElement, value: string): Promise<void> {
  const result = (await cdp.send("Mod.Input.typeElement", { element: modElement, text: value })) as { typed?: boolean };
  assert.equal(result.typed, true);
}
