// The dashboard's API. Called from the browser with the signed-in user's access
// token (Authorization: Bearer <token>). Only agent admins may use it. The panel
// reads AND writes through here, so it works with the app's lite Supabase client.
//
// Actions:
//   { action: "summary" }                             -> { conversations, alerts, approvals, health, autonomy }
//   { action: "get_conversation", conversation_id }   -> { messages, run }
//   { action: "send", message, conversation_id? }     -> { conversation_id, run_id }
//   { action: "stop", run_id }
//   { action: "approve" | "reject", approval_id, note? }
//   { action: "run_check", kind: "daily" | "monitor" }
//   { action: "update_alert", alert_id, status: "acknowledged" | "resolved" | "open", note? }
//   { action: "archive", conversation_id }
import { background, corsHeaders, getUser, isAdmin, json } from "../_shared/http.ts";
import { contextBlock } from "../_shared/prompt.ts";
import {
  ActiveRunError,
  cancelRun,
  createConversation,
  createRun,
  getConversation,
  insertMessage,
  kickWorker,
} from "../_shared/runs.ts";
import { ApprovalError, decideApproval } from "../_shared/approvals.ts";
import { runMonitor, startDailyCheck } from "../_shared/jobs.ts";
import { setAlertStatus } from "../_shared/alerts.ts";
import { formatChecks } from "../_shared/checks.ts";
import { db, errorMessage } from "../_shared/db.ts";
import { config } from "../_shared/config.ts";

const MAX_MESSAGE_CHARS = 20_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: "Please sign in." }, 401);
  if (!(await isAdmin(user.id))) return json({ error: "Only admins can use Site Agent." }, 403);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  try {
    switch (body.action) {
      case "summary": {
        const sql = db();
        const [conversations, alerts, approvals, health] = await Promise.all([
          sql`select id, title, source, updated_at from public.agent_conversations
              where not archived order by updated_at desc limit 60`,
          sql`select id, severity, category, title, body, status, occurrences, last_seen_at from public.agent_alerts
              where status <> 'resolved'
              order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end, last_seen_at desc limit 100`,
          sql`select id, tool_name, tool_input, reason, created_at from public.agent_approvals
              where status = 'pending' order by id desc limit 50`,
          sql`select h.job, h.check_name, h.status, h.summary, h.created_at
              from public.agent_health_checks h
              where h.batch_id in (
                (select batch_id from public.agent_health_checks where job in ('daily', 'agent_full') order by created_at desc limit 1),
                (select batch_id from public.agent_health_checks where job in ('monitor', 'agent_quick') order by created_at desc limit 1))
              order by h.id`,
        ]);
        const isFull = (j: string) => j === "daily" || j === "agent_full";
        return json({
          conversations,
          alerts,
          approvals,
          health: { full: health.filter((h) => isFull(h.job)), quick: health.filter((h) => !isFull(h.job)) },
          autonomy: config.autonomy,
        });
      }

      case "get_conversation": {
        if (typeof body.conversation_id !== "string") return json({ error: "conversation_id is required" }, 400);
        const sql = db();
        const [messages, [run]] = await Promise.all([
          sql<{ id: number; role: string; content: { type: string }[]; display_text: string | null; created_at: string }[]>`
            select id, role, content, display_text, created_at from public.agent_messages
            where conversation_id = ${body.conversation_id} order by id`,
          sql`select id, status, kind, error from public.agent_runs
              where conversation_id = ${body.conversation_id} order by created_at desc limit 1`,
        ]);
        // Thinking blocks are never shown in the UI - leave them out of the payload.
        const visible = messages.map((m) => ({
          ...m,
          content: m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking"),
        }));
        return json({ messages: visible, run: run ?? null });
      }

      case "send": {
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) return json({ error: "message is required" }, 400);
        if (message.length > MAX_MESSAGE_CHARS) {
          return json({ error: `message is longer than ${MAX_MESSAGE_CHARS} characters` }, 400);
        }

        let conversationId = typeof body.conversation_id === "string" ? body.conversation_id : null;
        if (conversationId) {
          const c = await getConversation(conversationId);
          if (!c) return json({ error: "conversation not found" }, 404);
        } else {
          conversationId = await createConversation({ title: message.slice(0, 80), source: "web", createdBy: user.id });
        }

        // Create the run first so a second message can't slip in while the agent is busy.
        const runId = await createRun(conversationId, "chat", user.id);
        try {
          await insertMessage(
            conversationId,
            runId,
            "user",
            [await contextBlock(`web dashboard (${user.email ?? "admin"})`), { type: "text", text: message }],
            message,
          );
        } catch (e) {
          await cancelRun(runId);
          throw e;
        }
        background(kickWorker(runId));
        return json({ conversation_id: conversationId, run_id: runId });
      }

      case "stop": {
        const ok = typeof body.run_id === "string" && await cancelRun(body.run_id);
        return json({ stopped: ok });
      }

      case "approve":
      case "reject": {
        const id = Number(body.approval_id);
        if (!Number.isInteger(id)) return json({ error: "approval_id is required" }, 400);
        const res = await decideApproval(
          id,
          body.action,
          { userId: user.id, via: "web" },
          typeof body.note === "string" ? body.note : null,
        );
        return json(res);
      }

      case "run_check": {
        if (body.kind === "monitor") {
          const { results, investigationConversationId } = await runMonitor();
          return json({ summary: formatChecks(results, false), conversation_id: investigationConversationId ?? null });
        }
        const { conversationId, runId } = await startDailyCheck(user.id);
        return json({ conversation_id: conversationId, run_id: runId });
      }

      case "update_alert": {
        const id = Number(body.alert_id);
        const status = body.status;
        if (!Number.isInteger(id) || (status !== "open" && status !== "acknowledged" && status !== "resolved")) {
          return json({ error: "alert_id and a valid status are required" }, 400);
        }
        const ok = await setAlertStatus(
          id,
          status,
          typeof body.note === "string" ? body.note : `Set to ${status} from the dashboard`,
        );
        return json({ updated: ok });
      }

      case "archive": {
        if (typeof body.conversation_id !== "string") return json({ error: "conversation_id is required" }, 400);
        await db()`update public.agent_conversations set archived = true where id = ${body.conversation_id}`;
        return json({ archived: true });
      }

      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    if (e instanceof ActiveRunError) return json({ error: e.message }, 409);
    if (e instanceof ApprovalError) return json({ error: e.message }, 409);
    console.error("site-agent-chat error", e);
    return json({ error: errorMessage(e) }, 500);
  }
});
