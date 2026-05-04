import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

import { normalizeCDPModsPayloadSchema } from "../types/cdpmods.js";

test("payload schema normalization accepts empty zod shapes", () => {
  const schema = normalizeCDPModsPayloadSchema({});
  assert.deepEqual(schema?.parse({ value: 1 }), { value: 1 });
});

test("payload schema normalization rejects unsupported schema specs", () => {
  assert.throws(
    () => normalizeCDPModsPayloadSchema({ type: "string" }),
    /Unsupported payload schema/,
  );
});

test("payload schema normalization accepts non-empty zod shapes", () => {
  const schema = normalizeCDPModsPayloadSchema({ value: z.string() });
  assert.deepEqual(schema?.parse({ value: "ok", extra: true }), { value: "ok", extra: true });
});
