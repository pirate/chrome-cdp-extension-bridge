import { z } from "zod";

export const ModIdSchema = z.string().min(1);
export type ModId = z.infer<typeof ModIdSchema>;

export const ModPageSchema = z
  .object({
    object: z.literal("mod.page"),
    id: ModIdSchema,
  })
  .strict();
export type ModPage = z.infer<typeof ModPageSchema>;

export const PageTargetInfoSchema = z
  .object({
    targetId: z.string(),
    type: z.string(),
    url: z.string().optional(),
    title: z.string().optional(),
    openerId: z.string().optional(),
    canAccessOpener: z.boolean().optional(),
  })
  .passthrough();
export type PageTargetInfo = z.infer<typeof PageTargetInfoSchema>;

export const ModSelectorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("xpath"),
      xpath: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("css"),
      selector: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("role"),
      role: z.string().min(1),
      name: z.string().optional(),
      exact: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal("text"),
      text: z.string().min(1),
      exact: z.boolean().default(true),
    })
    .strict(),
]);
export type ModSelector = z.infer<typeof ModSelectorSchema>;

export const ModFrameHopSchema = z
  .object({
    owner: ModSelectorSchema,
    assertNodeName: z.enum(["IFRAME", "FRAME"]).default("IFRAME"),
  })
  .strict();
export type ModFrameHop = z.infer<typeof ModFrameHopSchema>;

