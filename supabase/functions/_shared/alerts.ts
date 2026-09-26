import { db } from "./db.ts";
import type { Severity } from "./config.ts";
import { notifyOwners } from "./notify.ts";

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export interface AlertInput {
  severity: Severity;
  title: string;
  body: string;
  category?: string;
  dedupeKey?: string | null;
  source: "agent" | "monitor" | "daily_check" | "system";
  runId?: string | null;
  conversationId?: string | null;
  /** default true: notify on new alerts and on severity escalation */
  notify?: boolean;
}

export interface AlertOutcome {
  id: number;
  created: boolean;
  escalated: boolean;
  notified: string[] | null;
}

/**
 * Creates an alert, or - if an unresolved alert with the same dedupe key already
 * exists - refreshes it (so repeated detections don't spam the team).
 */
export async function upsertAlert(a: AlertInput): Promise<AlertOutcome> {
  const sql = db();
  const key = a.dedupeKey?.trim() || null;
  let id: number;
  let created = false;
  let escalated = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (key) {
      const [existing] = await sql<{ id: number; severity: Severity }[]>`
        select id, severity from public.agent_alerts
        where dedupe_key = ${key} and status <> 'resolved'
        limit 1`;
      if (existing) {
        escalated = RANK[a.severity] > RANK[existing.severity];
        const severity = escalated ? a.severity : existing.severity;
        await sql`
          update public.agent_alerts
          set title = ${a.title}, body = ${a.body}, severity = ${severity},
              category = ${a.category ?? "general"}, last_seen_at = now(),
              occurrences = occurrences + 1,
              run_id = coalesce(${a.runId ?? null}::uuid, run_id),
              conversation_id = coalesce(${a.conversationId ?? null}::uuid, conversation_id)
          where id = ${existing.id}`;
        id = existing.id;
        break;
      }
    }
    try {
      const [row] = await sql<{ id: number }[]>`
        insert into public.agent_alerts
          (severity, category, title, body, dedupe_key, source, run_id, conversation_id)
        values (${a.severity}, ${a.category ?? "general"}, ${a.title}, ${a.body}, ${key},
                ${a.source}, ${a.runId ?? null}, ${a.conversationId ?? null})
        returning id`;
      id = row.id;
      created = true;
      break;
    } catch (e) {
      // Someone inserted the same dedupe key concurrently -> loop once and update it.
      if ((e as { code?: string }).code === "23505" && attempt === 0) continue;
      throw e;
    }
  }

  let notified: string[] | null = null;
  if ((created || escalated) && a.notify !== false) {
    notified = await notifyOwners({
      kind: "alert",
      severity: a.severity,
      title: `${a.severity.toUpperCase()}: ${a.title}`,
      body: `${a.body}\n\n(alert #${id!})`,
    });
    if (notified.some((l) => l.includes(": sent"))) {
      await sql`update public.agent_alerts set notified_at = now() where id = ${id!}`;
    }
  }
  return { id: id!, created, escalated, notified };
}

export async function setAlertStatus(
  id: number,
  status: "open" | "acknowledged" | "resolved",
  note?: string | null,
): Promise<boolean> {
  const rows = await db()`
    update public.agent_alerts
    set status = ${status},
        resolved_at = case when ${status} = 'resolved' then now() else null end,
        resolution_note = coalesce(${note ?? null}, resolution_note)
    where id = ${id}
    returning id`;
  return rows.length > 0;
}

/** Resolves the open alert with this dedupe key. Returns its title if one was open. */
export async function resolveAlertByKey(key: string, note: string): Promise<string | null> {
  const [row] = await db()<{ title: string }[]>`
    update public.agent_alerts
    set status = 'resolved', resolved_at = now(), resolution_note = ${note}
    where dedupe_key = ${key} and status <> 'resolved'
    returning title`;
  return row?.title ?? null;
}
