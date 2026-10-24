// The rules for automatic fixes, enforced in code (not just asked of the AI).
// A proposed change to index.html may be merged WITHOUT the developer only if:
//   - it changes at most MAX_CHANGED_LINES lines, and
//   - none of the changed lines touch data loading/saving, amounts or financial
//     calculations, user roles/permissions, deleting, the research assistant, or
//     add scripts/links/storage/navigation.
// Anything else still becomes a pull request, but it waits for the developer's approval.

export const MAX_CHANGED_LINES = 30;

export interface Edit {
  find: string;
  replace: string;
}

const RULES: { re: RegExp; why: string }[] = [
  { re: /research/i, why: "touches the research assistant" },
  {
    re:
      /supabaseClient|createLiteClient|\.from\(\s*["'`]|\.upsert\(|\.update\(|\.select\(|\.eq\(|\bfetch\(|SUPABASE_|saveItem|refreshData|fetchAllRows|toDbRow|fromDbRow/,
    why: "touches loading or saving data",
  },
  {
    re:
      /\b(amounts?|totals?|subtotals?|price|prices|rates?|tax|gst|freight|payments?|balances?|commission|costs?|charges?|discount|profit|fuel|currency|pkr|calc\w*)\b/i,
    why: "touches amounts or financial calculations",
  },
  {
    re: /\broles?\b|\.role\b|allowedViews|ROLE_|isAdmin|permission|viewSession|signIn|signOut|auth\./i,
    why: "touches logins, user roles or permissions",
  },
  { re: /askDelete|\bdelete\b|\.remove\w*\(|splice\(|Trash/i, why: "touches deleting" },
  {
    re:
      /<\/?script|<iframe|https?:\/\/|\beval\(|new Function|innerHTML|dangerouslySetInnerHTML|document\.cookie|localStorage|sessionStorage|window\.location|\.href\s*=|window\.open|import\(/i,
    why: "adds scripts, links, storage or page navigation",
  },
  { re: /\b(create|alter|drop|truncate)\s+(table|policy|function)|\binsert\s+into\b/i, why: "contains database statements" },
];

/** The lines an edit really changes (common leading/trailing lines are context, not changes). */
export function changedLines(e: Edit): { removed: string[]; added: string[] } {
  const a = e.find.split("\n");
  const b = e.replace.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  return { removed: a.slice(start, endA + 1), added: b.slice(start, endB + 1) };
}

export interface PolicyResult {
  linesChanged: number;
  violations: string[];
}

/** Checks a proposed set of find/replace edits against the auto-merge rules. */
export function checkFixPolicy(edits: Edit[]): PolicyResult {
  const violations = new Set<string>();
  if (!edits.length) violations.add("no changes");
  let linesChanged = 0;
  for (const e of edits) {
    const { removed, added } = changedLines(e);
    linesChanged += Math.max(removed.length, added.length);
    for (const line of [...removed, ...added]) {
      for (const r of RULES) if (r.re.test(line)) violations.add(r.why);
    }
  }
  if (linesChanged > MAX_CHANGED_LINES) {
    violations.add(`changes ${linesChanged} lines (automatic fixes are limited to ${MAX_CHANGED_LINES})`);
  }
  return { linesChanged, violations: [...violations] };
}

export interface Repro {
  steps: Record<string, unknown>[];
  target_error: string;
  mock_data?: Record<string, unknown[]>;
}

const STEP_KEYS = ["nav", "click", "fill", "select", "press", "wait"];

/** Validates the reproduction the site check replays (returns an error message, or null if fine). */
export function validateRepro(r: unknown): string | null {
  if (!r || typeof r !== "object") return "repro must be an object with steps and target_error";
  const x = r as Record<string, unknown>;
  if (!Array.isArray(x.steps) || x.steps.length > 30) return "repro.steps must be an array of at most 30 steps";
  for (const [i, st] of x.steps.entries()) {
    if (!st || typeof st !== "object") return `step ${i + 1} must be an object`;
    const keys = Object.keys(st as object);
    if (keys.length !== 1 || !STEP_KEYS.includes(keys[0])) {
      return `step ${i + 1} must have exactly one of: ${STEP_KEYS.join(", ")}`;
    }
    const v = (st as Record<string, unknown>)[keys[0]];
    if (["fill", "select", "press"].includes(keys[0]) && !(Array.isArray(v) && v.length === 2)) {
      return `step ${i + 1}: "${keys[0]}" needs [selector, value]`;
    }
  }
  if (typeof x.target_error !== "string" || x.target_error.trim().length < 4 || x.target_error.length > 200) {
    return "repro.target_error must be a short piece of the error message (4-200 characters)";
  }
  if (x.mock_data !== undefined) {
    if (typeof x.mock_data !== "object" || x.mock_data === null || Array.isArray(x.mock_data)) {
      return "repro.mock_data must be an object of {table: rows[]}";
    }
    if (!Object.values(x.mock_data).every(Array.isArray)) return "every repro.mock_data value must be an array of rows";
    if (JSON.stringify(x.mock_data).length > 30_000) return "repro.mock_data is too big (max 30 KB)";
  }
  if (JSON.stringify(r).includes("-->")) return "repro must not contain '-->'";
  return null;
}
