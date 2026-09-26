// Code access for the website repo (e.g. abwebstudioofficial-web/logistix, served by
// GitHub Pages - anything merged into main goes live). The agent can read and search
// the code and open small pull requests from `maint/...` branches. It can NOT push to
// main or merge: the owner reviews and merges every PR.
import { clip, toJson } from "../db.ts";
import { config } from "../config.ts";
import { encodeBase64 } from "../deps.ts";
import { github, latestCommitHealth } from "../github_api.ts";
import { type AgentTool, optBool, optNum, optStr, str } from "./types.ts";

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

function safePath(p: string): string {
  const clean = p.replace(/^\/+/, "");
  if (!clean || clean.split("/").some((s) => s === ".." || s === "")) throw new Error(`Invalid path: ${p}`);
  return clean;
}

/** Raw file text at a ref (works for large files like a single-file index.html), or null if missing. */
async function rawFile(path: string, ref: string): Promise<{ text: string; sha: string } | null> {
  try {
    const meta = await github<{ sha: string; type: string }>(
      "GET",
      `/repos/{repo}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`,
      undefined,
      "application/vnd.github.object+json",
    );
    const res = await fetch(
      `https://api.github.com/repos/${config.github.repo}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`,
      {
        headers: {
          authorization: `Bearer ${config.github.token}`,
          accept: "application/vnd.github.raw+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "site-agent",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!res.ok) throw new Error(`GitHub raw ${path} -> ${res.status}`);
    return { text: await res.text(), sha: meta.sha };
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
}

const listFiles: AgentTool = {
  name: "github_list_files",
  description: "List files in the website's GitHub repository. With recursive=true returns every file path in the repo " +
    "(dependency and build folders excluded); otherwise lists one directory.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path, default repo root." },
      recursive: { type: "boolean" },
      ref: { type: "string", description: "Branch or commit, default the main branch." },
    },
  },
  risk: "read",
  async run(input) {
    const ref = optStr(input, "ref") ?? config.github.defaultBranch;
    if (optBool(input, "recursive")) {
      const tree = await github<{ tree: { path: string; type: string; size?: number }[]; truncated: boolean }>(
        "GET",
        `/repos/{repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      );
      const prefix = optStr(input, "path")?.replace(/^\/+|\/+$/g, "");
      const files = tree.tree
        .filter((t) => t.type === "blob")
        .filter((t) => !/(^|\/)(node_modules|dist|build|\.next|\.git|coverage)\//.test(t.path))
        .filter((t) => !prefix || t.path.startsWith(prefix + "/"))
        .map((t) => `${t.path} (${t.size ?? 0} bytes)`);
      return clip(`${files.length} files${tree.truncated ? " (GitHub truncated the tree)" : ""}:\n${files.join("\n")}`, 30_000);
    }
    const path = optStr(input, "path") ? safePath(str(input, "path")) : "";
    const items = await github<{ name: string; type: string; size: number }[] | { type: string }>(
      "GET",
      `/repos/{repo}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`,
    );
    if (!Array.isArray(items)) return `"${path}" is a ${items.type}, not a directory. Use github_read_file.`;
    return toJson(items.map((i) => ({ name: i.name, type: i.type, size: i.size })));
  },
};

const readFile: AgentTool = {
  name: "github_read_file",
  description:
    "Read a file from the website's repository (always the latest version of the main branch unless `ref` is given). " +
    "Large files (the app is one big index.html) must be read in parts: use `grep` to find the lines you need " +
    "(returns matching line numbers with context), then `start_line`/`end_line` to read a section with line numbers.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      ref: { type: "string", description: "Branch or commit, default the main branch." },
      grep: { type: "string", description: "Case-insensitive regular expression to search for in the file." },
      context_lines: { type: "integer", description: "Lines of context around each grep match (default 3)." },
      start_line: { type: "integer" },
      end_line: { type: "integer" },
    },
    required: ["path"],
  },
  risk: "read",
  async run(input) {
    const path = safePath(str(input, "path"));
    const ref = optStr(input, "ref") ?? config.github.defaultBranch;
    const file = await rawFile(path, ref);
    if (!file) return { isError: true, content: `${path} not found at ${ref}.` };
    const lines = file.text.split("\n");
    const header = `// ${path} @ ${ref} (blob ${file.sha.slice(0, 7)}, ${lines.length} lines, ${file.text.length} chars)`;
    const num = (i: number) => `${String(i + 1).padStart(6)}| ${lines[i]}`;

    const pattern = optStr(input, "grep");
    if (pattern) {
      let re: RegExp;
      try {
        re = new RegExp(pattern, "i");
      } catch {
        re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
      const ctxN = optNum(input, "context_lines", 3, 0, 20);
      const hits = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
      if (!hits.length) return `${header}\nNo lines match /${pattern}/i.`;
      const shown = new Set<number>();
      const out: string[] = [];
      for (const h of hits.slice(0, 60)) {
        const from = Math.max(0, h - ctxN);
        const to = Math.min(lines.length - 1, h + ctxN);
        if (out.length && !shown.has(from - 1)) out.push("   ...");
        for (let i = from; i <= to; i++) {
          if (!shown.has(i)) out.push(num(i));
          shown.add(i);
        }
      }
      return clip(
        `${header}\n${hits.length} matching line(s)${hits.length > 60 ? " (first 60 shown)" : ""}:\n${out.join("\n")}`,
        40_000,
      );
    }

    const start = optNum(input, "start_line", 1, 1, lines.length);
    const end = optNum(input, "end_line", Math.min(lines.length, start + 399), start, lines.length);
    const body = [];
    for (let i = start - 1; i < end; i++) body.push(num(i));
    const more = end < lines.length ? `\n... (${lines.length - end} more lines; use start_line=${end + 1})` : "";
    return clip(`${header}\n${body.join("\n")}${more}`, 40_000);
  },
};

const searchCode: AgentTool = {
  name: "github_search_code",
  description: "Search across the repository with GitHub code search (finds which files mention something). " +
    "To find lines inside one big file, prefer github_read_file with `grep`.",
  input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  risk: "read",
  async run(input) {
    const q = `${str(input, "query")} repo:${config.github.repo}`;
    const res = await github<{ total_count: number; items: { path: string; text_matches?: { fragment: string }[] }[] }>(
      "GET",
      `/search/code?q=${encodeURIComponent(q)}&per_page=20`,
      undefined,
      "application/vnd.github.text-match+json",
    );
    return clip(
      toJson({
        total: res.total_count,
        results: res.items.map((i) => ({ path: i.path, matches: i.text_matches?.map((m) => m.fragment).slice(0, 3) })),
      }),
      20_000,
    );
  },
};

interface OpenPr {
  number: number;
  title: string;
  html_url: string;
  head: { ref: string };
  user: { login: string };
}

/** What other people are working on right now: WORKING_ON.md on main + open PRs and the files they touch. */
async function workInProgress(): Promise<
  { workingOn: string; prs: { number: number; title: string; branch: string; by: string; files: string[] }[] }
> {
  const working = await rawFile("WORKING_ON.md", config.github.defaultBranch).catch(() => null);
  const open = await github<OpenPr[]>("GET", `/repos/{repo}/pulls?state=open&per_page=30`);
  const prs = [];
  for (const pr of open.slice(0, 15)) {
    const files = await github<{ filename: string }[]>("GET", `/repos/{repo}/pulls/${pr.number}/files?per_page=100`).catch(
      () => [],
    );
    prs.push({ number: pr.number, title: pr.title, branch: pr.head.ref, by: pr.user.login, files: files.map((f) => f.filename) });
  }
  return { workingOn: working?.text.trim() || "(WORKING_ON.md is empty or missing)", prs };
}

const workInProgressTool: AgentTool = {
  name: "github_work_in_progress",
  description:
    "Before planning any code change: shows WORKING_ON.md from main (what other people/sessions are currently changing) " +
    "and all open pull requests with the files they touch. Don't start changing an area someone else is working on - " +
    "tell the owner instead.",
  input_schema: { type: "object", properties: {} },
  risk: "read",
  async run() {
    return clip(toJson(await workInProgress(), 2), 20_000);
  },
};

const recentCommits: AgentTool = {
  name: "github_recent_commits",
  description: "Recent commits on the main branch (what changed and when) plus the CI/deploy status of the latest commit. " +
    "Use it to connect a new breakage to a recent change.",
  input_schema: {
    type: "object",
    properties: { since_hours: { type: "integer", description: "Default 72." } },
  },
  risk: "read",
  async run(input) {
    const since = new Date(Date.now() - optNum(input, "since_hours", 72, 1, 24 * 60) * 3600_000).toISOString();
    const commits = await github<{ sha: string; commit: { message: string; author: { name: string; date: string } } }[]>(
      "GET",
      `/repos/{repo}/commits?sha=${encodeURIComponent(config.github.defaultBranch)}&since=${since}&per_page=30`,
    );
    const health = await latestCommitHealth().catch((e) => ({ error: String(e) }));
    return clip(toJson({
      latest_commit_status: health,
      commits: commits.map((c) => ({
        sha: c.sha.slice(0, 7),
        date: c.commit.author.date,
        author: c.commit.author.name,
        message: c.commit.message.split("\n")[0],
      })),
    }, 2));
  },
};

interface Change {
  path: string;
  edits?: { find: string; replace: string }[];
  content?: string;
}

/** Applies exact find/replace edits to the current text; every `find` must match exactly once. */
export function applyEdits(text: string, edits: { find: string; replace: string }[], path: string): string {
  let out = text;
  edits.forEach((e, i) => {
    if (!e.find) throw new Error(`${path} edit #${i + 1}: "find" is empty`);
    const first = out.indexOf(e.find);
    if (first === -1) {
      throw new Error(
        `${path} edit #${i + 1}: the "find" text was not found in the latest main - re-read the file and try again`,
      );
    }
    if (out.indexOf(e.find, first + 1) !== -1) {
      throw new Error(`${path} edit #${i + 1}: the "find" text appears more than once - include more surrounding lines`);
    }
    out = out.slice(0, first) + e.replace + out.slice(first + e.find.length);
  });
  return out;
}

const createFixPr: AgentTool = {
  name: "github_create_fix_pr",
  description:
    "Propose a code fix as a pull request. It branches `maint/<name>` off the LATEST main at the moment of the call, applies " +
    "your changes to that latest version, and opens a PR for the owner to review and merge (merging publishes it - GitHub " +
    "Pages). For existing files give `edits`: exact find/replace pairs; each `find` must match exactly once in the current " +
    "file (include enough surrounding lines), so other people's recent changes are never overwritten. Use `content` only " +
    "for NEW files. Keep each PR small and focused on ONE fix. Run github_work_in_progress first. " +
    "Code rules for this app: the Supabase client is the custom createLiteClient (only select, upsert, update, delete, eq, " +
    "order, range, maybeSingle - no .insert(), no .limit()); all React hooks must stay above any early return; SortTh must " +
    "stay at module scope.",
  input_schema: {
    type: "object",
    properties: {
      branch_name: {
        type: "string",
        description: "Short kebab-case name, e.g. fix-invoice-date (becomes maint/fix-invoice-date).",
      },
      title: { type: "string" },
      body: {
        type: "string",
        description: "What was broken, the root cause, what the change does, which part of the file it touches, how to verify.",
      },
      reason: { type: "string", description: "One-line explanation for the owner." },
      changes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            edits: {
              type: "array",
              items: {
                type: "object",
                properties: { find: { type: "string" }, replace: { type: "string" } },
                required: ["find", "replace"],
              },
            },
            content: { type: "string", description: "Full content - only for new files." },
          },
          required: ["path"],
        },
      },
    },
    required: ["branch_name", "title", "body", "reason", "changes"],
  },
  // Editing CI workflows could expose repository secrets - always ask first.
  risk: (input) =>
    Array.isArray(input.changes) &&
      input.changes.some((c) => typeof (c as Change)?.path === "string" && /^\/?\.github\//.test((c as Change).path))
      ? "owner"
      : "write",
  async run(input) {
    const title = str(input, "title");
    const changes = (Array.isArray(input.changes) ? input.changes : []) as Change[];
    if (!changes.length) return { isError: true, content: "changes must contain at least one {path, edits|content}." };
    const base = config.github.defaultBranch;

    // 1. Start from the latest main and compute every new file BEFORE touching GitHub,
    //    so a bad edit never leaves a half-made branch behind.
    const ref = await github<{ object: { sha: string } }>("GET", `/repos/{repo}/git/ref/heads/${encodeURIComponent(base)}`);
    const baseSha = ref.object.sha;
    const prepared: { path: string; text: string; sha?: string; created: boolean }[] = [];
    for (const c of changes) {
      const path = safePath(String(c.path ?? ""));
      const current = await rawFile(path, baseSha);
      if (c.edits?.length) {
        if (!current) return { isError: true, content: `${path} doesn't exist on ${base}; use "content" to create it.` };
        try {
          prepared.push({ path, text: applyEdits(current.text, c.edits, path), sha: current.sha, created: false });
        } catch (e) {
          return { isError: true, content: (e as Error).message };
        }
      } else if (typeof c.content === "string") {
        if (current) {
          return {
            isError: true,
            content:
              `${path} already exists - change existing files with "edits" (find/replace) so recent changes by others aren't overwritten.`,
          };
        }
        prepared.push({ path, text: c.content, created: true });
      } else {
        return { isError: true, content: `${path}: give either "edits" or "content".` };
      }
    }

    // 2. Branch + commits + PR.
    const slug =
      (optStr(input, "branch_name") ?? title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) ||
      "fix";
    let branch = `maint/${slug}`;
    try {
      await github("POST", "/repos/{repo}/git/refs", { ref: `refs/heads/${branch}`, sha: baseSha });
    } catch (e) {
      if ((e as { status?: number }).status !== 422) throw e; // 422 = branch exists
      branch = `maint/${slug}-${Date.now().toString(36)}`;
      await github("POST", "/repos/{repo}/git/refs", { ref: `refs/heads/${branch}`, sha: baseSha });
    }
    for (const f of prepared) {
      await github("PUT", `/repos/{repo}/contents/${enc(f.path)}`, {
        message: `${f.created ? "Add" : "Update"} ${f.path}: ${title}`.slice(0, 200),
        content: encodeBase64(new TextEncoder().encode(f.text)),
        branch,
        ...(f.sha ? { sha: f.sha } : {}),
      });
    }

    const wip = await workInProgress().catch(() => null);
    const overlapping = wip?.prs.filter((p) => p.files.some((f) => prepared.some((c) => c.path === f))) ?? [];
    const overlapNote = overlapping.length
      ? `\n\n**Heads-up:** these open PRs also change the same file(s): ${
        overlapping.map((p) => `#${p.number} (${p.title})`).join(", ")
      }. ` +
        "Merge order matters; whichever is merged second may need a rebase."
      : "";
    const pr = await github<{ number: number; html_url: string }>("POST", "/repos/{repo}/pulls", {
      title,
      head: branch,
      base,
      body:
        `${str(input, "body")}${overlapNote}\n\n---\n_Opened by Site Agent from the latest \`${base}\` (${
          baseSha.slice(0, 7)
        }). ` +
        `Files: ${prepared.map((f) => f.path).join(", ")}. Please review before merging - merging publishes it._`,
    });
    return `Opened pull request #${pr.number}: ${pr.html_url} (branch ${branch}, based on ${base}@${baseSha.slice(0, 7)}). ` +
      `The owner reviews and merges it. After it is merged, verify the fix on the live site.` +
      (overlapping.length ? ` Note: ${overlapping.length} other open PR(s) touch the same file(s).` : "");
  },
};

export const githubTools: AgentTool[] = [workInProgressTool, listFiles, readFile, searchCode, recentCommits, createFixPr];
