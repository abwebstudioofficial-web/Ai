// Scheduled jobs: the 15-minute monitor and the 08:00 full check.
// Both are rule-based (SQL + HTTP checks, no AI). Nothing is emailed on a normal day:
// the developer only hears about a NEW problem that needs a human (once, when it first
// appears) and about the recovery of a problem they were emailed about. Claude Haiku is
// called only for a new problem, once, to explain it and suggest a fix.
import { type CheckResult, runChecks, saveChecks } from "./checks.ts";
import { resolveAlertByKey, upsertAlert } from "./alerts.ts";
import { notifyOwners } from "./notify.ts";
import { todayText } from "./prompt.ts";
import { db, toJson } from "./db.ts";
import { explainProblems } from "./explain.ts";
import { examples, formatMorningReport, ordersSnapshot, prettyAi, type ReportProblem } from "./report.ts";
import { listPendingApprovals } from "./approvals.ts";
import { advanceAutofixes, triageSiteErrors } from "./autofix.ts";

const alertKey = (r: CheckResult) => (r.name.startsWith("rule:") ? r.name : `check:${r.name}`);
const label = (r: CheckResult) => r.name.replace(/^rule:/, "").replace(/_/g, " ");

/**
 * Creates/refreshes an alert for every problem (fail, and warn if included) and
 * resolves alerts whose checks pass again. Never notifies by itself.
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
        created: res.created,
        firstSeen: row.first_seen_at,
        aiNote: row.ai_note,
      });
    } else if (r.status === "ok") {
      const done = await resolveAlertByKey(
        alertKey(r),
        `Check passing again (auto-resolved by the ${source === "monitor" ? "monitor" : "full check"}).`,
      );
      // Only problems the developer was emailed about get a "Recovered" email.
      if (done?.notified) recovered.push(done.title);
    }
  }
  return { problems, recovered };
}

/** Explains the given problems with one Haiku call (if possible) and stores each note on its alert. */
async function explain(problems: ReportProblem[], source: string) {
  const exp = await explainProblems(problems.map((p) => p.check), source);
  if (exp.text) {
    for (const p of problems) {
      const note = exp.perCheck[p.check.name] ?? exp.text;
      p.aiNote = note;
      await db()`update public.agent_alerts set ai_note = ${note}, ai_noted_at = now() where id = ${p.alertId}`;
    }
  }
  return exp;
}

/**
 * Emails the developer about problems seen for the FIRST time (each problem once). A problem
 * that comes back within 24 hours of an emailed one (flapping) is not emailed again.
 */
export async function emailNewProblems(problems: ReportProblem[], source: string): Promise<number> {
  const fresh: ReportProblem[] = [];
  for (const p of problems.filter((p) => p.created)) {
    const [recent] = await db()<{ id: number }[]>`
      select id from public.agent_alerts
      where dedupe_key = ${alertKey(p.check)} and id <> ${p.alertId} and notified_at > now() - interval '24 hours'
      limit 1`;
    if (!recent) fresh.push(p);
  }
  if (!fresh.length) return 0;

  const exp = await explain(fresh, source);
  const blocks = fresh.map((p) => {
    const eg = examples(p.check.details).map((e) => `   e.g. ${e}`).join("\n");
    return `• ${label(p.check)}: ${p.check.summary}${eg ? `\n${eg}` : ""}`;
  });
  const critical = fresh.some((p) => p.check.status === "fail");
  const delivered = await notifyOwners({
    kind: "alert",
    severity: critical ? "critical" : "warning",
    force: true,
    title: fresh.length === 1 ? `Needs you: ${label(fresh[0].check)}` : `Needs you: ${fresh.length} new problems`,
    body: `${blocks.join("\n\n")}${exp.text ? `\n\n🤖 Likely cause & fix:\n${prettyAi(exp.text)}` : ""}\n\n` +
      `(Found by the ${source}. You won't get another email about ${fresh.length === 1 ? "this" : "these"} ` +
      `unless ${fresh.length === 1 ? "it is" : "they are"} fixed and then come${fresh.length === 1 ? "s" : ""} back.)`,
  });
  if (delivered.some((l) => l.endsWith(": sent"))) {
    await db()`update public.agent_alerts set notified_at = now() where id = any(${fresh.map((p) => p.alertId)}::bigint[])`;
  }
  return fresh.length;
}

async function emailRecoveries(recovered: string[]) {
  if (!recovered.length) return;
  await notifyOwners({
    kind: "recovery",
    severity: "info",
    force: true,
    title: recovered.length === 1 ? `Recovered: ${recovered[0].split(":")[0]}` : `Recovered: ${recovered.length} problems`,
    body: recovered.map((t) => `• ${t}`).join("\n"),
  });
}

/** Every 15 minutes: quick checks + browser errors + auto-fix progress. */
export async function runMonitor(): Promise<{ results: CheckResult[]; newProblems: number }> {
  const results = await runChecks("quick");
  await saveChecks("monitor", results);
  const { problems, recovered } = await syncAlerts(results, "monitor", ["fail"]);
  await emailRecoveries(recovered);
  const newProblems = await emailNewProblems(problems, "15-minute monitor");
  await siteErrorsAndFixes();
  return { results, newProblems };
}

/**
 * 08:00: the full checks. No report is emailed - only new problems (once each) and
 * recoveries of emailed problems. Returns a text summary (for /check on Telegram).
 */
export async function runDailyCheck(): Promise<{ report: string; newProblems: number }> {
  const results = await runChecks("full");
  await saveChecks("daily", results);
  const { problems, recovered } = await syncAlerts(results, "daily_check", ["fail", "warn"]);
  await emailRecoveries(recovered);
  const newProblems = await emailNewProblems(problems, "daily full check");
  await siteErrorsAndFixes();

  const report = formatMorningReport({
    date: await todayText(),
    results,
    problems,
    aiText: null,
    snapshot: await ordersSnapshot(),
    pendingApprovals: await listPendingApprovals(),
  });
  return { report, newProblems };
}

async function siteErrorsAndFixes() {
  try {
    await advanceAutofixes();
    await triageSiteErrors();
  } catch (e) {
    console.error("site errors / auto-fix step failed", e);
  }
}
