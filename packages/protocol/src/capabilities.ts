import type { CapabilityDegradation, JsonSchema, ModelManifest, ModelRequest, StreamEvent, StructuredResult } from './models.ts';

/**
 * Capability planning (architecture §7.2 "Do not assume uniformity"): the manifest is the single source
 * of truth. Every unsupported feature in a request is degraded explicitly and reported, never dropped silently.
 */
export interface CapabilityPlan {
  /** Request to put on the wire. */
  request: ModelRequest;
  degradations: CapabilityDegradation[];
  /** Schema the final text is validated against (native or instruction fallback). */
  validateSchema?: JsonSchema;
}

export function planCapabilities(req: ModelRequest, manifest: ModelManifest | undefined): CapabilityPlan {
  const request: ModelRequest = { ...req };
  const degradations: CapabilityDegradation[] = [];
  const validateSchema = req.responseFormat?.schema;
  if (!manifest) return { request, degradations, validateSchema };

  if (request.tools?.length && !manifest.tools.supported) {
    degradations.push({ feature: 'tools', detail: `${manifest.id} has no tool calling; ${request.tools.length} tool(s) withheld` });
    delete request.tools;
    delete request.toolChoice;
    delete request.parallelToolCalls;
  }
  if (request.tools?.length && !manifest.tools.parallel && request.parallelToolCalls !== false) {
    degradations.push({ feature: 'parallel_tool_calls', detail: `${manifest.id} has no parallel tool calls; serialized to one call per turn` });
    request.parallelToolCalls = false;
  }
  if (request.reasoningEffort && !manifest.reasoning) {
    degradations.push({ feature: 'reasoning_effort', detail: `${manifest.id} has no reasoning controls; effort '${request.reasoningEffort}' ignored` });
    delete request.reasoningEffort;
  }
  if (request.temperature !== undefined && manifest.temperature === false) {
    degradations.push({ feature: 'temperature', detail: `${manifest.id} does not accept temperature; ${request.temperature} ignored` });
    delete request.temperature;
  }
  if (request.responseFormat) {
    const so = manifest.structuredOutput ?? { supported: true, strict: false };
    if (!so.supported) {
      degradations.push({ feature: 'structured_output', detail: `${manifest.id} has no native JSON-schema output; schema moved into instructions and validated client-side` });
      request.system = [request.system, jsonInstruction(request.responseFormat.schema)].filter(Boolean).join('\n\n');
      delete request.responseFormat;
    } else if (request.responseFormat.strict && (!so.strict || !isStrictCompatible(request.responseFormat.schema))) {
      const why = !so.strict ? `${manifest.id} has no strict schema mode` : 'schema is not strict-compatible (every object needs all properties required and additionalProperties: false)';
      degradations.push({ feature: 'strict_schema', detail: `${why}; sent non-strict and validated client-side` });
      request.responseFormat = { ...request.responseFormat, strict: false };
    }
  }
  return { request, degradations, validateSchema };
}

export function degradationEvents(degradations: CapabilityDegradation[]): StreamEvent[] {
  return degradations.map((d) => ({ type: 'notice', code: 'capability.degraded', ...d }));
}

function jsonInstruction(schema: JsonSchema): string {
  return `Respond with only a JSON value (no prose, no code fences) that validates against this JSON Schema:\n${JSON.stringify(schema)}`;
}

/** OpenAI strict mode: every object lists all properties in `required` and sets `additionalProperties: false`. */
export function isStrictCompatible(schema: JsonSchema): boolean {
  if (schema.type === 'object') {
    const keys = Object.keys(schema.properties ?? {});
    if (schema.additionalProperties !== false) return false;
    if (keys.some((k) => !schema.required?.includes(k))) return false;
    return keys.every((k) => isStrictCompatible(schema.properties![k]));
  }
  if (schema.type === 'array' && schema.items) return isStrictCompatible(schema.items);
  return true;
}

/** Minimal JSON Schema validator for the subset in `JsonSchema`. Returns error paths; empty = valid. */
export function validateJson(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const errors: string[] = [];
  const t = schema.type;
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (t) {
    const ok = t === 'integer' ? typeof value === 'number' && Number.isInteger(value) : t === 'number' ? typeof value === 'number' && Number.isFinite(value) : actual === t;
    if (!ok) return [`${path}: expected ${t}, got ${actual}`];
  }
  if (schema.enum && !schema.enum.some((e) => e === value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: ${value} > maximum ${schema.maximum}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: length ${value.length} < minLength ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: length ${value.length} > maxLength ${schema.maxLength}`);
  }
  if (actual === 'object' && (t === 'object' || schema.properties)) {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in obj)) errors.push(`${path}.${k}: required`);
    for (const [k, v] of Object.entries(obj)) {
      const sub = schema.properties?.[k];
      if (sub) errors.push(...validateJson(v, sub, `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: additional property not allowed`);
    }
  }
  if (actual === 'array' && schema.items) (value as unknown[]).forEach((v, i) => errors.push(...validateJson(v, schema.items!, `${path}[${i}]`)));
  return errors;
}

/** Parse final assistant text as JSON (tolerating a surrounding code fence) and validate it. */
export function parseStructured(text: string, schema: JsonSchema): StructuredResult {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    return { value: null, valid: false, errors: [`$: invalid JSON (${(error as Error).message})`] };
  }
  const errors = validateJson(value, schema);
  return { value, valid: errors.length === 0, errors };
}

/** Retry-After header: delta-seconds or HTTP-date (RFC 9110 §10.2.3). */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}
