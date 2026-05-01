import { z } from "zod";

import { commands, events } from "./zod.js";

const zodUnion = (schemas: z.ZodType[]) => z.union(schemas as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);
const isZodType = (value: unknown): value is z.ZodType =>
  value != null && typeof value === "object" && typeof (value as z.ZodType).parse === "function";

export const CdpCommandParamsSchema = z.lazy(() => zodUnion(Object.values(commands).map((command) => command.params)));
export type CdpCommandParams = z.infer<typeof CdpCommandParamsSchema>;

export const CdpCommandResultSchema = z.lazy(() => zodUnion(Object.values(commands).map((command) => command.result)));
export type CdpCommandResult = z.infer<typeof CdpCommandResultSchema>;

export const CdpEventParamsSchema = z.lazy(() => zodUnion(Object.values(events)));
export type CdpEventParams = z.infer<typeof CdpEventParamsSchema>;

export const RuntimeBindingCalledEventSchema = z.lazy(() => events["Runtime.bindingCalled"]);
export type RuntimeBindingCalledEvent = z.infer<typeof RuntimeBindingCalledEventSchema>;

export const TargetAttachedToTargetEventSchema = z.lazy(() => events["Target.attachedToTarget"]);
export type TargetAttachedToTargetEvent = z.infer<typeof TargetAttachedToTargetEventSchema>;

export const MagicRoutesSchema = z.object({}).catchall(z.string());
export type MagicRoutes = z.infer<typeof MagicRoutesSchema>;

export const MagicCustomPayloadSchema = z.object({}).passthrough();
export type MagicCustomPayload = z.infer<typeof MagicCustomPayloadSchema>;

export type MagicNamedValue = {
  id?: string;
  name?: string;
  meta?: () => { id?: unknown; name?: unknown } | undefined;
};

export function normalizeMagicName(value: MagicName) {
  if (typeof value === "string") return value;
  const meta = typeof value?.meta === "function" ? value.meta() : undefined;
  const name =
    value?.id ??
    (typeof meta?.id === "string" ? meta.id : undefined) ??
    (typeof meta?.name === "string" ? meta.name : undefined) ??
    value?.name;
  if (typeof name !== "string" || !name) throw new Error("Expected a CDP name string or a named CDP schema/alias.");
  return name;
}

export const MagicNameSchema = z.custom<string | MagicNamedValue>((value) => {
  try {
    normalizeMagicName(value as MagicName);
    return true;
  } catch {
    return false;
  }
});
export type MagicName = z.infer<typeof MagicNameSchema>;

export const MagicZodTypeSchema = z.custom<z.ZodType>(isZodType);
export type MagicZodType = z.infer<typeof MagicZodTypeSchema>;

export const MagicPayloadShapeSchema = z.record(z.string(), MagicZodTypeSchema);
export type MagicPayloadShape = z.infer<typeof MagicPayloadShapeSchema>;

export const MagicPayloadSchemaSpecSchema = z.union([MagicZodTypeSchema, MagicPayloadShapeSchema]);
export type MagicPayloadSchemaSpec = z.infer<typeof MagicPayloadSchemaSpecSchema>;

export function normalizeMagicPayloadSchema(schema: MagicPayloadSchemaSpec | null | undefined) {
  if (!schema) return null;
  return isZodType(schema) ? schema : z.object(schema).passthrough();
}

export const MagicEvaluateParamsSchema = z.object({
  expression: z.string(),
  params: MagicCustomPayloadSchema.optional(),
  cdpSessionId: z.string().nullable().optional(),
});
export type MagicEvaluateParams = z.infer<typeof MagicEvaluateParamsSchema>;

export const MagicAddCustomCommandParamsSchema = z.object({
  name: MagicNameSchema,
  expression: z.string(),
  paramsSchema: MagicPayloadSchemaSpecSchema.nullable().optional(),
  resultSchema: MagicPayloadSchemaSpecSchema.nullable().optional(),
});
export type MagicAddCustomCommandParams = z.infer<typeof MagicAddCustomCommandParamsSchema>;

export const MagicAddCustomEventObjectParamsSchema = z.object({
  name: MagicNameSchema,
  eventSchema: MagicPayloadSchemaSpecSchema.nullable().optional(),
});
export const MagicAddCustomEventParamsSchema = z.union([MagicZodTypeSchema, MagicAddCustomEventObjectParamsSchema]);
export type MagicAddCustomEventParams = z.infer<typeof MagicAddCustomEventParamsSchema>;

export const MagicAddMiddlewareParamsSchema = z.object({
  name: MagicNameSchema.optional(),
  phase: z.enum(["request", "response", "event"]),
  expression: z.string(),
});
export type MagicAddMiddlewareParams = z.infer<typeof MagicAddMiddlewareParamsSchema>;

export const MagicConfigureParamsSchema = z.object({
  loopback_cdp_url: z.string().nullable().optional(),
  routes: MagicRoutesSchema.optional(),
  browserToken: z.string().nullable().optional(),
});
export type MagicConfigureParams = z.infer<typeof MagicConfigureParamsSchema>;

