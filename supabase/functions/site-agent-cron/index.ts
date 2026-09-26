// Entry point for scheduled jobs (pg_cron -> public.agent_invoke()).
//   {"job":"daily"}          -> rule-based full checks + morning report to Telegram (08:00 PKT)
//   {"job":"monitor"}        -> rule-based quick checks every 15 minutes
//   {"job":"status"}         -> setup status (which settings/secrets are present - never their values)
//   {"job":"telegram_setup"} -> connects the Telegram bot and returns a one-time link to connect a chat
// No AI is used unless a check finds a NEW problem (then one small Claude Haiku call).
// Requires the x-agent-secret header. Deploy with --no-verify-jwt.
import { background, hasInternalSecret, json } from "../_shared/http.ts";
import { runDailyCheck, runMonitor } from "../_shared/jobs.ts";
import { notifyOwners } from "../_shared/notify.ts";
import { errorMessage } from "../_shared/db.ts";
import { ensureSettings } from "../_shared/settings.ts";
import { setupStatus, setupTelegram } from "../_shared/setup.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  await ensureSettings();
  if (!hasInternalSecret(req)) return json({ error: "forbidden" }, 403);

  const { job } = await req.json().catch(() => ({})) as { job?: string };

  // Quick setup jobs answer directly (read the answer from net._http_response).
  if (job === "status" || job === "telegram_setup") {
    try {
      return json(job === "status" ? await setupStatus() : await setupTelegram());
    } catch (e) {
      console.error(`job ${job} failed`, e);
      return json({ error: errorMessage(e) }, 500);
    }
  }

  const work = async () => {
    try {
      if (job === "daily") await runDailyCheck();
      else if (job === "monitor") await runMonitor();
    } catch (e) {
      console.error(`job ${job} failed`, e);
      await notifyOwners({
        kind: "system",
        severity: "critical",
        force: true,
        title: `Site Agent ${job} job failed`,
        body: errorMessage(e),
      }).catch(() => {});
    }
  };

  if (job !== "daily" && job !== "monitor") {
    return json({ error: 'expected {"job":"daily"|"monitor"|"status"|"telegram_setup"}' }, 400);
  }
  // Respond right away (pg_net only waits 10s); the checks continue in the background.
  background(work());
  return json({ accepted: job }, 202);
});
