// Scheduled jobs: the 15-minute monitor and the 8am morning check.
import { config } from "./config.ts";
import { type CheckResult, runChecks, saveChecks } from "./checks.ts";
import { resolveAlertByKey, upsertAlert } from "./alerts.ts";
import { notifyOwners } from "./notify.ts";
import { dailyKickoff, monitorKickoff, todayText } from "./prompt.ts";
import { ActiveRunError, createConversation, createRun, insertMessage, kickWorker } from "./runs.ts";
import { db, toJson } from "./db.ts";

const alertKey = (r: CheckResult) => (r.name.startsWith("rule:") ? r.name : `check:${r.name}`);

/**
 * Quick checks every 15 minutes, no AI involved. New failures become alerts
 * (the team is notified) and, if AGENT_AUTO_INVESTIGATE is on, the agent is
 * asked to investigate and fix. Checks that pass again auto-resolve their alert.
 */
export async function runMonitor(): Promise<{ results: CheckResult[]; investigationConversationId?: string }> {
  const results = await runChecks("quick");
  await saveChecks("monitor", results);

  const newFailures: CheckResult[] = [];
  for (const r of results) {
    if (r.status === "skipped") continue;
    if (r.status === "fail") {
      const res = await upsertAlert({
        severity: "critical",
        category: r.category ?? "site",
        title: r.summary.slice(0, 160),
        body: `Check "${r.name}" failed.\n${r.summary}${r.details ? `\n\nDetails: ${toJson(r.details).slice(0, 1500)}` : ""}`,
        dedupeKey: alertKey(r),
        source: "monitor",
      });
      if (res.created) newFailures.push(r);
    } else if (r.status === "ok") {
      const title = await resolveAlertByKey(alertKey(r), "Check passing again (auto-resolved by the monitor).");
      if (title) {
        await notifyOwners({
          kind: "recovery",
          severity: "info",
          force: true,
          title: "Recovered",
          body: `${title}\n\nNow: ${r.summary}`,
        });
      }
    }
  }

  if (!newFailures.length || !config.autoInvestigate) return { results };

  // Don't start a second investigation while one is still going.
  const [busy] = await db()`
    select 1 from public.agent_runs where kind = 'monitor_investigate' and status in ('queued', 'running') limit 1`;
  if (busy) return { results };

  const conversationId = await createConversation({
    title: `Investigation: ${newFailures.map((f) => f.name).join(", ")}`.slice(0, 120),
    source: "system",
  });
  await insertMessage(conversationId, null, "user", [{ type: "text", text: await monitorKickoff(newFailures) }], null);
  const runId = await createRun(conversationId, "monitor_investigate");
  await kickWorker(runId);
  return { results, investigationConversationId: conversationId };
}

/** Full checks, then the agent reviews everything and writes the morning report. */
export async function startDailyCheck(createdBy?: string | null): Promise<{ conversationId: string; runId: string }> {
  const results = await runChecks("full");
  await saveChecks("daily", results);

  const conversationId = await createConversation({
    title: `Morning check - ${await todayText()}`,
    source: "system",
    createdBy,
  });
  await insertMessage(conversationId, null, "user", [{ type: "text", text: await dailyKickoff(results) }], null);
  try {
    const runId = await createRun(conversationId, "daily_check", createdBy);
    await kickWorker(runId);
    return { conversationId, runId };
  } catch (e) {
    if (e instanceof ActiveRunError) throw new Error("A morning check is already running.");
    throw e;
  }
}
