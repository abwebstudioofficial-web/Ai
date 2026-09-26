// Persistence for conversations, messages and runs.
import type { Anthropic, postgres } from "./deps.ts";
import { db } from "./db.ts";
import { config } from "./config.ts";

export type RunKind = "chat"; // AI runs only happen when someone asks a question
export type RunStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface RunRow {
  id: string;
  conversation_id: string;
  kind: RunKind;
  status: RunStatus;
  turns: number;
  attempts: number;
  created_by: string | null;
}

export interface ConversationRow {
  id: string;
  title: string;
  source: "web" | "telegram" | "system";
  external_id: string | null;
  archived: boolean;
}

/** Thrown when a conversation already has a queued/running run. */
export class ActiveRunError extends Error {
  constructor() {
    super("The agent is still working in this conversation. Wait for it to finish or stop it first.");
  }
}

export async function createConversation(opts: {
  title: string;
  source: ConversationRow["source"];
  externalId?: string | null;
  createdBy?: string | null;
}): Promise<string> {
  const [row] = await db()<{ id: string }[]>`
    insert into public.agent_conversations (title, source, external_id, created_by)
    values (${opts.title.slice(0, 120)}, ${opts.source}, ${opts.externalId ?? null}, ${opts.createdBy ?? null})
    returning id`;
  return row.id;
}

export async function getConversation(id: string): Promise<ConversationRow | null> {
  const [row] = await db()<ConversationRow[]>`
    select id, title, source, external_id, archived from public.agent_conversations where id = ${id}`;
  return row ?? null;
}

export async function insertMessage(
  conversationId: string,
  runId: string | null,
  role: "user" | "assistant",
  content: unknown[],
  displayText?: string | null,
): Promise<void> {
  const sql = db();
  await sql`
    insert into public.agent_messages (conversation_id, run_id, role, content, display_text)
    values (${conversationId}, ${runId}, ${role}, ${sql.json(content as postgres.JSONValue)}, ${displayText ?? null})`;
  await sql`update public.agent_conversations set updated_at = now() where id = ${conversationId}`;
}

/** Full API-level history of a conversation, oldest first. */
export async function loadHistory(conversationId: string): Promise<Anthropic.Beta.BetaMessageParam[]> {
  const rows = await db()<{ role: "user" | "assistant"; content: Anthropic.Beta.BetaContentBlockParam[] }[]>`
    select role, content from public.agent_messages
    where conversation_id = ${conversationId}
    order by id`;
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

export async function createRun(conversationId: string, kind: RunKind, createdBy?: string | null): Promise<string> {
  try {
    const [row] = await db()<{ id: string }[]>`
      insert into public.agent_runs (conversation_id, kind, created_by)
      values (${conversationId}, ${kind}, ${createdBy ?? null})
      returning id`;
    return row.id;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new ActiveRunError();
    throw e;
  }
}

export async function hasActiveRun(conversationId: string): Promise<boolean> {
  const rows = await db()`
    select 1 from public.agent_runs
    where conversation_id = ${conversationId} and status in ('queued', 'running') limit 1`;
  return rows.length > 0;
}

/** Atomically takes ownership of a run until `leaseMs` from now. */
export async function claimRun(runId: string, leaseMs: number): Promise<RunRow | null> {
  const [row] = await db()<RunRow[]>`
    update public.agent_runs
    set status = 'running',
        lease_until = now() + make_interval(secs => ${Math.ceil(leaseMs / 1000)}),
        attempts = attempts + 1,
        started_at = coalesce(started_at, now())
    where id = ${runId}
      and (status = 'queued' or (status = 'running' and lease_until < now()))
    returning id, conversation_id, kind, status, turns, attempts, created_by`;
  return row ?? null;
}

export async function getRunStatus(runId: string): Promise<RunStatus | null> {
  const [row] = await db()<{ status: RunStatus }[]>`select status from public.agent_runs where id = ${runId}`;
  return row?.status ?? null;
}

/** Hands the run back to the queue (the next worker invocation continues it). */
export async function yieldRun(runId: string): Promise<void> {
  await db()`
    update public.agent_runs set status = 'queued', lease_until = null, queued_at = now()
    where id = ${runId} and status = 'running'`;
}

export async function recordTurn(runId: string, usage: Record<string, unknown> | null | undefined): Promise<number> {
  const u = usage ?? {};
  const num = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const [row] = await db()<{ turns: number }[]>`
    update public.agent_runs
    set turns = turns + 1,
        api_failures = 0,
        usage = jsonb_build_object(
          'input_tokens', coalesce((usage->>'input_tokens')::bigint, 0) + ${num("input_tokens")},
          'output_tokens', coalesce((usage->>'output_tokens')::bigint, 0) + ${num("output_tokens")},
          'cache_read_input_tokens', coalesce((usage->>'cache_read_input_tokens')::bigint, 0) + ${num("cache_read_input_tokens")},
          'cache_creation_input_tokens', coalesce((usage->>'cache_creation_input_tokens')::bigint, 0) + ${
    num("cache_creation_input_tokens")
  }
        )
    where id = ${runId}
    returning turns`;
  return row?.turns ?? 0;
}

/** Counts consecutive temporary API failures; returns the new count. */
export async function noteApiFailure(runId: string): Promise<number> {
  const [row] = await db()<{ api_failures: number }[]>`
    update public.agent_runs set api_failures = api_failures + 1 where id = ${runId} returning api_failures`;
  return row?.api_failures ?? 0;
}

export async function finishRun(
  runId: string,
  status: "done" | "error" | "cancelled",
  resultText?: string | null,
  error?: string | null,
): Promise<void> {
  await db()`
    update public.agent_runs
    set status = ${status}, result_text = ${resultText ?? null}, error = ${error ?? null},
        lease_until = null, finished_at = now()
    where id = ${runId} and status in ('queued', 'running')`;
}

export async function cancelRun(runId: string): Promise<boolean> {
  const rows = await db()`
    update public.agent_runs set status = 'cancelled', lease_until = null, finished_at = now()
    where id = ${runId} and status in ('queued', 'running')
    returning id`;
  return rows.length > 0;
}

export async function findRunsToSweep(): Promise<string[]> {
  const rows = await db()<{ id: string }[]>`
    select id from public.agent_runs
    where (status = 'queued' and queued_at < now() - interval '20 seconds')
       or (status = 'running' and lease_until < now())
    order by queued_at
    limit 5`;
  return rows.map((r) => r.id);
}

/** Asks the worker function to process a run (fire-and-forget; the sweeper retries on failure). */
export async function kickWorker(runId: string): Promise<void> {
  try {
    const res = await fetch(`${config.supabaseUrl}/functions/v1/site-agent-worker`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-secret": config.internalSecret },
      body: JSON.stringify({ run_id: runId }),
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel();
    if (!res.ok) console.error(`kickWorker: worker answered ${res.status}`);
  } catch (e) {
    console.error("kickWorker failed (the sweeper will pick the run up)", e);
  }
}
