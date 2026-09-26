import { clip, toJson } from "../db.ts";
import { config } from "../config.ts";
import { type AgentTool, optNum, optStr, str } from "./types.ts";

export interface FetchCheck {
  url: string;
  final_url?: string;
  status: number | null;
  ok: boolean;
  ms: number;
  content_type?: string;
  bytes?: number;
  title?: string;
  error?: string;
  error_markers?: string[];
}

// Text that usually means the page rendered an error even with HTTP 200.
const ERROR_MARKERS = [
  "Application error",
  "Internal Server Error",
  "502 Bad Gateway",
  "503 Service Unavailable",
  "504 Gateway Time",
  "Unexpected Application Error",
  "DEPLOYMENT_NOT_FOUND",
  "404: NOT_FOUND",
  "This deployment is temporarily paused",
  "Site not found",
  "ChunkLoadError",
];

export async function checkUrl(
  url: string,
  opts: { method?: "GET" | "HEAD"; timeoutMs?: number; keepBody?: boolean } = {},
): Promise<FetchCheck & { body?: string }> {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      redirect: "follow",
      headers: { "user-agent": "SiteAgent/1.0 (+health check)", accept: "*/*" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    const contentType = res.headers.get("content-type") ?? undefined;
    let body: string | undefined;
    let bytes: number | undefined;
    if (opts.method === "HEAD") {
      await res.body?.cancel();
      bytes = Number(res.headers.get("content-length") ?? "") || undefined;
    } else if (contentType && /text|html|json|xml|javascript|css/.test(contentType)) {
      body = await res.text();
      bytes = body.length;
    } else {
      const buf = await res.arrayBuffer();
      bytes = buf.byteLength;
    }
    const check: FetchCheck & { body?: string } = {
      url,
      final_url: res.url !== url ? res.url : undefined,
      status: res.status,
      ok: res.ok,
      ms: Date.now() - started,
      content_type: contentType,
      bytes,
    };
    if (body && contentType?.includes("html")) {
      check.title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim().slice(0, 200);
      const visible = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
      const markers = ERROR_MARKERS.filter((m) => visible.includes(m));
      if (markers.length) check.error_markers = markers;
    }
    if (opts.keepBody) check.body = body;
    return check;
  } catch (e) {
    return {
      url,
      status: null,
      ok: false,
      ms: Date.now() - started,
      error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
    };
  }
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find(Boolean);
}

export function extractLinks(html: string, base: string) {
  const resolve = (u: string | undefined) => {
    if (
      !u || u.startsWith("data:") || u.startsWith("#") || u.startsWith("mailto:") || u.startsWith("tel:") ||
      u.startsWith("javascript:")
    ) return undefined;
    try {
      return new URL(u, base).toString();
    } catch {
      return undefined;
    }
  };
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => resolve(attr(m[0], "src"))).filter(Boolean) as string[];
  const styles = [...html.matchAll(/<link\b[^>]*>/gi)]
    .filter((m) => /stylesheet|modulepreload|preload/i.test(attr(m[0], "rel") ?? ""))
    .map((m) => resolve(attr(m[0], "href")))
    .filter(Boolean) as string[];
  const images = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => resolve(attr(m[0], "src"))).filter(Boolean) as string[];
  const origin = new URL(base).origin;
  const pages = [...html.matchAll(/<a\b[^>]*>/gi)]
    .map((m) => resolve(attr(m[0], "href")))
    .filter((u): u is string => !!u && u.startsWith(origin))
    .map((u) => u.split("#")[0]);
  const uniq = (a: string[]) => [...new Set(a)];
  return { scripts: uniq(scripts), styles: uniq(styles), images: uniq(images), pages: uniq(pages) };
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

export interface SiteScan {
  base_url: string;
  pages_checked: number;
  assets_checked: number;
  broken: FetchCheck[];
  slow: FetchCheck[];
  pages_with_error_text: FetchCheck[];
  home: FetchCheck;
}

