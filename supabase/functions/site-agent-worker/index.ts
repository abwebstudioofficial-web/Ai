// Answers questions sent to the Telegram bot, in the background. Called by site-agent-telegram, by itself
// (to continue long runs) and by pg_cron's sweeper. Not callable from browsers:
// requires the x-agent-secret header. Deploy with --no-verify-jwt.
import { config } from "../_shared/config.ts";
import { background, hasInternalSecret, json } from "../_shared/http.ts";
import { processRun } from "../_shared/agent.ts";
import { findRunsToSweep, kickWorker } from "../_shared/runs.ts";

// The wall-clock limit applies to the whole worker instance, which may serve
// several requests - so measure from when this instance booted.
const BOOTED_AT = Date.now();
const deadline = () => BOOTED_AT + config.wallClockMs - 10_000;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!hasInternalSecret(req)) return json({ error: "forbidden" }, 403);

  const body = await req.json().catch(() => ({})) as { run_id?: string; sweep?: boolean };

  if (body.sweep) {
    const ids = await findRunsToSweep();
    // One fresh invocation per run, so each gets its own time budget.
    background(Promise.all(ids.map((id) => kickWorker(id))));
    return json({ swept: ids.length }, 202);
  }

  if (typeof body.run_id === "string") {
    const runId = body.run_id;
    background(
      processRun(runId, deadline()).then(
        (outcome) => console.log(`run ${runId}: ${outcome}`),
        (e) => console.error(`run ${runId} crashed`, e),
      ),
    );
    return json({ accepted: runId }, 202);
  }

  return json({ error: "expected {run_id} or {sweep:true}" }, 400);
});
