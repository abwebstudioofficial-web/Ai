// Deterministic health checks. These run without the AI (cheap, fast, reliable);
// the AI is only brought in to investigate/fix and to write the morning report.
import { db, errorMessage, protocol, toJson } from "./db.ts";
import { config, githubEnabled, platformApiEnabled, type Severity } from "./config.ts";
import { classifySql, stripTrailingSemicolons } from "./sql_guard.ts";
import { scanSite } from "./tools/website.ts";
import { getAdvisors, queryLogs } from "./supabase_api.ts";
import { latestCommitHealth } from "./github_api.ts";

export type CheckStatus = "ok" | "warn" | "fail" | "skipped";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  summary: string;
  details?: unknown;
  duration_ms?: number;
  /** For watch rules: the rule's severity. */
  severity?: Severity;
  category?: string;
}

export interface WatchRule {
  id: number;
  name: string;
  description: string;
  category: string;
  severity: Severity;
  sql: string;
  enabled: boolean;
}

export interface RuleRun {
  count: number;
  sample: unknown[];
}

/** Runs a watch rule's SELECT read-only; returns total matches + up to 10 sample rows. */
export async function runRuleSql(sqlText: string, sampleSize = 10): Promise<RuleRun> {
  const cls = classifySql(sqlText);
  if (cls.kind !== "read") throw new Error(`rule SQL must be a single read-only SELECT (${cls.reasons.join("; ")})`);
  const inner = stripTrailingSemicolons(sqlText);
  return await db().begin("read only", async (tx) => {
    await tx.unsafe("set local statement_timeout = '20s'");
    await tx.unsafe("select 1");
    const [{ n }] = await tx.unsafe(`select count(*)::int as n from (\n${inner}\n) as _r`, [], protocol(false)) as unknown as {
      n: number;
    }[];
    const sample = n > 0
      ? await tx.unsafe(`select * from (\n${inner}\n) as _r limit ${sampleSize}`, [], protocol(false)) as unknown as unknown[]
      : [];
    return { count: n, sample };
  });
}

async function timed(name: string, fn: () => Promise<Omit<CheckResult, "name">>): Promise<CheckResult> {
  const started = Date.now();
  try {
    const r = await fn();
    return { name, ...r, duration_ms: Date.now() - started };
  } catch (e) {
    return { name, status: "fail", summary: `Check crashed: ${errorMessage(e)}`, duration_ms: Date.now() - started };
  }
}

// ---- individual checks ---------------------------------------------------------

const checkDatabase = () =>
  timed("database", async () => {
    const t = Date.now();
    await db()`select 1`;
    const ms = Date.now() - t;
    return { status: ms > 2000 ? "warn" : "ok", summary: `Database reachable (${ms}ms)` };
  });

const checkSupabaseApi = () =>
  timed("supabase_api", async () => {
    const key = config.serviceRoleKey || config.anonKey;
    const headers = { apikey: key };
    const [rest, auth] = await Promise.all([
      fetch(`${config.supabaseUrl}/rest/v1/agent_settings?select=key&limit=1`, { headers, signal: AbortSignal.timeout(10_000) })
        .then(async (r) => ({ status: r.status, ok: r.ok, body: r.ok ? "" : (await r.text()).slice(0, 200) }))
        .catch((e) => ({ status: 0, ok: false, body: errorMessage(e) })),
      fetch(`${config.supabaseUrl}/auth/v1/health`, { headers, signal: AbortSignal.timeout(10_000) })
        .then(async (r) => ({ status: r.status, ok: r.ok, body: r.ok ? "" : (await r.text()).slice(0, 200) }))
        .catch((e) => ({ status: 0, ok: false, body: errorMessage(e) })),
    ]);
    const bad = [!rest.ok && `Data API (PostgREST) ${rest.status} ${rest.body}`, !auth.ok && `Auth ${auth.status} ${auth.body}`]
      .filter(Boolean);
    return bad.length
      ? { status: "fail", summary: `Supabase API problem: ${bad.join("; ")}`, details: { rest, auth } }
      : { status: "ok", summary: "Supabase Data API and Auth are up" };
  });

