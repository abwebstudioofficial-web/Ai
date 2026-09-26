import { config } from "./config.ts";
import { db } from "./db.ts";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * Keep the function instance alive until `p` settles, without delaying the response
 * (Supabase's EdgeRuntime.waitUntil; falls back to fire-and-forget elsewhere).
 */
export function background(p: Promise<unknown>): void {
  const rt = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime;
  const guarded = p.catch((e) => console.error("background task failed", e));
  if (rt) rt.waitUntil(guarded);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** For function-to-function and pg_cron calls. */
export function hasInternalSecret(req: Request): boolean {
  const got = req.headers.get("x-agent-secret") ?? "";
  return config.internalSecret.length >= 16 && timingSafeEqual(got, config.internalSecret);
}

export interface AuthedUser {
  id: string;
  email?: string;
}

/** Validates the caller's Supabase session (the browser sends it automatically with functions.invoke). */
export async function getUser(req: Request): Promise<AuthedUser | null> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const res = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    headers: { authorization: `Bearer ${token}`, apikey: config.anonKey || config.serviceRoleKey },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    return null;
  }
  const user = await res.json() as { id?: string; email?: string };
  return user.id ? { id: user.id, email: user.email } : null;
}

export async function isAdmin(userId: string): Promise<boolean> {
  const [row] = await db()<{ ok: boolean }[]>`select public.agent_is_admin(${userId}::uuid) as ok`;
  return row?.ok === true;
}
