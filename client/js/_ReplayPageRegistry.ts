import { PageTargetInfoSchema, type ModPage, type PageTargetInfo } from "../../types/replayable.js";

/**
 * @internal
 *
 * Private CDPModClient registry for replayable ModPage binding state.
 *
 * This records client-observed TargetInfo snapshots, ModPage <-> targetId
 * bindings, and one-shot target resume attempts so replayable references can be
 * resolved. It is not authoritative operational browser truth.
 */
export class ReplayPageRegistry {
  private readonly target_infos = new Map<string, PageTargetInfo>();
  private readonly mod_page_targets = new Map<string, string>();
  private readonly mod_target_pages = new Map<string, string>();
  private readonly resumed_target_ids = new Set<string>();
  private next_mod_page_id = 1;

  createPage(id?: string): ModPage {
    let page_id = id;
    while (!page_id) {
      const candidate = `page_${this.next_mod_page_id++}`;
      if (!this.mod_page_targets.has(candidate)) page_id = candidate;
    }
    if (this.mod_page_targets.has(page_id)) throw new Error(`ModPage id "${page_id}" is already bound.`);
    return { object: "mod.page", id: page_id };
  }

  bindPage(page: ModPage, target_id: string) {
    this.mod_page_targets.set(page.id, target_id);
    this.mod_target_pages.set(target_id, page.id);
  }

  targetIdForPage(page: ModPage): string | null {
    return this.mod_page_targets.get(page.id) ?? null;
  }

  targetInfo(target_id: string): PageTargetInfo | null {
    return this.target_infos.get(target_id) ?? null;
  }

  pageTargetInfos(): PageTargetInfo[] {
    return [...this.target_infos.values()].filter((target) => target.type === "page");
  }

  unboundPageTargetInfos(baseline_target_ids: ReadonlySet<string>, opener_target_id: string | null): PageTargetInfo[] {
    return this.pageTargetInfos().filter((target) => {
      if (this.mod_target_pages.has(target.targetId)) return false;
      if (baseline_target_ids.has(target.targetId)) return false;
      if (opener_target_id) {
        if (target.openerId !== opener_target_id) return false;
        if (target.canAccessOpener === false) return false;
      }
      return true;
    });
  }

  upsertTargetInfo(value: unknown): PageTargetInfo | null {
    const parsed = PageTargetInfoSchema.safeParse(value);
    if (!parsed.success) return null;
    const target = parsed.data;
    const next = PageTargetInfoSchema.parse({ ...this.target_infos.get(target.targetId), ...target });
    this.target_infos.set(next.targetId, next);
    return next;
  }

  removeTarget(target_id: string) {
    this.target_infos.delete(target_id);
    const page_id = this.mod_target_pages.get(target_id);
    if (page_id) this.mod_page_targets.delete(page_id);
    this.mod_target_pages.delete(target_id);
    this.resumed_target_ids.delete(target_id);
  }

  takeResumeAttempt(target_id: string): boolean {
    if (this.resumed_target_ids.has(target_id)) return false;
    this.resumed_target_ids.add(target_id);
    return true;
  }
}
