/// <reference types="chrome" />

import { z } from "zod";

import {
  ModBindPageParamsSchema,
  ModBindPageResultSchema,
  ModClickElementParamsSchema,
  ModClickElementResultSchema,
  ModClickParamsSchema,
  ModClickResultSchema,
  ModElementTextParamsSchema,
  ModElementTextResultSchema,
  ModOpenPageParamsSchema,
  ModOpenPageResultSchema,
  ModQueryElementParamsSchema,
  ModQueryElementResultSchema,
  ModResolveContextParamsSchema,
  ModResolveContextResultSchema,
  ModTextParamsSchema,
  ModTextResultSchema,
  ModTypeElementParamsSchema,
  ModTypeElementResultSchema,
  ModTypeParamsSchema,
  ModTypeResultSchema,
  ModWaitForPageParamsSchema,
  ModWaitForPageResultSchema,
} from "./replayable.js";

const isZodType = (value: unknown): value is z.ZodType =>
  value != null && typeof value === "object" && typeof (value as z.ZodType).parse === "function";

export const CdpCommandParamsSchema = z.object({}).passthrough();
export type CdpCommandParams = z.infer<typeof CdpCommandParamsSchema>;

export const CdpCommandResultSchema = z.object({}).passthrough();
export type CdpCommandResult = z.infer<typeof CdpCommandResultSchema>;

export const CdpEventParamsSchema = z.object({}).passthrough();
export type CdpEventParams = z.infer<typeof CdpEventParamsSchema>;

export const RuntimeBindingCalledEventSchema = z
  .object({
    name: z.string(),
    payload: z.string(),
    executionContextId: z.number().optional(),
  })
  .passthrough();
export type RuntimeBindingCalledEvent = z.infer<typeof RuntimeBindingCalledEventSchema>;

export const TargetAttachedToTargetEventSchema = z
  .object({
    sessionId: z.string(),
    targetInfo: z.object({ targetId: z.string() }).passthrough(),
    waitingForDebugger: z.boolean(),
  })
  .passthrough();
export type TargetAttachedToTargetEvent = z.infer<typeof TargetAttachedToTargetEventSchema>;

export const CDPModRoutesSchema = z.object({}).catchall(z.string());
export type CDPModRoutes = z.infer<typeof CDPModRoutesSchema>;

export const CDPModCustomPayloadSchema = z.object({}).passthrough();
export type CDPModCustomPayload = z.infer<typeof CDPModCustomPayloadSchema>;

export type CDPModNamedValue = {
  cdp_command_name?: string;
  cdp_event_name?: string;
  id?: string;
  name?: string;
  meta?: () => { cdp_command_name?: unknown; cdp_event_name?: unknown; id?: unknown; name?: unknown } | undefined;
};

export function normalizeCDPModName(value: CDPModName) {
  if (typeof value === "string") return value;
  const meta = typeof value?.meta === "function" ? value.meta() : undefined;
  const name =
    value?.cdp_command_name ??
    value?.cdp_event_name ??
    (typeof meta?.cdp_command_name === "string" ? meta.cdp_command_name : undefined) ??
    (typeof meta?.cdp_event_name === "string" ? meta.cdp_event_name : undefined) ??
    value?.id ??
    (typeof meta?.id === "string" ? meta.id : undefined) ??
    (typeof meta?.name === "string" ? meta.name : undefined) ??
    value?.name;
  if (typeof name !== "string" || !name) throw new Error("Expected a CDP name string or named CDP schema.");
  return name;
}

export const CDPModNameSchema = z.custom<string | CDPModNamedValue>((value) => {
  try {
    normalizeCDPModName(value as CDPModName);
    return true;
  } catch {
    return false;
  }
});
export type CDPModName = z.infer<typeof CDPModNameSchema>;

export const CDPModZodTypeSchema = z.custom<z.ZodType>(isZodType);
export type CDPModZodType = z.infer<typeof CDPModZodTypeSchema>;

export const CDPModPayloadJsonSchemaSchema = z.record(z.string(), z.unknown());
export const CDPModPayloadShapeSchema = z.record(z.string(), CDPModZodTypeSchema);
export type CDPModPayloadShape = z.infer<typeof CDPModPayloadShapeSchema>;

