// Receives browser errors from the site's error catcher (a small script in index.html).
// Public endpoint (no login: errors happen before and after sign-in), so it is strict:
// only the site's own origin, small bodies, truncated fields, one row per distinct error
// (repeats just bump a counter) and a cap on how many NEW errors are accepted per hour.
// Nothing here calls AI or GitHub; the 15-minute monitor decides what to do with the rows.
// Deploy with --no-verify-jwt.
import { db } from "../_shared/db.ts";
import { config } from "../_shared/config.ts";
import { ensureSettings } from "../_shared/settings.ts";
import { background } from "../_shared/http.ts";

const MAX_BODY = 16_000;
const MAX_NEW_PER_HOUR = 30;
const KINDS = ["error", "unhandledrejection", "console.error", "resource"];

const s = (v: unknown, n: number) =>
  (typeof v === "string" ? v : v == null ? "" : String(v)).replace(/[?#][^\s)'"]*/g, "").slice(0, n);
const int = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < 10_000_000 ? (v as number) : null);

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** Same bug -> same fingerprint, even if numbers/ids in the message differ. */
export function fingerprintText(kind: string, message: string, source: string): string {
  const msg = message.toLowerCase().replace(/\d+/g, "#").replace(/["'`].{0,40}?["'`]/g, "'…'").slice(0, 200);
  const file = source.replace(/^https?:\/\/[^/]+/, "").replace(/:\d+(:\d+)?$/, "");
  return `${kind}|${msg}|${file}`;
}

function allowedOrigin(req: Request): string | null {
  const origin = req.headers.get("origin") ?? "";
  let site = "";
  try {
    site = new URL(config.siteUrl).origin;
  } catch { /* not configured */ }
  return site && origin === site ? origin : null;
}

async function store(payload: { session?: unknown; errors?: unknown; loaded?: unknown }, userAgent: string) {
  const session = s(payload.session, 16) || "unknown";
  // When the page was loaded: old tabs keep running old code, so only loads after a fix count as "came back".
  const loaded = Number((payload as { loaded?: unknown }).loaded);
  const loadedAt = Number.isFinite(loaded) && loaded > 1.7e12 && loaded < Date.now() + 60_000
    ? new Date(loaded).toISOString()
    : null;
  const list = Array.isArray(payload.errors) ? payload.errors.slice(0, 10) : [];
  const sql = db();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const kind = KINDS.includes(String(e.kind)) ? String(e.kind) : "error";
    const message = s(e.message, 500).trim();
    if (!message || /^Script error\.?$|ResizeObserver loop|^\[BABEL\] Note:/.test(message)) continue;
    const source = s(e.source, 300);
    const view = s(e.view, 40);
    const fp = await sha256(fingerprintText(kind, message, source));
    const [existing] = await sql<{ id: number }[]>`select id from public.agent_site_errors where fingerprint = ${fp}`;
    if (!existing) {
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.agent_site_errors where first_seen_at > now() - interval '1 hour'`;
      if (n >= MAX_NEW_PER_HOUR) continue; // flood protection: keep counting known errors, drop new ones
    }
    await sql`
      insert into public.agent_site_errors (fingerprint, kind, message, source, line, col, stack, page, user_agent, sessions)
      values (${fp}, ${kind}, ${message}, ${source || null}, ${int(e.line)}, ${int(e.col)}, ${s(e.stack, 2000) || null},
              ${(s(e.page, 100) + (view ? ` (page: ${view})` : "")) || null}, ${userAgent.slice(0, 200)}, array[${session}::text])
      on conflict (fingerprint) do update set
        occurrences  = agent_site_errors.occurrences + 1,
        last_seen_at = now(),
        sessions     = case when ${session}::text = any(agent_site_errors.sessions) or cardinality(agent_site_errors.sessions) >= 20
                            then agent_site_errors.sessions else agent_site_errors.sessions || ${session}::text end,
        page         = coalesce(excluded.page, agent_site_errors.page),
        stack        = coalesce(agent_site_errors.stack, excluded.stack),
        -- An error that comes back more than 10 minutes after its fix went live: the fix didn't work.
        status       = case when agent_site_errors.status = 'fixed'
                                 and ${loadedAt}::timestamptz > agent_site_errors.fixed_at + interval '3 minutes'
                            then 'regressed' else agent_site_errors.status end`;
  }
}

Deno.serve(async (req) => {
  await ensureSettings();
  const origin = allowedOrigin(req);
  const cors: Record<string, string> = origin ? { "access-control-allow-origin": origin, "vary": "origin" } : {};
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...cors, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type" },
    });
  }
  if (req.method !== "POST" || !origin) return new Response("forbidden", { status: 403 });
  const text = await req.text();
  if (text.length > MAX_BODY) return new Response("too large", { status: 413, headers: cors });
  let payload: { session?: unknown; errors?: unknown };
  try {
    payload = JSON.parse(text);
  } catch {
    return new Response("bad json", { status: 400, headers: cors });
  }
  // Reply at once; store in the background (the page is often closing).
  background(store(payload, req.headers.get("user-agent") ?? "").catch((e) => console.error("storing site errors failed", e)));
  return new Response(null, { status: 204, headers: cors });
});
