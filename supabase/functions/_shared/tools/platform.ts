import { clip, toJson } from "../db.ts";
import { platformApiEnabled } from "../config.ts";
import { getAdvisors, queryLogs } from "../supabase_api.ts";
import { formatChecks, runChecks, saveChecks } from "../checks.ts";
import { type AgentTool, oneOfInput, optBool, optNum, str } from "./types.ts";

const supabaseLogs: AgentTool = {
  name: "supabase_logs",
  description:
    "Query Supabase platform logs (API gateway, Postgres, Auth, Edge Functions, Storage) for the last N hours (max 24). " +
    "Uses the unified logs endpoint with ClickHouse SQL over the `logs` table, filtered by `source` " +
    "(e.g. 'edge_logs' = API requests, 'postgres_logs', 'auth_logs', 'function_logs', 'function_edge_logs', 'storage_logs'). " +
    "Fields live in log_attributes['...'] (e.g. log_attributes['request.path'], log_attributes['response.status_code']) " +
    "and event_message. If unsure of the fields, first run: select timestamp, source, event_message, log_attributes from logs " +
    "where source = 'postgres_logs' order by timestamp desc limit 5. " +
    "Set legacy=true to use the older logs.all endpoint (BigQuery-style SQL over tables like edge_logs, postgres_logs, " +
    "function_logs with CROSS JOIN UNNEST(metadata)).",
  input_schema: {
    type: "object",
    properties: {
      sql: { type: "string" },
      hours_back: { type: "integer", description: "1-24, default 24." },
      legacy: { type: "boolean" },
    },
    required: ["sql"],
  },
  risk: "read",
  async run(input) {
    if (!platformApiEnabled()) {
      return { isError: true, content: "Logs are unavailable: AGENT_SUPABASE_PAT is not configured. Ask the owner to add it." };
    }
    const res = await queryLogs(str(input, "sql"), optNum(input, "hours_back", 24, 1, 24), optBool(input, "legacy"));
    return clip(toJson(res), 24_000);
  },
};

const supabaseAdvisors: AgentTool = {
  name: "supabase_advisors",
  description: "Get Supabase's built-in security or performance advisor findings (e.g. tables without RLS, exposed functions, " +
    "missing indexes, unused indexes). Each finding includes remediation guidance.",
  input_schema: {
    type: "object",
    properties: { type: { type: "string", enum: ["security", "performance"] } },
    required: ["type"],
  },
  risk: "read",
  async run(input) {
    if (!platformApiEnabled()) {
      return { isError: true, content: "Advisors are unavailable: AGENT_SUPABASE_PAT is not configured." };
    }
    const lints = await getAdvisors(oneOfInput(input, "type", ["security", "performance"] as const, "security"));
    return clip(
      toJson(lints.map((l) => ({ name: l.name, level: l.level, title: l.title, detail: l.detail, remediation: l.remediation }))),
      24_000,
    );
  },
};

const runHealthChecks: AgentTool = {
  name: "run_health_checks",
  description:
    "Run the built-in health checks now. 'quick' = database, Supabase API, website + its JS/CSS, critical watch rules. " +
    "'full' = everything (full site scan, DB health, failed cron jobs, failed outgoing HTTP calls, RLS, advisors, " +
    "API error logs, latest deploy, all watch rules). Use it to re-verify after a fix.",
  input_schema: {
    type: "object",
    properties: { scope: { type: "string", enum: ["quick", "full"] } },
    required: ["scope"],
  },
  risk: "read",
  async run(input) {
    const scope = oneOfInput(input, "scope", ["quick", "full"] as const, "quick");
    const results = await runChecks(scope);
    await saveChecks(`agent_${scope}`, results);
    return clip(formatChecks(results), 24_000);
  },
};

export const platformTools: AgentTool[] = [supabaseLogs, supabaseAdvisors, runHealthChecks];
