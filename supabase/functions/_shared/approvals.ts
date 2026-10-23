// Executing / rejecting approval requests (from Telegram).
// No AI call happens here: the result is shown to the owner directly and noted in
// the conversation, so the agent sees it the next time the owner writes.
import { clip, db } from "./db.ts";
import { executeTool } from "./tools/index.ts";
import { ActiveRunError, hasActiveRun, insertMessage } from "./runs.ts";

export class ApprovalError extends Error {}

interface ApprovalRow {
  id: number;
  run_id: string | null;
  conversation_id: string | null;
  tool_name: string;
  tool_input: Record<string, unknown>;
  reason: string;
  status: string;
}

export interface DecisionResult {
  id: number;
  status: "executed" | "failed" | "rejected";
  result?: string;
}

export async function decideApproval(
  id: number,
  decision: "approve" | "reject",
  by: { userId?: string | null; via: "web" | "telegram" },
  note?: string | null,
): Promise<DecisionResult> {
  const sql = db();
  const [pending] = await sql<ApprovalRow[]>`select * from public.agent_approvals where id = ${id}`;
  if (!pending) throw new ApprovalError(`Approval request #${id} doesn't exist.`);
  if (pending.status !== "pending") throw new ApprovalError(`Request #${id} was already ${pending.status}.`);
  if (pending.conversation_id && await hasActiveRun(pending.conversation_id)) {
    throw new ActiveRunError();
  }

  // Claim the decision atomically (protects against double clicks / two admins).
  const claimed = await sql`
    update public.agent_approvals
    set status = ${decision === "approve" ? "approved" : "rejected"}, decided_by = ${by.userId ?? null},
        decided_via = ${by.via}, decision_note = ${note ?? null}, decided_at = now()
    where id = ${id} and status = 'pending'
    returning id`;
  if (!claimed.length) throw new ApprovalError(`Request #${id} was just decided by someone else.`);

  let status: DecisionResult["status"] = "rejected";
  let result: string | undefined;
  if (decision === "approve") {
    const r = await executeTool(pending.tool_name, pending.tool_input, {
      runId: null,
      conversationId: pending.conversation_id,
      approved: true,
    });
    status = r.isError ? "failed" : "executed";
    result = r.content;
    await sql`update public.agent_approvals set status = ${status}, result = ${clip(result, 8000)} where id = ${id}`;
  }

  // Note the outcome in the conversation where the agent asked (no AI call).
  if (pending.conversation_id) {
    const who = `the owner (via ${by.via})${note ? ` - note: "${note}"` : ""}`;
    const text = decision === "approve"
      ? `[Approval #${id} for ${pending.tool_name} was APPROVED by ${who} and ${
        status === "executed" ? "has been executed" : "was attempted but FAILED"
      }.]\nResult:\n${clip(result ?? "", 6000)}`
      : `[Approval #${id} for ${pending.tool_name} was REJECTED by ${who}. Don't retry it unless asked.]`;
    await insertMessage(pending.conversation_id, null, "user", [{ type: "text", text }], null);
  }
  return { id, status, result };
}

export async function listPendingApprovals(limit = 10) {
  return await db()<{ id: number; tool_name: string; reason: string }[]>`
    select id, tool_name, left(reason, 300) as reason
    from public.agent_approvals where status = 'pending' order by id desc limit ${limit}`;
}