export const CDPModPayloadSchemaSpecSchema = z.union([
  CDPModZodTypeSchema,
  CDPModPayloadShapeSchema,
  CDPModPayloadJsonSchemaSchema,
]);
export type CDPModPayloadSchemaSpec = z.infer<typeof CDPModPayloadSchemaSpecSchema>;

export function normalizeCDPModPayloadSchema(schema: CDPModPayloadSchemaSpec | null | undefined) {
  if (!schema) return null;
  if (isZodType(schema)) return schema;
  if (Object.values(schema).every(isZodType)) return z.object(schema as CDPModPayloadShape).passthrough();
  if (schema.type === "object") return z.object({}).passthrough();
  throw new Error("Unsupported payload schema; pass a Zod schema, Zod shape, or object JSON schema.");
}

export const CDPModEvaluateParamsSchema = z.object({
  expression: z.string(),
  params: CDPModCustomPayloadSchema.optional(),
  cdpSessionId: z.string().nullable().optional(),
});
export type CDPModEvaluateParams = z.infer<typeof CDPModEvaluateParamsSchema>;

export const CDPModAddCustomCommandParamsSchema = z.object({
  name: CDPModNameSchema,
  expression: z.string(),
  paramsSchema: CDPModPayloadSchemaSpecSchema.nullable().optional(),
  resultSchema: CDPModPayloadSchemaSpecSchema.nullable().optional(),
});
export type CDPModAddCustomCommandParams = z.infer<typeof CDPModAddCustomCommandParamsSchema>;

export const CDPModAddCustomEventObjectParamsSchema = z.object({
  name: CDPModNameSchema,
  eventSchema: CDPModPayloadSchemaSpecSchema.nullable().optional(),
});
export type CDPModAddCustomEventObjectParams = z.infer<typeof CDPModAddCustomEventObjectParamsSchema>;
export const CDPModAddCustomEventParamsSchema = z.union([CDPModZodTypeSchema, CDPModAddCustomEventObjectParamsSchema]);
export type CDPModAddCustomEventParams = z.infer<typeof CDPModAddCustomEventParamsSchema>;

export const CDPModAddMiddlewareParamsSchema = z.object({
  name: CDPModNameSchema.optional(),
  phase: z.enum(["request", "response", "event"]),
  expression: z.string(),
});
export type CDPModAddMiddlewareParams = z.infer<typeof CDPModAddMiddlewareParamsSchema>;

export const CDPModConfigureParamsSchema = z.object({
  loopback_cdp_url: z.string().nullable().optional(),
  routes: CDPModRoutesSchema.optional(),
  browserToken: z.string().nullable().optional(),
  custom_commands: z.array(CDPModAddCustomCommandParamsSchema).optional(),
  custom_events: z.array(CDPModAddCustomEventObjectParamsSchema).optional(),
  custom_middlewares: z.array(CDPModAddMiddlewareParamsSchema).optional(),
});
export type CDPModConfigureParams = z.infer<typeof CDPModConfigureParamsSchema>;

export const CDPModPingParamsSchema = z.object({
  sentAt: z.number().optional(),
});
export type CDPModPingParams = z.infer<typeof CDPModPingParamsSchema>;

export const CDPModPongEventSchema = z.object({
  sentAt: z.number(),
  receivedAt: z.number(),
  from: z.string(),
});
export type CDPModPongEvent = z.infer<typeof CDPModPongEventSchema>;

export const CDPModPingLatencySchema = z.object({
  sentAt: z.number(),
  receivedAt: z.number().nullable(),
  returnedAt: z.number(),
  roundTripMs: z.number(),
  serviceWorkerMs: z.number().nullable(),
  returnPathMs: z.number().nullable(),
});
export type CDPModPingLatency = z.infer<typeof CDPModPingLatencySchema>;

export const CDPModCommandParamsSchema = z.union([
  CDPModEvaluateParamsSchema,
  CDPModAddCustomCommandParamsSchema,
  CDPModAddCustomEventParamsSchema,
  CDPModAddMiddlewareParamsSchema,
  CDPModConfigureParamsSchema,
  CDPModPingParamsSchema,
  ModOpenPageParamsSchema,
  ModBindPageParamsSchema,
  ModWaitForPageParamsSchema,
  ModQueryElementParamsSchema,
  ModResolveContextParamsSchema,
  ModTextParamsSchema,
  ModClickParamsSchema,
  ModTypeParamsSchema,
  ModElementTextParamsSchema,
  ModClickElementParamsSchema,
  ModTypeElementParamsSchema,
  CDPModCustomPayloadSchema,
]);
export type CDPModCommandParams = z.infer<typeof CDPModCommandParamsSchema>;

