// Tracks what every Claude call costs and enforces a monthly budget.
// Prices are US$ per million tokens (Anthropic list prices; check
// https://www.anthropic.com/pricing if they change).
import { db } from "./db.ts";
import { config } from "./config.ts";

const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
};
const DEFAULT_PRICE = { input: 5, output: 25 }; // unknown model: assume Opus-level pricing
const WEB_SEARCH_PER_REQUEST = 0.01; // $10 per 1,000 searches

export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

export function estimateCostUsd(model: string, u: Usage): number {
  const p = PRICES[model] ?? DEFAULT_PRICE;
  const n = (v: number | null | undefined) => (typeof v === "number" ? v : 0);
  const tokens = n(u.input_tokens) * p.input +
    n(u.cache_creation_input_tokens) * p.input * 1.25 + // 5-minute cache writes
    n(u.cache_read_input_tokens) * p.input * 0.1 +
    n(u.output_tokens) * p.output;
  return tokens / 1_000_000 + n(u.server_tool_use?.web_search_requests) * WEB_SEARCH_PER_REQUEST;
}

export async function recordAiCall(
  model: string,
  purpose: "chat" | "explain_problems",
  usage: Usage,
  runId?: string | null,
): Promise<number> {
  const cost = estimateCostUsd(model, usage);
  try {
    await db()`
      insert into public.agent_ai_calls (model, purpose, run_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
      values (${model}, ${purpose}, ${runId ?? null}, ${usage.input_tokens ?? 0}, ${usage.output_tokens ?? 0},
              ${usage.cache_read_input_tokens ?? 0}, ${usage.cache_creation_input_tokens ?? 0}, ${cost})`;
  } catch (e) {
    console.error("recordAiCall failed", e);
  }
  return cost;
}

/** Estimated Claude spend so far this calendar month (UTC). */
export async function monthToDateUsd(): Promise<number> {
  const [row] = await db()<{ total: string | null }[]>`
    select sum(cost_usd)::text as total from public.agent_ai_calls
    where created_at >= date_trunc('month', now())`;
  return Number(row?.total ?? 0);
}

/** Returns a human-readable reason if the monthly budget is used up, otherwise null. */
export async function budgetBlock(): Promise<string | null> {
  if (config.monthlyBudgetUsd <= 0) return null; // 0 = no limit
  const spent = await monthToDateUsd();
  if (spent < config.monthlyBudgetUsd) return null;
  return `This month's AI budget (US$${config.monthlyBudgetUsd.toFixed(2)}) is used up ` +
    `(US$${spent.toFixed(2)} spent). Raise AI_MONTHLY_BUDGET_USD to continue; checks and alerts keep working without AI.`;
}
