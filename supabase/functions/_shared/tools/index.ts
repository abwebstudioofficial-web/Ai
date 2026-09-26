// Tool registry: the list sent to Claude, plus approval gating and audit logging
// around every execution.
import type { Anthropic } from "../deps.ts";
import { config, githubEnabled, platformApiEnabled } from "../config.ts";
import { clip, db, errorMessage } from "../db.ts";
import { requestApproval } from "../approval_requests.ts";
import { databaseTools } from "./database.ts";
import { websiteTools } from "./website.ts";
import { platformTools } from "./platform.ts";
import { githubTools } from "./github.ts";
import { opsTools } from "./ops.ts";
import { type AgentTool, InputError, type Risk, type ToolContext, type ToolInput, type ToolResult } from "./types.ts";

// Platform tools are always registered (run_health_checks works without a PAT;
// the log/advisor tools explain what's missing if called unconfigured).
function registry(): AgentTool[] {
  return [
    ...databaseTools,
    ...websiteTools,
    ...platformTools.filter((t) => t.name === "run_health_checks" || platformApiEnabled()),
    ...(githubEnabled() ? githubTools : []),
    ...opsTools,
  ];
}

/** Tool definitions for the Messages API. Order is stable so the prompt cache keeps hitting. */
export function apiTools(): Anthropic.Beta.BetaToolUnion[] {
  const defs: Anthropic.Beta.BetaToolUnion[] = registry().map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
  if (config.enableWebSearch) {
    defs.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 });
  }
  return defs;
}

function needsApproval(risk: Risk): boolean {
  if (risk === "owner") return true;
  switch (config.autonomy) {
    case "full":
      return false;
    case "readonly":
      return risk !== "read";
    default:
      return risk === "dangerous";
  }
}

async function audit(
  ctx: ToolContext,
  name: string,
  input: ToolInput,
  outcome: NonNullable<ToolResult["outcome"]>,
  isWrite: boolean,
  preview: string,
  ms: number,
) {
  try {
    const sql = db();
    await sql`
      insert into public.agent_audit_log (run_id, conversation_id, tool_name, input, outcome, is_write, result_preview, duration_ms)
      values (${ctx.runId}, ${ctx.conversationId}, ${name}, ${sql.json(input as never)}, ${outcome}, ${isWrite},
              ${preview.slice(0, 2000)}, ${ms})`;
  } catch (e) {
    console.error("audit log failed", e);
  }
}

export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as ToolInput;
  const tool = registry().find((t) => t.name === name);
  if (!tool) return { isError: true, outcome: "error", content: `Unknown tool "${name}".` };

  const risk = typeof tool.risk === "function" ? tool.risk(input) : tool.risk;
  const started = Date.now();

  if (!ctx.approved && needsApproval(risk)) {
    const res = await requestApproval(ctx, name, input, `(${risk} action - autonomy mode "${config.autonomy}")`);
    await audit(ctx, name, input, "pending_approval", true, res.content, Date.now() - started);
    return res;
  }

  let result: ToolResult;
  try {
    const out = await tool.run(input, ctx);
    result = typeof out === "string" ? { content: out } : out;
  } catch (e) {
    const msg = e instanceof InputError ? `Invalid input: ${e.message}` : `Tool failed: ${errorMessage(e)}`;
    result = { isError: true, content: msg };
  }
  result.outcome ??= result.isError ? "error" : "ok";
  result.content = clip(result.content || "(no output)", 30_000);
  await audit(ctx, name, input, result.outcome, risk !== "read", result.content, Date.now() - started);
  return result;
}
