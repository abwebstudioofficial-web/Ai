// The chat agent loop - runs ONLY when someone asks a question on
// Telegram. A run is processed in chunks: each worker invocation does as many
// Claude turns as fit in its time budget, saving every message to the database,
// then hands the run back to the queue if there is more to do.
import { Anthropic } from "./deps.ts";
import { config } from "./config.ts";
import { db, errorMessage } from "./db.ts";
import { apiTools, executeTool } from "./tools/index.ts";
import { buildSystem } from "./prompt.ts";
import { sendTelegram } from "./notify.ts";
import { budgetBlock, friendlyAiError, recordAiCall } from "./ai_cost.ts";
import {
  claimRun,
  finishRun,
  getConversation,
  getRunStatus,
  insertMessage,
  kickWorker,
  loadHistory,
  noteApiFailure,
  recordTurn,
  type RunRow,
  yieldRun,
} from "./runs.ts";

type BetaMessage = Anthropic.Beta.BetaMessage;
type Block = Anthropic.Beta.BetaContentBlock;

const FALLBACK_CAPABLE = /^claude-(opus-5|fable-5)/;
const MAX_API_ATTEMPTS = 6;

function textOf(content: Block[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

async function callClaude(
  client: Anthropic,
  messages: Anthropic.Beta.BetaMessageParam[],
  system: Anthropic.Beta.BetaTextBlockParam[],
  tools: Anthropic.Beta.BetaToolUnion[],
  deadline: number,
  finalAnswerOnly: boolean,
): Promise<BetaMessage> {
  const betas: Anthropic.Beta.AnthropicBeta[] = [];
  const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
    model: config.model,
    max_tokens: config.maxTokens,
    system,
    tools,
    messages,
    thinking: { type: "adaptive" },
    output_config: { effort: config.effort },
    cache_control: { type: "ephemeral" },
  };
  if (finalAnswerOnly) params.tool_choice = { type: "none" };
  if (config.enableFallbacks && FALLBACK_CAPABLE.test(config.model)) {
    // If a safety classifier declines, the API re-runs the request on Anthropic's recommended fallback model.
    betas.push("server-side-fallback-2026-07-01");
    params.fallbacks = "default";
  }
  if (config.enableCompaction) {
    // Very long conversations get summarised server-side instead of overflowing the context window.
    betas.push("compact-2026-01-12");
    params.context_management = { edits: [{ type: "compact_20260112" }] };
  }
  if (betas.length) params.betas = betas;
  return await client.beta.messages.create(params, { timeout: Math.max(20_000, deadline - Date.now()) });
}

/**
 * If the previous worker died after saving Claude's tool calls but before saving
 * their results, add error results so the history stays valid. We deliberately
 * don't re-run the tools: a write may already have happened.
 */
async function repairDanglingToolUse(conversationId: string, runId: string) {
  const [last] = await db()<{ role: string; content: Block[] }[]>`
    select role, content from public.agent_messages
    where conversation_id = ${conversationId} order by id desc limit 1`;
  if (!last || last.role !== "assistant") return;
  const pending = last.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
  if (!pending.length) return;
  await insertMessage(
    conversationId,
    runId,
    "user",
    pending.map((b) => ({
      type: "tool_result",
      tool_use_id: b.id,
      is_error: true,
      content: "Interrupted: the worker stopped before this tool's result was saved. The action may or may not have happened - " +
        "check the current state before retrying.",
    })),
  );
}

async function replyOnTelegram(run: RunRow, text: string) {
  try {
    const conversation = await getConversation(run.conversation_id);
    if (conversation?.source === "telegram" && conversation.external_id) {
      await sendTelegram(conversation.external_id, text || "(no text in the answer)");
    }
  } catch (e) {
    console.error("Telegram reply failed", e);
  }
}

const onRunFinished = (run: RunRow, text: string) => replyOnTelegram(run, text);
const onRunFailed = (run: RunRow, error: string) => replyOnTelegram(run, `Sorry - I hit an error: ${error}`);

function isRetryable(e: unknown): boolean {
  if (e instanceof Anthropic.APIConnectionError) return true; // includes timeouts
  if (e instanceof Anthropic.RateLimitError) return true;
  if (e instanceof Anthropic.InternalServerError) return true;
  if (e instanceof Anthropic.APIError && typeof e.status === "number" && (e.status === 529 || e.status >= 500)) return true;
  return false;
}

/**
 * Processes a run until it finishes or the time budget runs out.
 * `deadline` = epoch ms by which this worker must be done.
 */
export async function processRun(runId: string, deadline: number): Promise<"done" | "yielded" | "skipped"> {
  if (deadline - Date.now() < config.minTurnMs) return "skipped"; // this worker is too old; the sweeper retries
  const run = await claimRun(runId, deadline - Date.now() + 15_000);
  if (!run) return "skipped";

  if (!config.anthropicApiKey) {
    const msg = "ANTHROPIC_API_KEY is not set for the Edge Functions.";
    await finishRun(run.id, "error", null, msg);
    await onRunFailed(run, msg);
    return "done";
  }

  const client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 1 });
  const system = await buildSystem();
  const tools = apiTools();
  const ctx = { runId: run.id, conversationId: run.conversation_id, approved: false };
  let turns = run.turns;
  let truncations = 0;

  try {
    await repairDanglingToolUse(run.conversation_id, run.id);

    while (true) {
      if ((await getRunStatus(run.id)) === "cancelled") return "done";

      if (Date.now() + config.minTurnMs > deadline) {
        await yieldRun(run.id);
        await kickWorker(run.id);
        return "yielded";
      }

      const finalAnswerOnly = turns >= config.maxTurnsPerRun;
      if (finalAnswerOnly) {
        await insertMessage(run.conversation_id, run.id, "user", [{
          type: "text",
          text: "[System] You've reached the step limit for this task. Don't call any more tools. Write your final answer now: " +
            "what you found, what you did, and what's left.",
        }]);
      }

      const blocked = await budgetBlock();
      if (blocked) {
        await insertMessage(run.conversation_id, run.id, "assistant", [{ type: "text", text: blocked }]);
        await finishRun(run.id, "done", blocked);
        await onRunFinished(run, blocked);
        return "done";
      }

      const response = await callClaude(client, await loadHistory(run.conversation_id), system, tools, deadline, finalAnswerOnly);
      turns = await recordTurn(run.id, response.usage as unknown as Record<string, unknown>);
      await recordAiCall(response.model || config.model, "chat", response.usage, run.id);

      switch (response.stop_reason) {
        case "tool_use": {
          await insertMessage(run.conversation_id, run.id, "assistant", response.content);
          const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
          const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
          for (const call of calls) {
            const r = await executeTool(call.name, call.input, ctx);
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: r.content,
              ...(r.isError ? { is_error: true } : {}),
            });
          }
          await insertMessage(run.conversation_id, run.id, "user", results);
          continue;
        }

        case "pause_turn": // a server tool (web search) paused mid-turn - resend to continue
        case "compaction":
          await insertMessage(run.conversation_id, run.id, "assistant", response.content);
          continue;

        case "max_tokens": {
          // Discard the cut-off response (its tool input may be incomplete) and ask for smaller steps.
          if (++truncations > 2) throw new Error("Claude's responses keep hitting the output limit (AGENT_MAX_TOKENS).");
          await insertMessage(run.conversation_id, run.id, "user", [{
            type: "text",
            text: "[System] Your previous response hit the output length limit and was discarded. Continue in smaller steps " +
              "(shorter SQL, fewer rows, smaller files per call).",
          }]);
          continue;
        }

        case "refusal": {
          const text = textOf(response.content) || "I can't help with that request.";
          await insertMessage(run.conversation_id, run.id, "assistant", [{ type: "text", text }]);
          await finishRun(run.id, "done", text);
          await onRunFinished(run, text);
          return "done";
        }

        case "model_context_window_exceeded":
          throw new Error("This conversation is too long for the model. Start a new conversation.");

        default: {
          // end_turn / stop_sequence
          await insertMessage(run.conversation_id, run.id, "assistant", response.content);
          const text = textOf(response.content);
          await finishRun(run.id, "done", text);
          await onRunFinished(run, text);
          return "done";
        }
      }
    }
  } catch (e) {
    const msg = errorMessage(e);
    console.error(`run ${run.id} failed`, e);
    if (isRetryable(e) && (await noteApiFailure(run.id)) < MAX_API_ATTEMPTS) {
      // Temporary API problem: hand the run back; the sweeper retries it in a minute or so.
      await yieldRun(run.id);
      return "yielded";
    }
    await finishRun(run.id, "error", null, msg);
    await onRunFailed(run, friendlyAiError(e));
    return "done";
  }
}
