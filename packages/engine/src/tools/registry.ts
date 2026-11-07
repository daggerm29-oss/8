import type { Provenance } from '@helix/protocol';
import type { JsonSchema, ToolSpec } from '@helix/protocol';
import type { LocalSandbox } from '../sandbox/sandbox.ts';
import type { WorkspaceIndex } from '../index/index.ts';

export interface ToolContext {
  sandbox: LocalSandbox;
  signal: AbortSignal;
  index?: WorkspaceIndex;
  /** Persist a task artifact (plan, report); returns the artifact id (§5.6). */
  submitArtifact?: (kind: string, title: string, data: unknown) => string;
  /** Called with the previous content (null = new file) before any write, for checkpoints (§20.3). */
  beforeWrite?: (absPath: string, previous: string | null) => void;
}

export interface ToolOutput {
  content: string;
  isError?: boolean;
  summary?: string;
  /** Defaults to builtin/trusted; MCP tools mark untrusted output as tainted (F-MCP-5). */
  provenance?: Provenance;
  /** Full result stored out of band (F-MCP-4), e.g. `mcpres_…`. */
  dataRef?: string;
  truncated?: boolean;
}

export interface Tool {
  spec: ToolSpec;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

export const MAX_RESULT_CHARS = 16_000;

export function truncate(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(-Math.floor(max * 0.25));
  return `${head}\n…[${text.length - head.length - tail.length} chars truncated]…\n${tail}`;
}

/** Minimal JSON-schema validation for tool arguments (types, required, enum, bounds). */
export function validate(schema: JsonSchema, value: unknown, path = 'args'): string[] {
  const errors: string[] = [];
  const t = schema.type;
  if (t === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [`${path} must be an object`];
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (obj[r] === undefined || obj[r] === null) errors.push(`${path}.${r} is required`);
    for (const [k, sub] of Object.entries(schema.properties ?? {})) if (obj[k] !== undefined && obj[k] !== null) errors.push(...validate(sub, obj[k], `${path}.${k}`));
    if (schema.additionalProperties === false) for (const k of Object.keys(obj)) if (!schema.properties?.[k]) errors.push(`${path}.${k} is not allowed`);
  } else if (t === 'string') {
    if (typeof value !== 'string') errors.push(`${path} must be a string`);
    else if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
  } else if (t === 'integer' || t === 'number') {
    if (typeof value !== 'number' || (t === 'integer' && !Number.isInteger(value))) errors.push(`${path} must be ${t === 'integer' ? 'an integer' : 'a number'}`);
    else if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) errors.push(`${path} out of range`);
  } else if (t === 'boolean' && typeof value !== 'boolean') errors.push(`${path} must be a boolean`);
  else if (t === 'array' && !Array.isArray(value)) errors.push(`${path} must be an array`);
  return errors;
}

/** Tool framework (§15.1–15.3): registration, schema exposure, validation, uniform error handling. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly deferred = new Set<string>();

  /** Deferred tools are callable but not sent to the model until a `tool_search` activates them (X7). */
  defer(name: string): void {
    if (this.tools.has(name)) this.deferred.add(name);
  }

  isDeferred(name: string): boolean {
    return this.deferred.has(name);
  }

  deferredSpecs(): ToolSpec[] {
    return [...this.deferred].map((n) => this.tools.get(n)!.spec);
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.spec.name)) throw new Error(`tool '${tool.spec.name}' already registered`);
    this.tools.set(tool.spec.name, tool);
  }

  specs(filter?: (name: string) => boolean): ToolSpec[] {
    return [...this.tools.values()].map((t) => t.spec).filter((s) => !filter || filter(s.name));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async run(name: string, args: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const tool = this.tools.get(name);
    if (!tool) return { content: `unknown tool '${name}'. Available: ${[...this.tools.keys()].join(', ')}`, isError: true };
    const errors = validate(tool.spec.inputSchema, args);
    if (errors.length) return { content: `invalid arguments: ${errors.join('; ')}`, isError: true };
    try {
      const out = await tool.run(args as Record<string, unknown>, ctx);
      return { ...out, content: truncate(out.content) };
    } catch (error) {
      return { content: `${(error as Error).name}: ${(error as Error).message}`, isError: true };
    }
  }
}