const checkWebsiteQuick = () =>
  timed("website", async () => {
    if (!config.siteUrl) return { status: "skipped", summary: "SITE_URL not configured" };
    // home page + its JS/CSS/images + SITE_KEY_PATHS (they come first in the page list)
    const scan = await scanSite(config.siteUrl, [], config.siteKeyPaths.length);
    if (!scan.home.ok) {
      return { status: "fail", summary: `Website down: ${scan.home.status ?? scan.home.error}`, details: scan.home };
    }
    const brokenAssets = scan.broken.filter((b) => /\.(js|mjs|css)(\?|$)/.test(b.url));
    if (brokenAssets.length) {
      return {
        status: "fail",
        summary: `Website loads but ${brokenAssets.length} JS/CSS file(s) are missing - pages may be blank`,
        details: brokenAssets,
      };
    }
    if (scan.pages_with_error_text.length) {
      return { status: "fail", summary: "Website shows an error page", details: scan.pages_with_error_text };
    }
    if (scan.broken.length) {
      return { status: "warn", summary: `${scan.broken.length} broken link(s)/image(s)`, details: scan.broken };
    }
    if (scan.home.ms > 4000) return { status: "warn", summary: `Website slow: home page took ${scan.home.ms}ms` };
    return { status: "ok", summary: `Website up (${scan.home.ms}ms, ${scan.assets_checked} assets OK)` };
  });

const checkWebsiteFull = () =>
  timed("website_full_scan", async () => {
    if (!config.siteUrl) return { status: "skipped", summary: "SITE_URL not configured" };
    const scan = await scanSite(config.siteUrl, [], 40);
    const status: CheckStatus = !scan.home.ok || scan.pages_with_error_text.length
      ? "fail"
      : scan.broken.length || scan.slow.length
      ? "warn"
      : "ok";
    return {
      status,
      summary: `${scan.pages_checked} pages / ${scan.assets_checked} assets checked: ${scan.broken.length} broken, ` +
        `${scan.slow.length} slow, ${scan.pages_with_error_text.length} showing error text`,
      details: { broken: scan.broken, slow: scan.slow, error_pages: scan.pages_with_error_text },
    };
  });

const checkDbHealth = () =>
  timed("database_health", async () => {
    const [row] = await db()`
      select
        (select count(*) from pg_stat_activity)::int as connections,
        current_setting('max_connections')::int as max_connections,
        (select count(*) from pg_stat_activity
           where state in ('active', 'idle in transaction') and pid <> pg_backend_pid()
             and now() - query_start > interval '5 minutes')::int as long_running,
        (select count(*) from pg_stat_activity where cardinality(pg_blocking_pids(pid)) > 0)::int as blocked,
        pg_size_pretty(pg_database_size(current_database())) as db_size`;
    const pct = Math.round((100 * row.connections) / row.max_connections);
    const problems = [
      pct > 80 && `connections at ${pct}%`,
      row.long_running > 0 && `${row.long_running} query/transaction running > 5 min`,
      row.blocked > 0 && `${row.blocked} blocked session(s)`,
    ].filter(Boolean);
    return {
      status: problems.length ? "warn" : "ok",
      summary: problems.length
        ? problems.join(", ")
        : `Healthy (${row.connections}/${row.max_connections} connections, size ${row.db_size})`,
      details: row,
    };
  });

const checkCronJobs = () =>
  timed("scheduled_jobs", async () => {
    const [{ exists }] = await db()`select to_regclass('cron.job_run_details') is not null as exists`;
    if (!exists) return { status: "skipped", summary: "pg_cron not installed" };
    const rows = await db()`
      select j.jobname,
             count(*) filter (where d.status = 'failed')::int as failed,
             count(*)::int as runs,
             max(d.start_time) filter (where d.status = 'failed') as last_failed_at,
             (array_agg(left(d.return_message, 300) order by d.start_time desc) filter (where d.status = 'failed'))[1] as last_error
      from cron.job_run_details d
      join cron.job j on j.jobid = d.jobid
      where d.start_time > now() - interval '24 hours'
      group by j.jobname
      having count(*) filter (where d.status = 'failed') > 0`;
    return rows.length
      ? {
        status: "fail",
        summary: `${rows.length} scheduled job(s) failing: ${rows.map((r) => r.jobname).join(", ")}`,
        details: rows,
      }
      : { status: "ok", summary: "No failed scheduled jobs in the last 24h" };
  });

