// The ONLY automatic AI use: one short Claude Haiku call that explains NEW problems
// found by the rule-based checks and suggests a fix. No tools, no agent loop.
// Nothing new -> no call. Budget used up / AI turned off -> no call.
import { Anthropic } from "./deps.ts";
import { config } from "./config.ts";
import { toJson } from "./db.ts";
import type { CheckResult } from "./checks.ts";
import { budgetBlock, recordAiCall } from "./ai_cost.ts";
import { memoryNotes, nowText } from "./prompt.ts";

const SYSTEM = `You are the on-call assistant for LogistiX, a logistics company's web app on Supabase.
Automatic, rule-based checks found problems. For each problem, explain it to the business owner in plain language:
- what it means for the business,
- the most likely cause,
- the suggested fix: one concrete next step. If a data or code change is needed, say the owner can ask Site Agent in the dashboard or Telegram to prepare it for approval.
Rules: use only the data given - don't invent facts. If rows look like old imported data rather than a live problem, say so. Max 3 short lines per problem, no preamble, plain text (it's read on a phone).
Start each problem's section with a line exactly like: ### <check name>`;

export interface Explanation {
  text: string | null;
  /** check name -> that check's section of the explanation */
  perCheck: Record<string, string>;
  skippedReason?: string;
  costUsd?: number;
}

function clipJson(v: unknown, max: number): string {
  const s = toJson(v);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export async function explainProblems(problems: CheckResult[], source: string): Promise<Explanation> {
  const none: Explanation = { text: null, perCheck: {} };
  if (!problems.length) return none;
  if (!config.explainProblems) return { ...none, skippedReason: "AI explanations are turned off (AI_EXPLAIN_PROBLEMS=false)" };
  if (!config.anthropicApiKey) return { ...none, skippedReason: "ANTHROPIC_API_KEY is not set" };
  const blocked = await budgetBlock();
  if (blocked) return { ...none, skippedReason: blocked };

  const list = problems.slice(0, 10).map((p, i) =>
    `${i + 1}. ${p.name} [${p.status === "fail" ? "FAILED" : "WARNING"}]: ${p.summary}` +
    (p.details === undefined ? "" : `\n   data: ${clipJson(p.details, 1500)}`)
  ).join("\n");

  try {
    const client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 2, timeout: 60_000 });
    const response = await client.messages.create({
      model: config.autoModel,
      max_tokens: 1200,
      system: `${SYSTEM}\n\n${await memoryNotes()}`,
      messages: [{
        role: "user",
        content: `Source: ${source}. Now: ${await nowText()}.\nNew problems:\n\n${list}`,
      }],
    });
    const costUsd = await recordAiCall(config.autoModel, "explain_problems", response.usage);
    if (response.stop_reason === "refusal") return { ...none, skippedReason: "the model declined", costUsd };
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!text) return { ...none, costUsd };

    const perCheck: Record<string, string> = {};
    for (const section of text.split(/^###\s+/m).map((s) => s.trim()).filter(Boolean)) {
      const [head, ...rest] = section.split("\n");
      const match = problems.find((p) => head.trim().toLowerCase().includes(p.name.toLowerCase()));
      if (match) perCheck[match.name] = rest.join("\n").trim();
    }
    return { text, perCheck, costUsd };
  } catch (e) {
    console.error("explainProblems failed", e);
    return { ...none, skippedReason: `AI explanation failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