export const CDPModCommandResultSchema = z.union([
  z.object({ ok: z.boolean() }).passthrough(),
  ModOpenPageResultSchema,
  ModBindPageResultSchema,
  ModWaitForPageResultSchema,
  ModQueryElementResultSchema,
  ModResolveContextResultSchema,
  ModTextResultSchema,
  ModClickResultSchema,
  ModTypeResultSchema,
  ModElementTextResultSchema,
  ModClickElementResultSchema,
  ModTypeElementResultSchema,
  CDPModCustomPayloadSchema,
]);
export type CDPModCommandResult = z.infer<typeof CDPModCommandResultSchema>;

export const CDPModEvaluateResponseSchema = z.unknown();
export type CDPModEvaluateResponse = z.infer<typeof CDPModEvaluateResponseSchema>;

export const CDPModAddCustomCommandResponseSchema = z
  .object({
    name: z.string(),
    registered: z.boolean(),
  })
  .passthrough();
export type CDPModAddCustomCommandResponse = z.infer<typeof CDPModAddCustomCommandResponseSchema>;

export const CDPModAddCustomEventResponseSchema = z
  .object({
    name: z.string(),
    bindingName: z.string(),
    registered: z.boolean(),
  })
  .passthrough();
export type CDPModAddCustomEventResponse = z.infer<typeof CDPModAddCustomEventResponseSchema>;

export const CDPModAddMiddlewareResponseSchema = z
  .object({
    name: z.string(),
    phase: z.enum(["request", "response", "event"]),
    registered: z.boolean(),
  })
  .passthrough();
export type CDPModAddMiddlewareResponse = z.infer<typeof CDPModAddMiddlewareResponseSchema>;

export const CDPModConfigureResponseSchema = z
  .object({
    loopback_cdp_url: z.string().nullable().optional(),
    routes: CDPModRoutesSchema,
  })
  .passthrough();
export type CDPModConfigureResponse = z.infer<typeof CDPModConfigureResponseSchema>;

export const CDPModPingResponseSchema = z
  .object({
    ok: z.boolean(),
  })
  .passthrough();
export type CDPModPingResponse = z.infer<typeof CDPModPingResponseSchema>;

export const CDPModBindingPayloadSchema = z.object({
  event: z.string(),
  data: z.unknown(),
  cdpSessionId: z.string().nullable().optional(),
});
export type CDPModBindingPayload = z.infer<typeof CDPModBindingPayloadSchema>;

export const CdpDebuggeeCommandParamsSchema = CDPModCustomPayloadSchema.extend({
  debuggee: z.custom<chrome.debugger.Debuggee>().nullable().optional(),
  tabId: z.number().nullable().optional(),
  targetId: z.string().nullable().optional(),
  extensionId: z.string().nullable().optional(),
});
export type CdpDebuggeeCommandParams = z.infer<typeof CdpDebuggeeCommandParamsSchema>;

export const ProtocolParamsSchema = z.union([CdpCommandParamsSchema, CDPModCommandParamsSchema]);
export type ProtocolParams = z.infer<typeof ProtocolParamsSchema>;

export const ProtocolResultSchema = z.union([CdpCommandResultSchema, CDPModCommandResultSchema]);
export type ProtocolResult = z.infer<typeof ProtocolResultSchema>;

export const ProtocolEventParamsSchema = z.union([
  CdpEventParamsSchema,
  CDPModPongEventSchema,
  CDPModCustomPayloadSchema,
]);
export type ProtocolEventParams = z.infer<typeof ProtocolEventParamsSchema>;

export const ProtocolPayloadSchema = z.union([
  ProtocolParamsSchema,
  ProtocolResultSchema,
  ProtocolEventParamsSchema,
  CDPModBindingPayloadSchema,
  z.null(),
]);
export type ProtocolPayload = z.infer<typeof ProtocolPayloadSchema>;