export const ModElementSchema = z
  .object({
    object: z.literal("mod.element"),
    id: ModIdSchema.optional(),
    page: ModPageSchema,
    frames: z.array(ModFrameHopSchema).default([]),
    selector: ModSelectorSchema,
    fingerprint: z
      .object({
        nodeName: z.string().optional(),
        text: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ModElement = z.infer<typeof ModElementSchema>;

export const ModOpenPageParamsSchema = z
  .object({
    id: ModIdSchema.optional(),
    url: z.string().url(),
  })
  .strict();
export type ModOpenPageParams = z.infer<typeof ModOpenPageParamsSchema>;
export const ModOpenPageResultSchema = z.object({ page: ModPageSchema }).strict();
export type ModOpenPageResult = z.infer<typeof ModOpenPageResultSchema>;

export const ModBindPageParamsSchema = z
  .object({
    page: ModPageSchema,
    targetId: ModIdSchema,
  })
  .strict();
export type ModBindPageParams = z.infer<typeof ModBindPageParamsSchema>;
export const ModBindPageResultSchema = z.object({ page: ModPageSchema }).strict();
export type ModBindPageResult = z.infer<typeof ModBindPageResultSchema>;

export const ModPageExpectationSchema = z
  .object({
    url: z.string().url().optional(),
    urlIncludes: z.string().min(1).optional(),
  })
  .strict();
export type ModPageExpectation = z.infer<typeof ModPageExpectationSchema>;

export const ModWaitForPageParamsSchema = z
  .object({
    id: ModIdSchema.optional(),
    opener: ModPageSchema.optional(),
    expected: ModPageExpectationSchema.optional(),
    timeoutMs: z.number().int().positive().default(10_000),
  })
  .strict();
export type ModWaitForPageParams = z.infer<typeof ModWaitForPageParamsSchema>;
export const ModWaitForPageResultSchema = z.object({ page: ModPageSchema }).strict();
export type ModWaitForPageResult = z.infer<typeof ModWaitForPageResultSchema>;

export const ModLoadStateSchema = z.enum(["load", "domcontentloaded", "networkidle"]);
export type ModLoadState = z.infer<typeof ModLoadStateSchema>;

export const ModWaitForSelectorStateSchema = z.enum(["attached", "detached", "visible", "hidden"]);
export type ModWaitForSelectorState = z.infer<typeof ModWaitForSelectorStateSchema>;

export const ModNavigationResultSchema = z
  .object({
    page: ModPageSchema,
    url: z.string(),
    response: z.null(),
  })
  .strict();
export type ModNavigationResult = z.infer<typeof ModNavigationResultSchema>;

export const ModPageGotoParamsSchema = z
  .object({
    page: ModPageSchema,
    url: z.string().url(),
    waitUntil: ModLoadStateSchema.optional(),
    timeoutMs: z.number().int().nonnegative().default(30_000),
  })
  .strict();
export type ModPageGotoParams = z.infer<typeof ModPageGotoParamsSchema>;
export const ModPageGotoResultSchema = ModNavigationResultSchema;
export type ModPageGotoResult = z.infer<typeof ModPageGotoResultSchema>;

export const ModPageReloadParamsSchema = z
  .object({
    page: ModPageSchema,
    waitUntil: ModLoadStateSchema.optional(),
    timeoutMs: z.number().int().nonnegative().default(30_000),
    ignoreCache: z.boolean().optional(),
  })
  .strict();
export type ModPageReloadParams = z.infer<typeof ModPageReloadParamsSchema>;
export const ModPageReloadResultSchema = ModNavigationResultSchema;
export type ModPageReloadResult = z.infer<typeof ModPageReloadResultSchema>;

export const ModPageGoBackParamsSchema = z
  .object({
    page: ModPageSchema,
    waitUntil: ModLoadStateSchema.optional(),
    timeoutMs: z.number().int().nonnegative().default(30_000),
  })
  .strict();
export type ModPageGoBackParams = z.infer<typeof ModPageGoBackParamsSchema>;
export const ModPageGoBackResultSchema = ModNavigationResultSchema;
export type ModPageGoBackResult = z.infer<typeof ModPageGoBackResultSchema>;

export const ModPageGoForwardParamsSchema = ModPageGoBackParamsSchema;
export type ModPageGoForwardParams = z.infer<typeof ModPageGoForwardParamsSchema>;
export const ModPageGoForwardResultSchema = ModNavigationResultSchema;
export type ModPageGoForwardResult = z.infer<typeof ModPageGoForwardResultSchema>;

export const ModPageWaitForLoadStateParamsSchema = z
  .object({
    page: ModPageSchema,
    state: ModLoadStateSchema,
    timeoutMs: z.number().int().nonnegative().default(30_000),
  })
  .strict();
export type ModPageWaitForLoadStateParams = z.infer<typeof ModPageWaitForLoadStateParamsSchema>;
export const ModPageWaitForLoadStateResultSchema = z
  .object({
    page: ModPageSchema,
    state: ModLoadStateSchema,
  })
  .strict();
export type ModPageWaitForLoadStateResult = z.infer<typeof ModPageWaitForLoadStateResultSchema>;

export const ModPageWaitForTimeoutParamsSchema = z
  .object({
    page: ModPageSchema,
    ms: z.number().int().nonnegative(),
  })
  .strict();
export type ModPageWaitForTimeoutParams = z.infer<typeof ModPageWaitForTimeoutParamsSchema>;
export const ModPageWaitForTimeoutResultSchema = z
  .object({
    page: ModPageSchema,
    ms: z.number().int().nonnegative(),
  })
  .strict();
export type ModPageWaitForTimeoutResult = z.infer<typeof ModPageWaitForTimeoutResultSchema>;

export const ModScreenshotTypeSchema = z.enum(["png", "jpeg", "webp"]);
export type ModScreenshotType = z.infer<typeof ModScreenshotTypeSchema>;

export const ModPageClipSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
    scale: z.number().positive().optional(),
  })
  .strict();
export type ModPageClip = z.infer<typeof ModPageClipSchema>;

export const ModPageScreenshotParamsSchema = z
  .object({
    page: ModPageSchema,
    fullPage: z.boolean().optional(),
    clip: ModPageClipSchema.optional(),
    type: ModScreenshotTypeSchema.default("png"),
    quality: z.number().int().min(0).max(100).optional(),
    timeoutMs: z.number().int().nonnegative().default(30_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.quality !== undefined && value.type !== "jpeg" && value.type !== "webp") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quality"],
        message: "quality is only supported when type is 'jpeg' or 'webp'",
      });
    }
    if (value.clip && value.fullPage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clip"],
        message: "clip cannot be used together with fullPage",
      });
    }
  });
export type ModPageScreenshotParams = z.infer<typeof ModPageScreenshotParamsSchema>;
export const ModPageScreenshotResultSchema = z
  .object({
    page: ModPageSchema,
    base64: z.string(),
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  })
  .strict();
