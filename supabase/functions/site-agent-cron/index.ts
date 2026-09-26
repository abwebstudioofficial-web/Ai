// Entry point for scheduled jobs (pg_cron -> public.agent_invoke()).
//   {"job":"daily"}   -> full checks + AI morning review + report (08:00 PKT)
//   {"job":"monitor"} -> quick checks every 15 minutes (AI only when something new breaks)
// Requires the x-agent-secret header. Deploy with --no-verify-jwt.
import { background, hasInternalSecret, json } from "../_shared/http.ts";
import { runMonitor, startDailyCheck } from "../_shared/jobs.ts";
import { notifyOwners } from "../_shared/notify.ts";
import { errorMessage } from "../_shared/db.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!hasInternalSecret(req)) return json({ error: "forbidden" }, 403);

  const { job } = await req.json().catch(() => ({})) as { job?: string };

  const work = async () => {
    try {
      if (job === "daily") await startDailyCheck();
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

  if (job !== "daily" && job !== "monitor") return json({ error: 'expected {"job":"daily"|"monitor"}' }, 400);
  // Respond right away (pg_net only waits 10s); the checks continue in the background.
  background(work());
  return json({ accepted: job }, 202);
});