/** Checks the home page, its JS/CSS/images, key paths, sitemap URLs and same-site links. */
export async function scanSite(baseUrl: string, extraPaths: string[] = [], maxPages = 25): Promise<SiteScan> {
  const home = await checkUrl(baseUrl, { keepBody: true, timeoutMs: 20_000 });
  const homeBody = home.body ?? "";
  delete home.body;

  const links = homeBody ? extractLinks(homeBody, home.final_url ?? baseUrl) : { scripts: [], styles: [], images: [], pages: [] };

  const pageUrls = new Set<string>();
  for (const p of [...config.siteKeyPaths, ...extraPaths]) {
    try {
      pageUrls.add(new URL(p, baseUrl + "/").toString());
    } catch { /* ignore bad paths */ }
  }
  const sitemap = await checkUrl(`${baseUrl}/sitemap.xml`, { keepBody: true, timeoutMs: 10_000 });
  if (sitemap.ok && sitemap.body?.includes("<loc>")) {
    for (const m of sitemap.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) pageUrls.add(m[1]);
  }
  for (const u of links.pages) pageUrls.add(u);
  pageUrls.delete(baseUrl);
  pageUrls.delete(baseUrl + "/");

  const pages = await pool([...pageUrls].slice(0, maxPages), 5, (u) => checkUrl(u));
  const assets = await pool(
    [...links.scripts, ...links.styles, ...links.images.slice(0, 20)],
    6,
    async (u) => {
      const r = await checkUrl(u, { method: "HEAD", timeoutMs: 15_000 });
      // Some hosts don't support HEAD - retry with GET before calling it broken.
      return r.ok || r.status === null ? r : await checkUrl(u, { timeoutMs: 15_000 });
    },
  );

  const all = [home, ...pages, ...assets];
  return {
    base_url: baseUrl,
    pages_checked: 1 + pages.length,
    assets_checked: assets.length,
    home,
    broken: all.filter((c) => !c.ok),
    slow: all.filter((c) => c.ok && c.ms > 4000),
    pages_with_error_text: [home, ...pages].filter((c) => c.error_markers?.length),
  };
}

// -----------------------------------------------------------------------------

const httpCheck: AgentTool = {
  name: "http_check",
  description: "Fetch one URL (website page, API endpoint, asset) and report status code, response time, size, page title, " +
    "redirects and error text found on the page. Optionally return the start of the response body.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string" },
      method: { type: "string", enum: ["GET", "HEAD"] },
      include_body_chars: { type: "integer", description: "Return this many characters of the body (max 20000)." },
      expect_text: { type: "string", description: "Report whether this text appears in the response." },
    },
    required: ["url"],
  },
  risk: "read",
  async run(input) {
    const url = str(input, "url");
    if (!/^https?:\/\//i.test(url)) return { isError: true, content: "Only http(s) URLs are supported." };
    const bodyChars = optNum(input, "include_body_chars", 0, 0, 20_000);
    const expect = optStr(input, "expect_text");
    const r = await checkUrl(url, { method: input.method === "HEAD" ? "HEAD" : "GET", keepBody: true });
    const body = r.body;
    delete r.body;
    const out: Record<string, unknown> = { ...r };
    if (expect) out.expect_text_found = body?.includes(expect) ?? false;
    if (bodyChars && body) out.body = body.slice(0, bodyChars);
    return clip(toJson(out, 2), 24_000);
  },
};

const siteScan: AgentTool = {
  name: "site_scan",
  description:
    "Health-scan the website: home page, its JavaScript/CSS bundles and images (a missing bundle means a blank page), " +
    "SITE_KEY_PATHS, sitemap.xml URLs and same-site links. Reports broken (4xx/5xx/network errors), slow (>4s) and " +
    "pages showing error text.",
  input_schema: {
    type: "object",
    properties: {
      base_url: { type: "string", description: "Defaults to the configured SITE_URL." },
      extra_paths: { type: "array", items: { type: "string" }, description: "Extra paths like /login or /track." },
      max_pages: { type: "integer", description: "Max pages to check besides the home page (default 25, max 100)." },
    },
  },
  risk: "read",
  async run(input) {
    const base = (optStr(input, "base_url") ?? config.siteUrl).replace(/\/+$/, "");
    if (!base) return { isError: true, content: "No base_url given and SITE_URL is not configured." };
    const extra = Array.isArray(input.extra_paths) ? input.extra_paths.filter((p): p is string => typeof p === "string") : [];
    const scan = await scanSite(base, extra, optNum(input, "max_pages", 25, 0, 100));
    return clip(toJson(scan, 2), 24_000);
  },
};

export const websiteTools: AgentTool[] = [httpCheck, siteScan];