const checkHttpCalls = () =>
  timed("outgoing_http_calls", async () => {
    const [{ exists }] = await db()`select to_regclass('net._http_response') is not null as exists`;
    if (!exists) return { status: "skipped", summary: "pg_net not installed" };
    const [row] = await db()`
      select count(*)::int as total,
             count(*) filter (where status_code >= 400 or error_msg is not null or timed_out)::int as failed,
             (array_agg(coalesce(error_msg, status_code::text || ' ' || left(content, 200)) order by created desc)
                filter (where status_code >= 400 or error_msg is not null or timed_out))[1:3] as recent_failures
      from net._http_response
      where created > now() - interval '24 hours'`;
    if (!row.total) return { status: "ok", summary: "No outgoing HTTP calls from the database recently" };
    const rate = row.failed / row.total;
    return {
      status: row.failed === 0 ? "ok" : rate > 0.2 ? "fail" : "warn",
      summary: `${row.failed} of ${row.total} database-triggered HTTP calls (cron -> Edge Functions etc.) failed in the last 24h`,
      details: row,
    };
  });

const checkRls = () =>
  timed("row_level_security", async () => {
    const rows = await db()`
      select c.relname as table
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity`;
    return rows.length
      ? {
        status: "fail",
        summary: `${rows.length} public table(s) without Row Level Security (readable by anyone with the anon key)`,
        details: rows,
      }
      : { status: "ok", summary: "All public tables have RLS enabled" };
  });

const checkAdvisors = () =>
  timed("supabase_advisors", async () => {
    if (!platformApiEnabled()) return { status: "skipped", summary: "AGENT_SUPABASE_PAT not configured" };
    const [security, performance] = await Promise.all([getAdvisors("security"), getAdvisors("performance")]);
    const errors = security.filter((l) => l.level === "ERROR");
    const warns = [...security, ...performance].filter((l) => l.level === "WARN");
    const pick = (l: { name?: string; title?: string; detail?: string }) => ({
      name: l.name,
      title: l.title,
      detail: l.detail?.slice(0, 300),
    });
    return {
      status: errors.length ? "fail" : warns.length ? "warn" : "ok",
      summary: `Security: ${errors.length} error(s); ${warns.length} warning(s) across security/performance`,
      details: { errors: errors.map(pick), warnings: warns.slice(0, 15).map(pick) },
    };
  });

const checkApiErrors = () =>
  timed("api_errors_24h", async () => {
    if (!platformApiEnabled()) return { status: "skipped", summary: "AGENT_SUPABASE_PAT not configured" };
    const res = await queryLogs(
      `select log_attributes['request.path'] as path,
              toInt32OrZero(log_attributes['response.status_code']) as status,
              count() as errors
       from logs
       where source = 'edge_logs' and toInt32OrZero(log_attributes['response.status_code']) >= 500
       group by path, status
       order by errors desc
       limit 10`,
      24,
    ) as { result?: { errors: number }[]; error?: unknown };
    if (res.error) return { status: "warn", summary: `Could not read logs: ${toJson(res.error).slice(0, 200)}` };
    const rows = res.result ?? [];
    const total = rows.reduce((s, r) => s + Number(r.errors ?? 0), 0);
    return {
      status: total === 0 ? "ok" : total > 50 ? "fail" : "warn",
      summary: total === 0 ? "No 5xx API errors in the last 24h" : `${total} server errors (5xx) from the API in the last 24h`,
      details: rows,
    };
  });

const checkDeploy = () =>
  timed("latest_deploy", async () => {
    if (!githubEnabled()) return { status: "skipped", summary: "GitHub not configured" };
    const h = await latestCommitHealth();
    return {
      status: h.combined_state === "failure" || h.combined_state === "error" ? "fail" : "ok",
      summary: h.failed_checks.length
        ? `Latest commit ${h.sha} ("${h.message}") has failing checks/deploys: ${h.failed_checks.join(", ")}`
        : `Latest commit ${h.sha} ("${h.message}") - checks ${h.combined_state}`,
      details: h,
    };
  });