export type ModPageScreenshotResult = z.infer<typeof ModPageScreenshotResultSchema>;

export const ModPageEvaluateParamsSchema = z
  .object({
    page: ModPageSchema,
    frames: z.array(ModFrameHopSchema).default([]),
    expression: z.string().min(1),
    arg: z.unknown().optional(),
    awaitPromise: z.boolean().default(true),
    timeoutMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type ModPageEvaluateParams = z.infer<typeof ModPageEvaluateParamsSchema>;
export const ModPageEvaluateResultSchema = z.object({ value: z.unknown().optional() }).strict();
export type ModPageEvaluateResult = z.infer<typeof ModPageEvaluateResultSchema>;

export const ModPageWaitForSelectorParamsSchema = z
  .object({
    id: ModIdSchema.optional(),
    page: ModPageSchema,
    frames: z.array(ModFrameHopSchema).default([]),
    selector: ModSelectorSchema,
    state: ModWaitForSelectorStateSchema.default("visible"),
    timeoutMs: z.number().int().nonnegative().default(30_000),
  })
  .strict();
export type ModPageWaitForSelectorParams = z.infer<typeof ModPageWaitForSelectorParamsSchema>;
export const ModPageWaitForSelectorResultSchema = z
  .object({
    page: ModPageSchema,
    matched: z.literal(true),
    element: ModElementSchema.optional(),
  })
  .strict();
export type ModPageWaitForSelectorResult = z.infer<typeof ModPageWaitForSelectorResultSchema>;

export const ModQueryElementParamsSchema = z
  .object({
    id: ModIdSchema.optional(),
    page: ModPageSchema,
    frames: z.array(ModFrameHopSchema).default([]),
    selector: ModSelectorSchema,
  })
  .strict();
export type ModQueryElementParams = z.infer<typeof ModQueryElementParamsSchema>;
export const ModQueryElementResultSchema = z.object({ element: ModElementSchema }).strict();
export type ModQueryElementResult = z.infer<typeof ModQueryElementResultSchema>;

export const ModSelectorTargetParamsSchema = z
  .object({
    page: ModPageSchema,
    frames: z.array(ModFrameHopSchema).default([]),
    selector: ModSelectorSchema,
  })
  .strict();
export type ModSelectorTargetParams = z.infer<typeof ModSelectorTargetParamsSchema>;

export const ModResolveContextParamsSchema = z
  .object({
    page: ModPageSchema,
    frames: z.array(ModFrameHopSchema).default([]),
  })
  .strict();
export type ModResolveContextParams = z.infer<typeof ModResolveContextParamsSchema>;
export const ModResolveContextResultSchema = z
  .object({
    found: z.literal(true),
    page: ModPageSchema,
    pageUrl: z.string(),
    frameDepth: z.number().int().nonnegative(),
  })
  .strict();
export type ModResolveContextResult = z.infer<typeof ModResolveContextResultSchema>;

export const ModTextParamsSchema = ModSelectorTargetParamsSchema;
export type ModTextParams = z.infer<typeof ModTextParamsSchema>;
export const ModTextResultSchema = z
  .object({
    text: z.string(),
    element: ModElementSchema,
  })
  .strict();
export type ModTextResult = z.infer<typeof ModTextResultSchema>;

export const ModClickParamsSchema = ModSelectorTargetParamsSchema;
export type ModClickParams = z.infer<typeof ModClickParamsSchema>;
export const ModClickResultSchema = z
  .object({
    clicked: z.literal(true),
    element: ModElementSchema,
  })
  .strict();
export type ModClickResult = z.infer<typeof ModClickResultSchema>;

export const ModTypeParamsSchema = ModSelectorTargetParamsSchema.extend({
  text: z.string(),
});
export type ModTypeParams = z.infer<typeof ModTypeParamsSchema>;
export const ModTypeResultSchema = z
  .object({
    typed: z.literal(true),
    element: ModElementSchema,
  })
  .strict();
export type ModTypeResult = z.infer<typeof ModTypeResultSchema>;

export const ModElementTextParamsSchema = z.object({ element: ModElementSchema }).strict();
export type ModElementTextParams = z.infer<typeof ModElementTextParamsSchema>;
export const ModElementTextResultSchema = z
  .object({
    text: z.string(),
    element: ModElementSchema,
  })
  .strict();
export type ModElementTextResult = z.infer<typeof ModElementTextResultSchema>;

export const ModClickElementParamsSchema = z.object({ element: ModElementSchema }).strict();
export type ModClickElementParams = z.infer<typeof ModClickElementParamsSchema>;
export const ModClickElementResultSchema = z
  .object({
    clicked: z.literal(true),
    element: ModElementSchema,
  })
  .strict();
export type ModClickElementResult = z.infer<typeof ModClickElementResultSchema>;

export const ModTypeElementParamsSchema = z
  .object({
    element: ModElementSchema,
    text: z.string(),
  })
  .strict();
export type ModTypeElementParams = z.infer<typeof ModTypeElementParamsSchema>;
export const ModTypeElementResultSchema = z
  .object({
    typed: z.literal(true),
    element: ModElementSchema,
  })
  .strict();
export type ModTypeElementResult = z.infer<typeof ModTypeElementResultSchema>;

export const ModHoverParamsSchema = ModSelectorTargetParamsSchema;
export type ModHoverParams = z.infer<typeof ModHoverParamsSchema>;
export const ModHoverResultSchema = z
  .object({
    hovered: z.literal(true),
    element: ModElementSchema,
  })
  .strict();
export type ModHoverResult = z.infer<typeof ModHoverResultSchema>;

export const ModHoverElementParamsSchema = z.object({ element: ModElementSchema }).strict();
export type ModHoverElementParams = z.infer<typeof ModHoverElementParamsSchema>;
export const ModHoverElementResultSchema = ModHoverResultSchema;
export type ModHoverElementResult = z.infer<typeof ModHoverElementResultSchema>;

export const ModFillParamsSchema = ModSelectorTargetParamsSchema.extend({
  value: z.string(),
});
export type ModFillParams = z.infer<typeof ModFillParamsSchema>;
export const ModFillResultSchema = z
  .object({
    filled: z.literal(true),
    value: z.string(),
    element: ModElementSchema,
  })
  .strict();
export type ModFillResult = z.infer<typeof ModFillResultSchema>;

export const ModFillElementParamsSchema = z
  .object({
    element: ModElementSchema,
    value: z.string(),
  })
  .strict();
export type ModFillElementParams = z.infer<typeof ModFillElementParamsSchema>;
export const ModFillElementResultSchema = ModFillResultSchema;
export type ModFillElementResult = z.infer<typeof ModFillElementResultSchema>;

export const ModPressParamsSchema = ModResolveContextParamsSchema.extend({
  key: z.string().min(1),
});
export type ModPressParams = z.infer<typeof ModPressParamsSchema>;
export const ModPressResultSchema = z
  .object({
    pressed: z.literal(true),
    key: z.string(),
  })
  .strict();
export type ModPressResult = z.infer<typeof ModPressResultSchema>;

export const ModPressElementParamsSchema = z
  .object({
    element: ModElementSchema,
    key: z.string().min(1),
  })
  .strict();
export type ModPressElementParams = z.infer<typeof ModPressElementParamsSchema>;
export const ModPressElementResultSchema = ModPressResultSchema;
export type ModPressElementResult = z.infer<typeof ModPressElementResultSchema>;

export const ModScrollParamsSchema = ModResolveContextParamsSchema.extend({
  selector: ModSelectorSchema.optional(),
  deltaX: z.number().default(0),
  deltaY: z.number(),
});
export type ModScrollParams = z.infer<typeof ModScrollParamsSchema>;
export const ModScrollResultSchema = z
  .object({
    scrolled: z.literal(true),
    page: ModPageSchema,
    element: ModElementSchema.optional(),
  })
  .strict();
export type ModScrollResult = z.infer<typeof ModScrollResultSchema>;

export const ModScrollElementParamsSchema = z
  .object({
    element: ModElementSchema,
    deltaX: z.number().default(0),
    deltaY: z.number(),
  })
  .strict();
export type ModScrollElementParams = z.infer<typeof ModScrollElementParamsSchema>;
export const ModScrollElementResultSchema = ModScrollResultSchema;
export type ModScrollElementResult = z.infer<typeof ModScrollElementResultSchema>;
