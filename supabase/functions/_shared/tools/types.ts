import type { Anthropic } from "../deps.ts";

/**
 * read      - never changes anything
 * write     - small, reviewable change (runs automatically in "standard" and "full" mode)
 * dangerous - deletes, schema migrations, bulk updates... (runs automatically only in "full" mode)
 * owner     - always needs the owner's approval, in every mode (e.g. anything touching pg_cron
 *             schedules, auth, storage or vault)
 */
export type Risk = "read" | "write" | "dangerous" | "owner";

export interface ToolContext {
  runId: string | null;
  conversationId: string | null;
  /** true when executing an action the owner explicitly approved */
  approved: boolean;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  outcome?: "ok" | "error" | "pending_approval" | "blocked";
}

export type ToolInput = Record<string, unknown>;

export interface AgentTool {
  name: string;
  description: string;
  input_schema: Anthropic.Beta.BetaTool["input_schema"];
  risk: Risk | ((input: ToolInput) => Risk);
  run(input: ToolInput, ctx: ToolContext): Promise<ToolResult | string>;
}

// ---- small input helpers (the API validates types against the schema; these
// just give friendly errors and defaults) ------------------------------------

export class InputError extends Error {}

export function str(input: ToolInput, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.trim() === "") throw new InputError(`"${key}" is required`);
  return v;
}

export function optStr(input: ToolInput, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

export function optNum(input: ToolInput, key: string, def: number, min: number, max: number): number {
  const v = input[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function optBool(input: ToolInput, key: string, def = false): boolean {
  const v = input[key];
  return typeof v === "boolean" ? v : def;
}

export function oneOfInput<T extends string>(input: ToolInput, key: string, allowed: readonly T[], def: T): T {
  const v = input[key];
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : def;
}
