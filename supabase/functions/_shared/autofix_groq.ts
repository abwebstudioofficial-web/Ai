// The auto-fixer's AI, on Groq's FREE plan (the same GROQ_API_KEY the research assistant
// uses; any OpenAI-compatible API works). Same tools and the same code-enforced rules as
// always (autofix.ts / autofix_policy.ts) - only the model differs.
//
// Groq's free plan allows roughly 8,000 tokens a minute per model, so the conversation is
// kept small: tool results are clipped, older ones are shortened, and the model is told to
// read the code in small pieces. One fix attempt runs within a single worker invocation.
import { config } from "./config.ts";
import { db, errorMessage, toJson } from "./db.ts";
import { executeTool } from "./tools/index.ts";
import { finishRun, type RunRow } from "./runs.ts";
import { recordAiCall } from "./ai_cost.ts";
import { autofixRunEnded, autofixSystem, autofixTools } from "./autofix.ts";

const BASE = (Deno.env.get("LLM_BASE_URL") || "https://api.groq.com/openai/v1").replace(/\/$/, "");
const MODELS = [config.groqModel, "openai/gpt-oss-20b"].filter((m, i, a) => m && a.indexOf(m) === i);
const MAX_STEPS = 14;
const MAX_RESULT_CHARS = 3500; // per tool result
const OLD_RESULT_CHARS = 300; // tool results older than the last two
const MAX_WAIT_MS = 25_000; // longest wait for the per-minute limit

type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

const GROQ_RULES = `
Limits of this run (free plan): you have about ${MAX_STEPS} steps and a small memory, so be economical.
- Find code with github_read_file grep (context_lines 2), then read at most 60 lines at a time with start_line/end_line.
- Tool results longer than ${MAX_RESULT_CHARS} characters are cut; ask for less if that happens.
- Read results show line numbers like "  1234| code". Never include that prefix in "find"/"replace" - copy only the code after "| ", with its exact indentation.
- Call exactly one tool at a time. Finish with autofix_submit or autofix_give_up.`;

function openAiTools() {
  return autofixTools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n...(cut; ask for less)` : s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One chat call, with fallback to the second model and short waits on the per-minute limit. */
async function chat(messages: Msg[], deadline: number): Promise<{ msg: Extract<Msg, { role: "assistant" }>; model: string }> {
  let lastError = "no model";
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.groqApiKey}` },
        body: JSON.stringify({
          model,
          messages,
          tools: openAiTools(),
          tool_choice: "auto",
          parallel_tool_calls: false,
          reasoning_effort: "medium",
          max_completion_tokens: 2500,
        }),
        signal: AbortSignal.timeout(Math.max(10_000, Math.min(60_000, deadline - Date.now()))),
      });
      const body = await res.json().catch(() => ({})) as {
        choices?: { message?: Extract<Msg, { role: "assistant" }> }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string; code?: string };
      };
      if (res.ok && body.choices?.[0]?.message) {
        await recordAiCall(`groq/${model}`, "autofix", {
          input_tokens: body.usage?.prompt_tokens ?? 0,
          output_tokens: body.usage?.completion_tokens ?? 0,
        });
        return { msg: body.choices[0].message, model };
      }
      const message = body.error?.message ?? `HTTP ${res.status}`;
      lastError = `${model}: ${message}`;
      if (res.status === 401 || res.status === 403) throw new Error(`Groq refused the key (${message}). Check GROQ_API_KEY.`);
      if (res.status === 429 && !/per day|\(RPD\)|\(TPD\)/i.test(message)) {
        // Per-minute limit: wait as long as Groq asks (if there's time), then try again.
        const wait = Math.min(MAX_WAIT_MS, (Number(res.headers.get("retry-after")) || 15) * 1000 + 500);
        if (Date.now() + wait + 20_000 < deadline) {
          await sleep(wait);
          continue;
        }
      }
      if (body.error?.code === "tool_use_failed" && attempt < 2) continue; // the model fumbled a tool call: retry
      break; // daily limit, retired model, or no time: try the next model
    }
  }
  throw new Error(`Groq (free plan) couldn't answer: ${lastError}`);
}

/** Shortens old tool results so each request stays within the free per-minute token limit. */
function compact(messages: Msg[]) {
  const toolIdx = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []));
  for (const i of toolIdx.slice(0, -2)) {
    const m = messages[i] as Extract<Msg, { role: "tool" }>;
    if (m.content.length > OLD_RESULT_CHARS) m.content = `${m.content.slice(0, OLD_RESULT_CHARS)}\n...(older result shortened)`;
  }
}

/** Runs one auto-fix attempt with Groq from start to finish (called by processRun for "autofix" runs). */
export async function processAutofixWithGroq(run: RunRow, deadline: number): Promise<"done"> {
  if (!config.groqApiKey) {
    const msg = "No GROQ_API_KEY is set for the Edge Functions.";
    await finishRun(run.id, "error", null, msg);
    await autofixRunEnded(run.id, "", msg);
    return "done";
  }
  const [first] = await db()<{ content: { type: string; text?: string }[] }[]>`
    select content from public.agent_messages where conversation_id = ${run.conversation_id} and role = 'user'
    order by id limit 1`;
  const task = first?.content?.find((b) => b.type === "text")?.text ?? "";
  const messages: Msg[] = [
    { role: "system", content: `${autofixSystem()[0].text}\n${GROQ_RULES}` },
    { role: "user", content: task },
  ];
  const ctx = { runId: run.id, conversationId: run.conversation_id, approved: true };
  let finalText = "";
  try {
    for (let step = 0; step < MAX_STEPS && Date.now() + 20_000 < deadline; step++) {
      compact(messages);
      const { msg } = await chat(messages, deadline);
      const calls = (msg.tool_calls ?? []).slice(0, 1); // one at a time keeps the history small and valid
      messages.push({ role: "assistant", content: msg.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
      if (!calls.length) {
        finalText = (msg.content ?? "").trim();
        break;
      }
      const call = calls[0];
      let args: unknown = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        messages.push({ role: "tool", tool_call_id: call.id, content: "Your tool arguments were not valid JSON. Try again." });
        continue;
      }
      const r = await executeTool(call.function.name, args, ctx, autofixTools);
      messages.push({ role: "tool", tool_call_id: call.id, content: clip(r.content, MAX_RESULT_CHARS) });
      const [fix] = await db()<{ status: string }[]>`select status from public.agent_autofixes where run_id = ${run.id}`;
      if (fix && fix.status !== "investigating") {
        finalText = `Finished: ${fix.status}.`;
        break; // submitted (PR opened) or gave up - nothing more to do
      }
    }
    if (!finalText) finalText = "Ran out of steps or time before submitting a fix.";
    await finishRun(run.id, "done", finalText);
    await autofixRunEnded(run.id, finalText, null);
  } catch (e) {
    const msg = errorMessage(e);
    console.error(`auto-fix run ${run.id} (Groq) failed`, e);
    await finishRun(run.id, "error", null, msg);
    await autofixRunEnded(run.id, "", msg);
  }
  console.log(`auto-fix run ${run.id}: ${toJson({ steps: messages.length, final: finalText }).slice(0, 300)}`);
  return "done";
}
