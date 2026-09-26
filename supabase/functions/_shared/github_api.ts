import { config } from "./config.ts";

export async function github<T = unknown>(
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  body?: unknown,
  accept = "application/vnd.github+json",
): Promise<T> {
  if (!config.github.token || !config.github.repo) {
    throw new Error("GitHub is not configured (set GITHUB_TOKEN and GITHUB_REPO).");
  }
  const res = await fetch(`https://api.github.com${path.replace("{repo}", config.github.repo)}`, {
    method,
    headers: {
      authorization: `Bearer ${config.github.token}`,
      accept,
      "x-github-api-version": "2022-11-28",
      "user-agent": "site-agent",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export interface CommitHealth {
  sha: string;
  message: string;
  date: string;
  combined_state: string; // success | failure | error | pending
  failed_checks: string[];
}

/** Status of the latest commit on a branch (deploy previews / CI report here). */
export async function latestCommitHealth(ref = config.github.defaultBranch): Promise<CommitHealth> {
  const commit = await github<{ sha: string; commit: { message: string; committer: { date: string } } }>(
    "GET",
    `/repos/{repo}/commits/${encodeURIComponent(ref)}`,
  );
  const status = await github<{ state: string; statuses: { context: string; state: string }[] }>(
    "GET",
    `/repos/{repo}/commits/${commit.sha}/status`,
  );
  const checks = await github<{ check_runs: { name: string; conclusion: string | null }[] }>(
    "GET",
    `/repos/{repo}/commits/${commit.sha}/check-runs?per_page=50`,
  ).catch(() => ({ check_runs: [] }));
  const failed = [
    ...status.statuses.filter((s) => s.state === "failure" || s.state === "error").map((s) => s.context),
    ...checks.check_runs.filter((c) => c.conclusion === "failure" || c.conclusion === "timed_out").map((c) => c.name),
  ];
  return {
    sha: commit.sha.slice(0, 7),
    message: commit.commit.message.split("\n")[0].slice(0, 120),
    date: commit.commit.committer.date,
    combined_state: failed.length ? "failure" : status.state,
    failed_checks: [...new Set(failed)],
  };
}
