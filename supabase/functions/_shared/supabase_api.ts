// Supabase Management API (logs + advisors). Needs a personal access token in
// AGENT_SUPABASE_PAT (https://supabase.com/dashboard/account/tokens).
import { config } from "./config.ts";

export async function managementApi(path: string, params: Record<string, string> = {}): Promise<unknown> {
  if (!config.managementToken || !config.projectRef) {
    throw new Error("Supabase Management API is not configured (set AGENT_SUPABASE_PAT).");
  }
  const qs = new URLSearchParams(params).toString();
  const url = `https://api.supabase.com/v1/projects/${config.projectRef}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${config.managementToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Management API ${res.status}: ${text.slice(0, 500)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Query project logs for the last `hoursBack` hours (max 24). */
export async function queryLogs(sql: string, hoursBack = 24, legacy = false): Promise<unknown> {
  const end = new Date();
  const start = new Date(end.getTime() - Math.min(24, Math.max(1, hoursBack)) * 3600_000);
  return await managementApi(`/analytics/endpoints/${legacy ? "logs.all" : "logs"}`, {
    sql,
    iso_timestamp_start: start.toISOString(),
    iso_timestamp_end: end.toISOString(),
  });
}

export interface AdvisorLint {
  name?: string;
  title?: string;
  level?: string;
  detail?: string;
  remediation?: string;
  metadata?: Record<string, unknown>;
}

export async function getAdvisors(type: "security" | "performance"): Promise<AdvisorLint[]> {
  const res = await managementApi(`/advisors/${type}`) as { lints?: AdvisorLint[] } | AdvisorLint[];
  return Array.isArray(res) ? res : res.lints ?? [];
}