export const MagicPingParamsSchema = z.object({
  sentAt: z.number().optional(),
});
export type MagicPingParams = z.infer<typeof MagicPingParamsSchema>;

export const MagicPongEventSchema = z.object({
  sentAt: z.number(),
  receivedAt: z.number(),
  from: z.string(),
});
export type MagicPongEvent = z.infer<typeof MagicPongEventSchema>;

export const MagicPingLatencySchema = z.object({
  sentAt: z.number(),
  receivedAt: z.number().nullable(),
  returnedAt: z.number(),
  roundTripMs: z.number(),
  serviceWorkerMs: z.number().nullable(),
  returnPathMs: z.number().nullable(),
});
export type MagicPingLatency = z.infer<typeof MagicPingLatencySchema>;

export const MagicCommandParamsSchema = z.union([
  MagicEvaluateParamsSchema,
  MagicAddCustomCommandParamsSchema,
  MagicAddCustomEventParamsSchema,
  MagicAddMiddlewareParamsSchema,
  MagicConfigureParamsSchema,
  MagicPingParamsSchema,
  MagicCustomPayloadSchema,
]);
export type MagicCommandParams = z.infer<typeof MagicCommandParamsSchema>;

export const MagicCommandResultSchema = z.union([
  MagicCustomPayloadSchema,
  z.object({ ok: z.boolean() }).passthrough(),
]);
export type MagicCommandResult = z.infer<typeof MagicCommandResultSchema>;

export const MagicEvaluateResponseSchema = z.unknown();
export type MagicEvaluateResponse = z.infer<typeof MagicEvaluateResponseSchema>;

export const MagicAddCustomCommandResponseSchema = z
  .object({
    name: z.string(),
    registered: z.boolean(),
  })
  .passthrough();
export type MagicAddCustomCommandResponse = z.infer<typeof MagicAddCustomCommandResponseSchema>;

export const MagicAddCustomEventResponseSchema = z
  .object({
    name: z.string(),
    bindingName: z.string(),
    registered: z.boolean(),
  })
  .passthrough();
export type MagicAddCustomEventResponse = z.infer<typeof MagicAddCustomEventResponseSchema>;

export const MagicAddMiddlewareResponseSchema = z
  .object({
    name: z.string(),
    phase: z.enum(["request", "response", "event"]),
    registered: z.boolean(),
  })
  .passthrough();
export type MagicAddMiddlewareResponse = z.infer<typeof MagicAddMiddlewareResponseSchema>;

export const MagicConfigureResponseSchema = z
  .object({
    loopback_cdp_url: z.string().nullable().optional(),
    routes: MagicRoutesSchema,
  })
  .passthrough();
export type MagicConfigureResponse = z.infer<typeof MagicConfigureResponseSchema>;

export const MagicPingResponseSchema = z
  .object({
    ok: z.boolean(),
  })
  .passthrough();
export type MagicPingResponse = z.infer<typeof MagicPingResponseSchema>;

export const MagicBindingPayloadSchema = z.object({
  event: z.string(),
  data: z.unknown(),
  cdpSessionId: z.string().nullable().optional(),
});
export type MagicBindingPayload = z.infer<typeof MagicBindingPayloadSchema>;

export const CdpDebuggeeCommandParamsSchema = MagicCustomPayloadSchema.extend({
  debuggee: z.custom<chrome.debugger.Debuggee>().nullable().optional(),
  tabId: z.number().nullable().optional(),
  targetId: z.string().nullable().optional(),
  extensionId: z.string().nullable().optional(),
});
export type CdpDebuggeeCommandParams = z.infer<typeof CdpDebuggeeCommandParamsSchema>;

export const ProtocolParamsSchema = z.union([CdpCommandParamsSchema, MagicCommandParamsSchema]);
export type ProtocolParams = z.infer<typeof ProtocolParamsSchema>;

export const ProtocolResultSchema = z.union([CdpCommandResultSchema, MagicCommandResultSchema]);
export type ProtocolResult = z.infer<typeof ProtocolResultSchema>;

export const ProtocolEventParamsSchema = z.union([
  CdpEventParamsSchema,
  MagicCustomPayloadSchema,
  MagicPongEventSchema,
]);
export type ProtocolEventParams = z.infer<typeof ProtocolEventParamsSchema>;

export const ProtocolPayloadSchema = z.union([
  ProtocolParamsSchema,
  ProtocolResultSchema,
  ProtocolEventParamsSchema,
  MagicBindingPayloadSchema,
  z.null(),
]);
export type ProtocolPayload = z.infer<typeof ProtocolPayloadSchema>;

