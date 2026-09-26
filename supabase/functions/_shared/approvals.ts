// Executing / rejecting approval requests (from the dashboard or Telegram).
import { clip, db } from "./db.ts";
import { executeTool } from "./tools/index.ts";
import { ActiveRunError, createRun, hasActiveRun, insertMessage, kickWorker } from "./runs.ts";

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
  followupRunId?: string;
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

  // Tell the agent what happened, in the conversation where it asked.
  let followupRunId: string | undefined;
  if (pending.conversation_id) {
    const who = `the owner (via ${by.via})${note ? ` - note: "${note}"` : ""}`;
    const text = decision === "approve"
      ? `[Approval #${id} for ${pending.tool_name} was APPROVED by ${who} and has been ${
        status === "executed" ? "executed" : "attempted but FAILED"
      }.]\n` +
        `Result:\n${clip(result ?? "", 6000)}\n\nVerify the outcome, update related alerts, and reply with a short confirmation.`
      : `[Approval #${id} for ${pending.tool_name} was REJECTED by ${who}.] Don't retry this action unless asked. ` +
        `Acknowledge in one or two lines, and suggest an alternative if there is one.`;
    await insertMessage(pending.conversation_id, null, "user", [{ type: "text", text }], null);
    try {
      followupRunId = await createRun(pending.conversation_id, "approval_followup", by.userId ?? null);
      await kickWorker(followupRunId);
    } catch (e) {
      if (!(e instanceof ActiveRunError)) throw e;
    }
  }
  return { id, status, result, followupRunId };
}

export async function listPendingApprovals(limit = 10) {
  return await db()<{ id: number; tool_name: string; reason: string }[]>`
    select id, tool_name, left(reason, 300) as reason
    from public.agent_approvals where status = 'pending' order by id desc limit ${limit}`;
}
