// Scheduled jobs: the 15-minute monitor and the 08:00 morning check.
// Both are rule-based (SQL + HTTP checks, no AI). Claude Haiku is called only
// when a check finds a NEW problem, once, to explain it and suggest a fix.
import { type CheckResult, runChecks, saveChecks } from "./checks.ts";
import { resolveAlertByKey, upsertAlert } from "./alerts.ts";
import { notifyOwners } from "./notify.ts";
import { todayText } from "./prompt.ts";
import { db, toJson } from "./db.ts";
import { explainProblems } from "./explain.ts";
import { formatMorningReport, ordersSnapshot, prettyAi, type ReportProblem } from "./report.ts";
import { listPendingApprovals } from "./approvals.ts";

const alertKey = (r: CheckResult) => (r.name.startsWith("rule:") ? r.name : `check:${r.name}`);
const label = (r: CheckResult) => r.name.replace(/^rule:/, "").replace(/_/g, " ");

/**
 * Creates/refreshes an alert for every problem (fail, and warn if included) and
 * resolves alerts whose checks pass again. Never notifies by itself - the caller
 * sends one combined message.
 */
async function syncAlerts(
  results: CheckResult[],
  source: "monitor" | "daily_check",
  statuses: CheckResult["status"][],
): Promise<{ problems: ReportProblem[]; recovered: string[] }> {
  const problems: ReportProblem[] = [];
  const recovered: string[] = [];
  for (const r of results) {
    if (statuses.includes(r.status)) {
      const res = await upsertAlert({
        severity: r.status === "fail" ? "critical" : "warning",
        category: r.category ?? (r.name.startsWith("rule:") ? "business" : "site"),
        title: `${label(r)}: ${r.summary}`.slice(0, 200),
        body: `${r.summary}${r.details ? `\n\nDetails: ${toJson(r.details).slice(0, 1500)}` : ""}`,
        dedupeKey: alertKey(r),
        source,
        notify: false,
      });
      const [row] = await db()<{ first_seen_at: string; ai_note: string | null }[]>`
        select first_seen_at, ai_note from public.agent_alerts where id = ${res.id}`;
      problems.push({
        check: r,
        alertId: res.id,
        isNew: res.created || res.escalated,
        firstSeen: row.first_seen_at,
        aiNote: row.ai_note,
      });
    } else if (r.status === "ok") {
      const title = await resolveAlertByKey(
        alertKey(r),
        `Check passing again (auto-resolved by the ${source === "monitor" ? "monitor" : "morning check"}).`,
      );
      if (title) recovered.push(title);
    }
  }
  return { problems, recovered };
}

/** Explains the NEW problems with one Haiku call (if any) and stores each note on its alert. */
async function explainNew(problems: ReportProblem[], source: string) {
  const fresh = problems.filter((p) => p.isNew);
  const exp = await explainProblems(fresh.map((p) => p.check), source);
  if (exp.text) {
    for (const p of fresh) {
      const note = exp.perCheck[p.check.name] ?? exp.text;
      p.aiNote = note;
      await db()`update public.agent_alerts set ai_note = ${note}, ai_noted_at = now() where id = ${p.alertId}`;
    }
  }
  return exp;
}

/** Every 15 minutes: quick checks. Alerts only on NEW failures; "Recovered" when they pass again. */
export async function runMonitor(): Promise<{ results: CheckResult[]; newProblems: number }> {
  const results = await runChecks("quick");
  await saveChecks("monitor", results);
  const { problems, recovered } = await syncAlerts(results, "monitor", ["fail"]);

  if (recovered.length) {
    await notifyOwners({
      kind: "recovery",
      severity: "info",
      force: true,
      title: "Recovered",
      body: recovered.map((t) => `• ${t}`).join("\n"),
    });
  }

  const fresh = problems.filter((p) => p.isNew);
  if (fresh.length) {
    const exp = await explainNew(fresh, "15-minute monitor");
    const lines = fresh.map((p) => `• ${label(p.check)}: ${p.check.summary}`).join("\n");
    await notifyOwners({
      kind: "alert",
      severity: "critical",
      title: `${fresh.length} new problem${fresh.length > 1 ? "s" : ""} detected`,
      body: `${lines}${exp.text ? `\n\n🤖 Likely cause & fix:\n${prettyAi(exp.text)}` : ""}`,
    });
  }
  return { results, newProblems: fresh.length };
}

/**
 * 08:00: full checks -> alerts -> (Haiku only for new problems) -> report sent to
 * Telegram/email/... and saved, so it also appears in the message thread on the site.
 */
export async function runDailyCheck(): Promise<{ report: string }> {
  const results = await runChecks("full");
  await saveChecks("daily", results);
  const { problems } = await syncAlerts(results, "daily_check", ["fail", "warn"]);
  const exp = await explainNew(problems, "morning check");

  const date = await todayText();
  const report = formatMorningReport({
    date,
    results,
    problems,
    aiText: exp.text,
    aiSkipped: exp.skippedReason,
    snapshot: await ordersSnapshot(),
    pendingApprovals: await listPendingApprovals(),
  });

  await notifyOwners({ kind: "report", severity: "info", force: true, title: `Morning report - ${date}`, body: report });
  return { report };
}