export const CDPModCustomCommandRegistrationSchema = CDPModAddCustomCommandParamsSchema.extend({
  expression: z.string().nullable().optional(),
  handler:
    z.custom<
      (params: ProtocolParams, cdpSessionId: string | null, method?: string) => ProtocolResult | Promise<ProtocolResult>
    >(),
});
export type CDPModCustomCommandRegistration = z.infer<typeof CDPModCustomCommandRegistrationSchema>;

export const CDPModCustomEventRegistrationSchema = CDPModAddCustomEventObjectParamsSchema.extend({
  bindingName: z.string(),
});
export type CDPModCustomEventRegistration = z.infer<typeof CDPModCustomEventRegistrationSchema>;

export const CDPModMiddlewareRegistrationSchema = CDPModAddMiddlewareParamsSchema.extend({
  expression: z.string().nullable().optional(),
  handler:
    z.custom<
      (
        payload: ProtocolPayload,
        next: (payload?: ProtocolPayload) => Promise<ProtocolPayload>,
        context: CDPModCustomPayload,
      ) => ProtocolPayload | Promise<ProtocolPayload>
    >(),
});
export type CDPModMiddlewareRegistration = z.infer<typeof CDPModMiddlewareRegistrationSchema>;

export const CdpErrorSchema = z
  .object({
    code: z.number().optional(),
    message: z.string(),
    data: z.unknown().optional(),
  })
  .passthrough();
export type CdpError = z.infer<typeof CdpErrorSchema>;

export const CdpCommandFrameSchema = z
  .object({
    id: z.number(),
    method: z.string(),
    params: ProtocolParamsSchema.optional(),
    sessionId: z.string().optional(),
  })
  .passthrough();
export type CdpCommandFrame = z.infer<typeof CdpCommandFrameSchema>;

export const CdpResponseFrameSchema = z
  .object({
    id: z.number(),
    result: ProtocolResultSchema.optional(),
    error: CdpErrorSchema.optional(),
    sessionId: z.string().optional(),
  })
  .passthrough();
export type CdpResponseFrame = z.infer<typeof CdpResponseFrameSchema>;

export const CdpEventFrameSchema = z
  .object({
    method: z.string(),
    params: ProtocolEventParamsSchema.optional(),
    sessionId: z.string().optional(),
  })
  .passthrough();
export type CdpEventFrame = z.infer<typeof CdpEventFrameSchema>;

export const CdpFrameSchema = z.union([CdpCommandFrameSchema, CdpResponseFrameSchema, CdpEventFrameSchema]);
export type CdpFrame = z.infer<typeof CdpFrameSchema>;

export const TranslatedStepSchema = z
  .object({
    method: z.string(),
    params: ProtocolParamsSchema.optional(),
    unwrap: z.literal("evaluate").optional(),
  })
  .passthrough();
export type TranslatedStep = z.infer<typeof TranslatedStepSchema>;

export const TranslatedCommandSchema = z
  .object({
    route: z.string(),
    target: z.enum(["direct_cdp", "service_worker", "self"]),
    steps: z.array(TranslatedStepSchema),
  })
  .passthrough();
export type TranslatedCommand = z.infer<typeof TranslatedCommandSchema>;

export const UnwrappedCDPModEventSchema = z
  .object({
    event: z.string(),
    data: ProtocolPayloadSchema,
    sessionId: z.string().nullable(),
  })
  .passthrough();
export type UnwrappedCDPModEvent = z.infer<typeof UnwrappedCDPModEventSchema>;

export const ProxyPendingSchema = z
  .object({
    kind: z.string(),
    clientId: z.number().optional(),
    clientSessionId: z.string().nullable().optional(),
    eventName: z.string().optional(),
    resolve: z.custom<(value: ProtocolResult) => void>().optional(),
    reject: z.custom<(error: Error) => void>().optional(),
  })
  .passthrough();
export type ProxyPending = z.infer<typeof ProxyPendingSchema>;

export const ProxyUpstreamStateSchema = z
  .object({
    url: z.string(),
    launched: z.custom<Awaited<ReturnType<typeof import("../bridge/launcher.js").launchChrome>>>().nullable(),
    launchPromise: z
      .promise(z.custom<Awaited<ReturnType<typeof import("../bridge/launcher.js").launchChrome>>>())
      .nullable()
      .optional(),
  })
  .passthrough();