const checkAgentSelf = () =>
  timed("site_agent", async () => {
    const [row] = await db()`
      select
        (select count(*) from public.agent_approvals where status = 'pending' and created_at < now() - interval '24 hours')::int as stale_approvals,
        (select count(*) from public.agent_runs where status = 'error' and created_at > now() - interval '24 hours')::int as failed_runs`;
    const problems = [
      row.stale_approvals > 0 && `${row.stale_approvals} approval request(s) waiting > 24h`,
      row.failed_runs > 0 && `${row.failed_runs} agent run(s) failed in the last 24h`,
    ].filter(Boolean);
    return {
      status: problems.length ? "warn" : "ok",
      summary: problems.length ? problems.join(", ") : "Agent healthy",
      details: row,
    };
  });

async function checkRules(filter: "all" | "critical"): Promise<CheckResult[]> {
  const rules = await db()<WatchRule[]>`
    select id, name, description, category, severity, sql, enabled
    from public.agent_watch_rules
    where enabled and (${filter} = 'all' or severity = 'critical')
    order by id`;
  const out: CheckResult[] = [];
  for (const rule of rules) {
    const r = await timed(`rule:${rule.name}`, async () => {
      try {
        const res = await runRuleSql(rule.sql);
        await db()`update public.agent_watch_rules set last_run_at = now(), last_count = ${res.count}, last_error = null where id = ${rule.id}`;
        const status: CheckStatus = res.count === 0
          ? "ok"
          : rule.severity === "critical"
          ? "fail"
          : rule.severity === "warning"
          ? "warn"
          : "ok";
        return {
          status,
          summary: res.count === 0 ? `${rule.description} - none` : `${res.count} found: ${rule.description}`,
          details: res.count ? { count: res.count, sample: res.sample } : undefined,
        };
      } catch (e) {
        await db()`update public.agent_watch_rules set last_run_at = now(), last_error = ${
          errorMessage(e)
        } where id = ${rule.id}`;
        return { status: "warn", summary: `Rule failed to run (fix the rule SQL): ${errorMessage(e)}` };
      }
    });
    out.push({ ...r, severity: rule.severity, category: rule.category });
  }
  return out;
}

// ---- entry points ----------------------------------------------------------------

/** quick: uptime + critical rules (15-min monitor). full: everything (morning check). */
export async function runChecks(scope: "quick" | "full"): Promise<CheckResult[]> {
  const base = await Promise.all([checkDatabase(), checkSupabaseApi(), checkWebsiteQuick()]);
  if (scope === "quick") {
    return [...base, ...(await checkRules("critical"))];
  }
  const more = await Promise.all([
    checkWebsiteFull(),
    checkDbHealth(),
    checkCronJobs(),
    checkHttpCalls(),
    checkRls(),
    checkAdvisors(),
    checkApiErrors(),
    checkDeploy(),
    checkAgentSelf(),
  ]);
  return [...base, ...more, ...(await checkRules("all"))];
}

export async function saveChecks(job: string, results: CheckResult[]): Promise<string> {
  const batchId = crypto.randomUUID();
  const sql = db();
  for (const r of results) {
    await sql`
      insert into public.agent_health_checks (batch_id, job, check_name, status, summary, details, duration_ms)
      values (${batchId}, ${job}, ${r.name}, ${r.status}, ${r.summary.slice(0, 2000)},
              ${r.details === undefined ? null : sql.json(JSON.parse(toJson(r.details)))}, ${r.duration_ms ?? null})`;
  }
  return batchId;
}

/** Compact text version for prompts and fallback notifications. */
export function formatChecks(results: CheckResult[], withDetails = true): string {
  const icon = { ok: "✅", warn: "🟡", fail: "🔴", skipped: "⚪" } as const;
  return results
    .map((r) => {
      const line = `${icon[r.status]} ${r.name}: ${r.summary}`;
      if (!withDetails || r.details === undefined || r.status === "ok" || r.status === "skipped") return line;
      const d = toJson(r.details);
      return `${line}\n   details: ${d.length > 1500 ? d.slice(0, 1500) + "…" : d}`;
    })
    .join("\n");
}
