import { clip, db, errorMessage, toJson } from "../db.ts";
import type { Severity } from "../config.ts";
import { setAlertStatus, upsertAlert } from "../alerts.ts";
import { notifyOwners } from "../notify.ts";
import { runRuleSql } from "../checks.ts";
import { type AgentTool, oneOfInput, optNum, optStr, str } from "./types.ts";

const SEVERITIES = ["info", "warning", "critical"] as const;

const createAlert: AgentTool = {
  name: "create_alert",
  description: "Raise an alert for an issue a human needs to look at (shows in the dashboard; warning/critical alerts are also " +
    "sent to the team's phone/email). Use a stable dedupe_key so the same issue updates one alert instead of creating " +
    "duplicates, e.g. 'rule:orders_past_eta', 'site:assets-missing', 'order:ORD-123:late'. " +
    "Severity: critical = broken now / money or customers affected; warning = needs action within days; info = FYI.",
  input_schema: {
    type: "object",
    properties: {
      severity: { type: "string", enum: [...SEVERITIES] },
      title: { type: "string", description: "Short headline (<= 100 chars)." },
      details: { type: "string", description: "What's wrong, evidence (counts, IDs), impact, and the suggested next step." },
      category: {
        type: "string",
        description: "e.g. site, database, orders, fleet, finance, data_quality, integrations, security",
      },
      dedupe_key: { type: "string" },
    },
    required: ["severity", "title", "details"],
  },
  risk: "read",
  async run(input, ctx) {
    const res = await upsertAlert({
      severity: oneOfInput(input, "severity", SEVERITIES, "warning"),
      title: str(input, "title").slice(0, 200),
      body: str(input, "details"),
      category: optStr(input, "category") ?? "general",
      dedupeKey: optStr(input, "dedupe_key"),
      source: "agent",
      runId: ctx.runId,
      conversationId: ctx.conversationId,
    });
    return toJson({
      alert_id: res.id,
      result: res.created ? "created" : res.escalated ? "updated (severity raised)" : "updated existing alert",
      notifications: res.notified ?? "not re-sent (already notified for this alert)",
    });
  },
};

const listAlerts: AgentTool = {
  name: "list_alerts",
  description: "List alerts (default: unresolved ones), newest first.",
  input_schema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["unresolved", "resolved", "all"] },
      limit: { type: "integer" },
    },
  },
  risk: "read",
  async run(input) {
    const status = oneOfInput(input, "status", ["unresolved", "resolved", "all"] as const, "unresolved");
    const rows = await db()`
      select id, severity, category, title, left(body, 500) as details, status, dedupe_key, occurrences,
             first_seen_at, last_seen_at, resolution_note
      from public.agent_alerts
      where ${status} = 'all'
         or (${status} = 'unresolved' and status <> 'resolved')
         or (${status} = 'resolved' and status = 'resolved')
      order by last_seen_at desc
      limit ${optNum(input, "limit", 30, 1, 200)}`;
    return clip(toJson(rows));
  },
};

const updateAlert: AgentTool = {
  name: "update_alert",
  description: "Change an alert's status. Resolve it once you've verified the issue is gone (say how in the note).",
  input_schema: {
    type: "object",
    properties: {
      alert_id: { type: "integer" },
      status: { type: "string", enum: ["open", "acknowledged", "resolved"] },
      note: { type: "string" },
    },
    required: ["alert_id", "status"],
  },
  risk: "read",
  async run(input) {
    const id = optNum(input, "alert_id", 0, 1, Number.MAX_SAFE_INTEGER);
    const status = oneOfInput(input, "status", ["open", "acknowledged", "resolved"] as const, "resolved");
    const ok = await setAlertStatus(id, status, optStr(input, "note"));
    return ok ? `Alert #${id} is now ${status}.` : { isError: true, content: `Alert #${id} not found.` };
  },
};

const notify: AgentTool = {
  name: "notify_owners",
  description: "Send a message to the owners/team right now (Telegram / email / WhatsApp / Slack - whatever is configured). " +
    "Use sparingly: for urgent issues found mid-investigation or when the owner asked to be told something. " +
    "Don't use it for the morning report (that is sent automatically) or for alerts (create_alert already notifies).",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      message: { type: "string" },
      severity: { type: "string", enum: [...SEVERITIES] },
    },
    required: ["title", "message"],
  },
  risk: "read",
  async run(input) {
    const results = await notifyOwners({
      kind: "system",
      severity: oneOfInput(input, "severity", SEVERITIES, "info") as Severity,
      title: str(input, "title"),
      body: str(input, "message"),
      force: true,
    });
    return results.join("\n");
  },
};

