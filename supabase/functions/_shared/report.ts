// Rule-based morning report: plain text built from the check results and a few
// SQL counts. No AI involved.
import { db } from "./db.ts";
import type { CheckResult } from "./checks.ts";

export interface ReportProblem {
  check: CheckResult;
  alertId: number;
  isNew: boolean;
  firstSeen: string;
  aiNote: string | null;
}

const LABEL_KEYS = [
  "order_number",
  "invoice_number",
  "contract_title",
  "plate",
  "bilty_number",
  "name",
  "jobname",
  "table",
  "url",
  "container_id",
  "latest_price_date",
];
const DETAIL_KEYS = [
  "customer",
  "days_late",
  "days_overdue",
  "days",
  "days_since_loading",
  "days_old",
  "stage_name",
  "eta",
  "due",
  "expiry_date",
  "license_expiry",
  "med_expiry",
  "insurance_expiry",
  "reg_expiry",
  "status",
  "last_error",
  "error",
  "containers",
];

function scalar(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "object") return Array.isArray(v) ? v.slice(0, 3).join(", ") : null;
  return String(v).slice(0, 60);
}

/** One short line describing a sample row, e.g. "ORD-12 (customer: Acme, days_late: 3)". */
export function sampleLine(row: unknown): string {
  if (typeof row !== "object" || row === null) return String(row).slice(0, 80);
  const r = row as Record<string, unknown>;
  const labelKey = LABEL_KEYS.find((k) => scalar(r[k]) !== null);
  const details = DETAIL_KEYS.filter((k) => k !== labelKey && scalar(r[k]) !== null).slice(0, 3)
    .map((k) => `${k.replace(/_/g, " ")}: ${scalar(r[k])}`);
  if (labelKey) return details.length ? `${scalar(r[labelKey])} (${details.join(", ")})` : String(scalar(r[labelKey]));
  return Object.entries(r).map(([k, v]) => [k, scalar(v)]).filter(([, v]) => v !== null).slice(0, 3)
    .map(([k, v]) => `${k}: ${v}`).join(", ");
}

function examples(details: unknown, n = 3): string[] {
  const d = details as { sample?: unknown[] } | unknown[] | undefined;
  const rows = Array.isArray(d) ? d : Array.isArray(d?.sample) ? d!.sample! : [];
  return rows.slice(0, n).map(sampleLine);
}

const niceName = (name: string) => name.replace(/^rule:/, "").replace(/_/g, " ");

/** Turns the "### <check name>" section headers of an AI explanation into readable bullets. */
export const prettyAi = (text: string) => text.replace(/^###\s+(.*)$/gm, (_m, h: string) => `▸ ${niceName(h.trim())}`);
const fmt = (n: number) => n.toLocaleString("en-US");

/** A few headline order numbers for the report (pure SQL). */
export async function ordersSnapshot(): Promise<string> {
  try {
    const [s] = await db()<Record<string, number>[]>`
      select
        (select count(*) from public.agent_container_view
          where not is_delivered and not cancelled and not order_cancelled and stage_index between 1 and 3)::int as in_transit,
        (select count(*) from public.orders o
          where o.eta between public.agent_today() and public.agent_today() + 1
            and not coalesce(o.cancelled, false) and o.delivered_date is null
            and exists (select 1 from public.agent_container_view c
                        where c.order_id = o.id and not c.is_delivered and not c.cancelled))::int as due_soon,
        (select count(*) from public.orders o
          where o.eta < public.agent_today()
            and not coalesce(o.cancelled, false) and o.delivered_date is null
            and exists (select 1 from public.agent_container_view c
                        where c.order_id = o.id and not c.is_delivered and not c.cancelled))::int as late,
        (select count(*) from public.agent_container_view where delivered_date = public.agent_today() - 1)::int as delivered_yesterday,
        (select count(*) from public.orders where created_date = public.agent_today() - 1)::int as new_yesterday`;
    return `In transit ${fmt(s.in_transit)} · due today/tomorrow ${fmt(s.due_soon)} · late ${fmt(s.late)} · ` +
      `delivered yesterday ${fmt(s.delivered_yesterday)} · new orders yesterday ${fmt(s.new_yesterday)}`;
  } catch (e) {
    return `(order numbers unavailable: ${e instanceof Error ? e.message : String(e)})`;
  }
}

export function formatMorningReport(opts: {
  date: string;
  results: CheckResult[];
  problems: ReportProblem[];
  aiText: string | null;
  aiSkipped?: string;
  snapshot: string;
  pendingApprovals: { id: number; tool_name: string }[];
}): string {
  const { results, problems } = opts;
  const failed = problems.filter((p) => p.check.status === "fail");
  const warned = problems.filter((p) => p.check.status === "warn");
  const fyi = results.filter((r) => r.name.startsWith("rule:") && r.status === "ok" && r.details);
  const okCount = results.filter((r) => r.status === "ok").length - fyi.length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  const since = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  const problemLines = (list: ReportProblem[]) =>
    list.map((p) => {
      const tag = p.isNew ? " [NEW]" : ` (open since ${since(p.firstSeen)})`;
      const ex = examples(p.check.details);
      const exLine = ex.length ? `\n   e.g. ${ex.join("; ")}` : "";
      const note = !p.isNew && p.aiNote
        ? `\n   → ${p.aiNote.split("\n").find((l) => /fix|next step|suggest/i.test(l)) ?? p.aiNote.split("\n")[0]}`
        : "";
      return `• ${niceName(p.check.name)}: ${p.check.summary}${tag}${exLine}${note.slice(0, 220)}`;
    }).join("\n");

  const parts: string[] = [];
  if (!problems.length) {
    parts.push(`✅ All ${okCount + fyi.length} checks passed - nothing needs your attention.`);
  } else {
    if (failed.length) parts.push(`🔴 Needs action (${failed.length})\n${problemLines(failed)}`);
    if (warned.length) parts.push(`🟡 Keep an eye on (${warned.length})\n${problemLines(warned)}`);
  }
  if (fyi.length) {
    parts.push(`ℹ️ FYI\n${
      fyi.map((r) => {
        const ex = examples(r.details, 2);
        return `• ${niceName(r.name)}: ${r.summary}${ex.length ? `\n   e.g. ${ex.join("; ")}` : ""}`;
      }).join("\n")
    }`);
  }
  parts.push(`📦 Orders: ${opts.snapshot}`);
  if (problems.length) parts.push(`✅ ${okCount} other checks OK${skipped ? ` (${skipped} not configured)` : ""}`);
  if (opts.aiText) parts.push(`🤖 About the new problems:\n${prettyAi(opts.aiText)}`);
  else if (opts.aiSkipped && problems.some((p) => p.isNew)) parts.push(`(No AI explanation: ${opts.aiSkipped})`);
  if (opts.pendingApprovals.length) {
    parts.push(`🔐 Waiting for your approval: ${opts.pendingApprovals.map((a) => `#${a.id} ${a.tool_name}`).join(", ")}`);
  }
  return parts.join("\n\n");
}