export type ProxyUpstreamState = z.infer<typeof ProxyUpstreamStateSchema>;

export const ProxyConnectionStateSchema = z.object({
  client: z.custom<import("ws").WebSocket>(),
  upstream: z.custom<import("ws").WebSocket>(),
  nextUpstreamId: z.number(),
  pending: z.custom<Map<number, ProxyPending>>(),
  extSessionId: z.string().nullable(),
  extTargetId: z.string().nullable(),
  hiddenSessionIds: z.custom<Set<string>>(),
  hiddenTargetIds: z.custom<Set<string>>(),
  targetSessionIds: z.custom<Map<string, string>>(),
  clientSessionIds: z.custom<Set<string>>(),
  bootstrapped: z.boolean(),
  queuedFromClient: z.array(z.custom<import("ws").RawData>()),
});
export type ProxyConnectionState = z.infer<typeof ProxyConnectionStateSchema>;

export const Mod = {
  Routes: CDPModRoutesSchema,
  CustomPayload: CDPModCustomPayloadSchema,
  Name: CDPModNameSchema,
  ZodType: CDPModZodTypeSchema,
  PayloadShape: CDPModPayloadShapeSchema,
  PayloadSchemaSpec: CDPModPayloadSchemaSpecSchema,
  EvaluateParams: CDPModEvaluateParamsSchema,
  AddCustomCommandParams: CDPModAddCustomCommandParamsSchema,
  AddCustomEventObjectParams: CDPModAddCustomEventObjectParamsSchema,
  AddCustomEventParams: CDPModAddCustomEventParamsSchema,
  AddMiddlewareParams: CDPModAddMiddlewareParamsSchema,
  ConfigureParams: CDPModConfigureParamsSchema,
  PingParams: CDPModPingParamsSchema,
  PageOpenParams: ModOpenPageParamsSchema,
  PageBindParams: ModBindPageParamsSchema,
  PageWaitForParams: ModWaitForPageParamsSchema,
  DOMQueryElementParams: ModQueryElementParamsSchema,
  DOMResolveContextParams: ModResolveContextParamsSchema,
  DOMTextParams: ModTextParamsSchema,
  InputClickParams: ModClickParamsSchema,
  InputTypeParams: ModTypeParamsSchema,
  DOMElementTextParams: ModElementTextParamsSchema,
  InputClickElementParams: ModClickElementParamsSchema,
  InputTypeElementParams: ModTypeElementParamsSchema,
  PongEvent: CDPModPongEventSchema,
  PingLatency: CDPModPingLatencySchema,
  CommandParams: CDPModCommandParamsSchema,
  CommandResult: CDPModCommandResultSchema,
  EvaluateResponse: CDPModEvaluateResponseSchema,
  AddCustomCommandResponse: CDPModAddCustomCommandResponseSchema,
  AddCustomEventResponse: CDPModAddCustomEventResponseSchema,
  AddMiddlewareResponse: CDPModAddMiddlewareResponseSchema,
  ConfigureResponse: CDPModConfigureResponseSchema,
  PingResponse: CDPModPingResponseSchema,
  PageOpenResponse: ModOpenPageResultSchema,
  PageBindResponse: ModBindPageResultSchema,
  PageWaitForResponse: ModWaitForPageResultSchema,
  DOMQueryElementResponse: ModQueryElementResultSchema,
  DOMResolveContextResponse: ModResolveContextResultSchema,
  DOMTextResponse: ModTextResultSchema,
  InputClickResponse: ModClickResultSchema,
  InputTypeResponse: ModTypeResultSchema,
  DOMElementTextResponse: ModElementTextResultSchema,
  InputClickElementResponse: ModClickElementResultSchema,
  InputTypeElementResponse: ModTypeElementResultSchema,
  BindingPayload: CDPModBindingPayloadSchema,
  CustomCommandRegistration: CDPModCustomCommandRegistrationSchema,
  CustomEventRegistration: CDPModCustomEventRegistrationSchema,
  MiddlewareRegistration: CDPModMiddlewareRegistrationSchema,
} as const;
