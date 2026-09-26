// Creating approval requests (kept separate from executing them to avoid an
// import cycle with the tool registry).
import { db, toJson } from "./db.ts";
import { config } from "./config.ts";
import { notifyOwners } from "./notify.ts";
import type { ToolContext, ToolInput, ToolResult } from "./tools/types.ts";

function preview(input: ToolInput): string {
  const copy: Record<string, unknown> = { ...input };
  delete copy.reason;
  const text = toJson(copy, 2);
  return text.length > 1500 ? `${text.slice(0, 1500)}\n…` : text;
}

export async function requestApproval(
  ctx: ToolContext,
  toolName: string,
  input: ToolInput,
  why: string,
): Promise<ToolResult> {
  const reason = [typeof input.reason === "string" ? input.reason : "", why].filter(Boolean).join("\n");
  const sql = db();
  const [row] = await sql<{ id: number }[]>`
    insert into public.agent_approvals (run_id, conversation_id, tool_name, tool_input, reason)
    values (${ctx.runId}, ${ctx.conversationId}, ${toolName}, ${sql.json(input as never)}, ${reason})
    returning id`;

  const how = [
    "Approve or reject it in the Site Agent dashboard",
    config.notify.telegramBotToken ? `or reply /approve ${row.id} (or /reject ${row.id}) to the Telegram bot` : "",
  ].filter(Boolean).join(" ");

  await notifyOwners({
    kind: "approval",
    severity: "warning",
    force: true,
    title: `Approval needed #${row.id}: ${toolName}`,
    body: `${reason}\n\nAction details:\n${preview(input)}\n\n${how}.`,
  });

  return {
    outcome: "pending_approval",
    content: toJson({
      status: "pending_approval",
      approval_id: row.id,
      message:
        `Queued as approval request #${row.id}; the owner has been notified. Do not retry this action or work around it. ` +
        `Continue with other work and mention request #${row.id} in your final answer. You'll be told the outcome in this conversation.`,
    }),
  };
}