const remember: AgentTool = {
  name: "remember",
  description: "Save a long-term note that will be included in your instructions in every future conversation: business facts, " +
    "what a status/stage number means, owner preferences, known quirks, recurring issues and their fixes. " +
    "Using an existing key replaces that note. Keep notes short and factual.",
  input_schema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Short slug, e.g. 'stage-names' or 'owner-prefs'." },
      content: { type: "string" },
    },
    required: ["key", "content"],
  },
  risk: "read",
  async run(input) {
    const key = str(input, "key").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 60);
    const content = str(input, "content").slice(0, 4000);
    await db()`
      insert into public.agent_memory (key, content, updated_by) values (${key}, ${content}, 'agent')
      on conflict (key) do update set content = excluded.content, updated_by = 'agent', updated_at = now()`;
    return `Saved note "${key}". It will be part of your instructions in future runs.`;
  },
};

const forget: AgentTool = {
  name: "forget",
  description: "Delete a long-term note that is wrong or no longer relevant.",
  input_schema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
  risk: "read",
  async run(input) {
    const rows = await db()`delete from public.agent_memory where key = ${str(input, "key")} returning key`;
    return rows.length ? `Deleted note "${input.key}".` : { isError: true, content: `No note "${input.key}".` };
  },
};

const watchRules: AgentTool = {
  name: "watch_rules",
  description:
    "Manage watch rules - saved read-only SELECT queries that run at every morning check (critical ones every 15 minutes). " +
    "Every row a rule returns is one problem. Actions: list, test (run SQL without saving), upsert (create/replace by name; " +
    "the SQL is test-run first), enable, disable, delete. Add a rule whenever you find a kind of problem worth watching " +
    "for automatically. Use public.agent_today() for 'today' in the business timezone.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "test", "upsert", "enable", "disable", "delete"] },
      name: { type: "string", description: "snake_case rule name" },
      description: { type: "string", description: "What a returned row means, in plain words." },
      sql: { type: "string" },
      severity: { type: "string", enum: [...SEVERITIES] },
      category: { type: "string" },
    },
    required: ["action"],
  },
  risk: "read",
  async run(input) {
    const action = oneOfInput(input, "action", ["list", "test", "upsert", "enable", "disable", "delete"] as const, "list");
    const sql = db();
    switch (action) {
      case "list": {
        const rows = await sql`
          select name, description, category, severity, enabled, last_run_at, last_count, last_error, created_by, sql
          from public.agent_watch_rules order by id`;
        return clip(toJson(rows), 24_000);
      }
      case "test": {
        try {
          const res = await runRuleSql(str(input, "sql"));
          return clip(toJson(res));
        } catch (e) {
          return { isError: true, content: `Rule SQL failed: ${errorMessage(e)}` };
        }
      }
      case "upsert": {
        const name = str(input, "name").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
        const ruleSql = str(input, "sql");
        let test;
        try {
          test = await runRuleSql(ruleSql);
        } catch (e) {
          return { isError: true, content: `Not saved - the SQL failed: ${errorMessage(e)}` };
        }
        await sql`
          insert into public.agent_watch_rules (name, description, category, severity, sql, created_by)
          values (${name}, ${str(input, "description")}, ${optStr(input, "category") ?? "general"},
                  ${oneOfInput(input, "severity", SEVERITIES, "warning")}, ${ruleSql}, 'agent')
          on conflict (name) do update set
            description = excluded.description, category = excluded.category, severity = excluded.severity,
            sql = excluded.sql, enabled = true, last_error = null, updated_at = now()`;
        return `Saved rule "${name}". Test run found ${test.count} row(s) right now.`;
      }
      case "enable":
      case "disable": {
        const rows = await sql`
          update public.agent_watch_rules set enabled = ${action === "enable"}, updated_at = now()
          where name = ${str(input, "name")} returning name`;
        return rows.length ? `Rule "${input.name}" ${action}d.` : { isError: true, content: `No rule "${input.name}".` };
      }
      case "delete": {
        const rows = await sql`delete from public.agent_watch_rules where name = ${str(input, "name")} returning name`;
        return rows.length ? `Rule "${input.name}" deleted.` : { isError: true, content: `No rule "${input.name}".` };
      }
    }
  },
};

export const opsTools: AgentTool[] = [createAlert, listAlerts, updateAlert, notify, remember, forget, watchRules];