export const MagicCustomCommandRegistrationSchema = MagicAddCustomCommandParamsSchema.extend({
  expression: z.string().nullable().optional(),
  handler:
    z.custom<(params: ProtocolParams, cdpSessionId: string | null) => ProtocolResult | Promise<ProtocolResult>>(),
});
export type MagicCustomCommandRegistration = z.infer<typeof MagicCustomCommandRegistrationSchema>;

export const MagicCustomEventRegistrationSchema = MagicAddCustomEventObjectParamsSchema.extend({
  bindingName: z.string(),
});
export type MagicCustomEventRegistration = z.infer<typeof MagicCustomEventRegistrationSchema>;

export const MagicMiddlewareRegistrationSchema = MagicAddMiddlewareParamsSchema.extend({
  handler:
    z.custom<
      (
        payload: ProtocolPayload,
        next: (payload?: ProtocolPayload) => Promise<ProtocolPayload>,
        context: MagicCustomPayload,
      ) => ProtocolPayload | Promise<ProtocolPayload>
    >(),
});
export type MagicMiddlewareRegistration = z.infer<typeof MagicMiddlewareRegistrationSchema>;

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
    result: z.lazy(() => z.union([ProtocolResultSchema, commands["Runtime.evaluate"].result])).optional(),
    error: CdpErrorSchema.optional(),
    sessionId: z.string().optional(),
  })
  .passthrough();
export type CdpResponseFrame = z.infer<typeof CdpResponseFrameSchema>;

export const CdpEventFrameSchema = z
  .object({
    method: z.string(),
    params: z
      .lazy(() =>
        z.union([ProtocolEventParamsSchema, events["Runtime.bindingCalled"], events["Target.attachedToTarget"]]),
      )
      .optional(),
    sessionId: z.string().optional(),
  })
  .passthrough();
export type CdpEventFrame = z.infer<typeof CdpEventFrameSchema>;

export const CdpFrameSchema = z.union([CdpCommandFrameSchema, CdpResponseFrameSchema, CdpEventFrameSchema]);
export type CdpFrame = z.infer<typeof CdpFrameSchema>;

export const TranslatedStepSchema = z
  .object({
    method: z.string(),
    params: z
      .lazy(() =>
        z.union([ProtocolParamsSchema, commands["Runtime.evaluate"].params, commands["Runtime.addBinding"].params]),
      )
      .optional(),
    unwrap: z.literal("evaluate").optional(),
  })
  .passthrough();
export type TranslatedStep = z.infer<typeof TranslatedStepSchema>;

export const TranslatedCommandSchema = z
  .object({
    route: z.string(),
    target: z.enum(["direct_cdp", "service_worker"]),
    steps: z.array(TranslatedStepSchema),
  })
  .passthrough();
export type TranslatedCommand = z.infer<typeof TranslatedCommandSchema>;

export const UnwrappedMagicEventSchema = z
  .object({
    event: z.string(),
    data: ProtocolPayloadSchema,
    sessionId: z.string().nullable(),
  })
  .passthrough();
export type UnwrappedMagicEvent = z.infer<typeof UnwrappedMagicEventSchema>;

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
  clientSessionIds: z.custom<Set<string>>(),
  bootstrapped: z.boolean(),
  queuedFromClient: z.array(z.custom<import("ws").RawData>()),
});
export type ProxyConnectionState = z.infer<typeof ProxyConnectionStateSchema>;

export const Magic = {
  Routes: MagicRoutesSchema,
  CustomPayload: MagicCustomPayloadSchema,
  Name: MagicNameSchema,
  ZodType: MagicZodTypeSchema,
  PayloadShape: MagicPayloadShapeSchema,
  PayloadSchemaSpec: MagicPayloadSchemaSpecSchema,
  EvaluateParams: MagicEvaluateParamsSchema,
  AddCustomCommandParams: MagicAddCustomCommandParamsSchema,
  AddCustomEventObjectParams: MagicAddCustomEventObjectParamsSchema,
  AddCustomEventParams: MagicAddCustomEventParamsSchema,
  AddMiddlewareParams: MagicAddMiddlewareParamsSchema,
  ConfigureParams: MagicConfigureParamsSchema,
  PingParams: MagicPingParamsSchema,
  PongEvent: MagicPongEventSchema,
  PingLatency: MagicPingLatencySchema,
  CommandParams: MagicCommandParamsSchema,
  CommandResult: MagicCommandResultSchema,
  EvaluateResponse: MagicEvaluateResponseSchema,
  AddCustomCommandResponse: MagicAddCustomCommandResponseSchema,
  AddCustomEventResponse: MagicAddCustomEventResponseSchema,
  AddMiddlewareResponse: MagicAddMiddlewareResponseSchema,
  ConfigureResponse: MagicConfigureResponseSchema,
  PingResponse: MagicPingResponseSchema,
  BindingPayload: MagicBindingPayloadSchema,
  CustomCommandRegistration: MagicCustomCommandRegistrationSchema,
  CustomEventRegistration: MagicCustomEventRegistrationSchema,
  MiddlewareRegistration: MagicMiddlewareRegistrationSchema,
} as const;
