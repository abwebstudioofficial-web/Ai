// =============================================================================
// Site Agent panel for LogistiX (index.html)
// =============================================================================
// Shows every message Site Agent sends (morning reports, new-problem alerts with
// explanations, recoveries, approval requests) as a chat thread that looks and
// streams like Claude. The same messages also go to Telegram. There is no
// question box: this agent reports, it doesn't take questions on the site.
//
// Paste this whole block into index.html's existing <script type="text/babel">,
// at MODULE SCOPE (outside every component, e.g. just before the main App
// component). It only uses globals the page already loads: React 18 UMD +
// Tailwind CDN. It does NOT use the Supabase client for data - it only asks it
// for the signed-in user's access token and talks to the site-agent-api Edge
// Function with fetch(), so the lite client's missing .insert()/.limit() don't
// matter.
//
// Usage (admin-only view):
//   {view === "site_agent" && viewSession.role === "admin" && (
//     <SiteAgentPanel client={supabaseClient} supabaseUrl={SUPABASE_URL} anonKey={SUPABASE_ANON_KEY} />
//   )}
//
// Rules this file follows (they caused real bugs before):
//  - every hook is called at the top of each component, before any early return
//  - all components are defined at module scope (never inside another component)
//  - names are prefixed (SiteAgent*/SA*/sa*) so nothing clashes with index.html
//  - hooks are used as React.useState etc. (index.html already destructures
//    useState/useEffect/... at the top, so we must not declare them again)
// =============================================================================

const SA_POLL_MESSAGES_MS = 15000;
const SA_POLL_SUMMARY_MS = 30000;
const SA_STATUS_ORDER = ["fail", "warn", "ok", "skipped"];
const SA_STATUS_ICON = { ok: "✅", warn: "🟡", fail: "🔴", skipped: "⚪" };
const SA_SEV_ICON = { critical: "🔴", warning: "🟡", info: "ℹ️" };
const SA_SEV_BORDER = { critical: "border-l-red-500", warning: "border-l-amber-500", info: "border-l-sky-500" };
const SA_KIND = {
  report: { label: "Morning report", cls: "bg-[#3a3a36] text-[#d6d3ca]" },
  alert: { label: "Alert", cls: "bg-red-500/15 text-red-300" },
  recovery: { label: "Recovered", cls: "bg-emerald-500/15 text-emerald-300" },
  approval: { label: "Needs approval", cls: "bg-amber-500/15 text-amber-300" },
  system: { label: "Notice", cls: "bg-[#3a3a36] text-[#d6d3ca]" },
};
// Claude-like warm dark palette (scoped to this panel)
const SA_C = {
  bg: "bg-[#262624]",
  panel: "bg-[#1f1e1d]",
  border: "border-[#3d3d3a]",
  text: "text-[#ececea]",
  body: "text-[#e5e2d9]",
  muted: "text-[#9b9890]",
  faint: "text-[#75726b]",
  accent: "#d97757",
};

function saCx(...a) {
  return a.filter(Boolean).join(" ");
}

// Postgres timestamps ("2026-09-26 12:18:32.482643+00") -> Date, in every browser.
function saDate(v) {
  if (!v) return new Date(NaN);
  return new Date(String(v).replace(" ", "T").replace(/(\.\d{3})\d+/, "$1").replace(/([+-]\d{2})$/, "$1:00"));
}

function saAgo(v) {
  const d = saDate(v);
  if (isNaN(d)) return "";
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return d.toLocaleDateString();
}

function saTime(v) {
  const d = saDate(v);
  return isNaN(d) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function saDayLabel(v) {
  const d = saDate(v);
  if (isNaN(d)) return "";
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function saPretty(v) {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch (e) {
    return String(v);
  }
}

// ---- markdown-ish renderer (React elements only - no innerHTML) ----------------
function saInline(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={i++} className="font-semibold text-[#f4f2ec]">{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("*")) out.push(<strong key={i++} className="font-semibold text-[#f4f2ec]">{tok.slice(1, -1)}</strong>);
    else if (tok.startsWith("`")) {
      out.push(<code key={i++} className="font-mono text-[0.85em] px-1 py-0.5 rounded bg-[#1f1e1d] text-[#e8a787]">{tok.slice(1, -1)}</code>);
    } else out.push(<a key={i++} href={tok} target="_blank" rel="noreferrer" className="underline decoration-[#d97757]/60 hover:text-white">{tok}</a>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const SA_BULLET = /^\s*([-*•]|\d+[.)])\s+/;
const SA_SUBHEAD = /^\s*▸\s+/; // "▸ problem name" lines in AI explanations

function SAMarkdown({ text }) {
  const parts = String(text || "").split(/```[a-zA-Z]*\n?/);
  const blocks = [];
  parts.forEach((part, idx) => {
    if (idx % 2 === 1) {
      blocks.push(
        <pre key={"c" + idx} className="font-mono text-[12.5px] leading-5 bg-[#1f1e1d] border border-[#3d3d3a] rounded-lg p-3 overflow-auto whitespace-pre-wrap">
          {part.replace(/\n$/, "")}
        </pre>,
      );
      return;
    }
    part.split(/\n{2,}/).forEach((para, j) => {
      const lines = para.split("\n").filter((l) => l.trim() !== "");
      if (!lines.length) return;
      const items = []; // {type: "h"|"p"|"ul", ...}
      let list = null;
      lines.forEach((l, k) => {
        const bullet = SA_BULLET.exec(l);
        if (bullet) {
          if (!list) {
            list = { type: "ul", items: [] };
            items.push(list);
          }
          list.items.push({ text: l.slice(bullet[0].length), sub: [] });
        } else if (/^\s{2,}\S/.test(l) && list && list.items.length) {
          list.items[list.items.length - 1].sub.push(l.trim()); // "   e.g. ..." continuation lines
        } else {
          list = null;
          const heading = /^#{1,4}\s/.test(l) || SA_SUBHEAD.test(l) || (lines[k + 1] && SA_BULLET.test(lines[k + 1])) ||
            (l.trim().length <= 60 && /:\s*$/.test(l) && k < lines.length - 1); // short "Title:" line with text below
          items.push({ type: heading ? "h" : "p", text: l.replace(/^#{1,4}\s/, "").replace(SA_SUBHEAD, "") });
        }
      });
      blocks.push(
        <div key={idx + "-" + j} className="space-y-1.5">
          {items.map((it, n) =>
            it.type === "ul"
              ? (
                <ul key={n} className="list-disc pl-6 space-y-1 marker:text-[#8f8c84]">
                  {it.items.map((li, q) => (
                    <li key={q}>
                      {saInline(li.text)}
                      {li.sub.map((s, r) => <div key={r} className="text-[#a9a69e] text-[0.93em]">{saInline(s)}</div>)}
                    </li>
                  ))}
                </ul>
              )
              : it.type === "h"
              ? <p key={n} className="font-semibold text-[#f4f2ec]">{saInline(it.text)}</p>
              : <p key={n}>{saInline(it.text)}</p>
          )}
        </div>,
      );
    });
  });
  return <div className="space-y-4">{blocks}</div>;
}

// ---- small pieces -----------------------------------------------------------------
function SASpark({ size = 16, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 2.5l1.6 6.1 5.6-3-3 5.6 6.1 1.6-6.1 1.6 3 5.6-5.6-3L12 21.5l-1.6-6.1-5.6 3 3-5.6L1.7 11.2l6.1-1.6-3-5.6 5.6 3z" />
    </svg>
  );
}

function SiteAgentIcon({ size = 16, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="M12 8V4" />
      <circle cx="12" cy="3" r="1" />
      <path d="M8 14h.01M16 14h.01M9 17h6" />
    </svg>
  );
}

function SAAvatar({ busy }) {
  return (
    <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 bg-[#d97757]/15">
      <SASpark size={15} className={saCx("text-[#d97757]", busy && "animate-spin")} />
    </div>
  );
}

// Reveals text progressively, like Claude writing a reply.
function SAStreamText({ text, animate }) {
  const full = String(text || "");
  const [shown, setShown] = React.useState(animate ? 0 : full.length);
  React.useEffect(() => {
    const reduce = typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!animate || reduce) {
      setShown(full.length);
      return undefined;
    }
    setShown(0);
    const step = Math.max(3, Math.ceil(full.length / 110)); // about 2 seconds for any length
    const t = setInterval(() => {
      setShown((n) => {
        const next = Math.min(full.length, n + step);
        if (next >= full.length) clearInterval(t);
        return next;
      });
    }, 18);
    return () => clearInterval(t);
  }, [full, animate]);
  const streaming = shown < full.length;
  return (
    <div>
      <SAMarkdown text={streaming ? full.slice(0, shown) : full} />
      {streaming && <span className="inline-block w-2 h-2 ml-1 rounded-full bg-[#d97757] animate-pulse align-middle" />}
    </div>
  );
}

function SAFeedMessage({ msg, animate }) {
  const [copied, setCopied] = React.useState(false);
  const kind = SA_KIND[msg.kind] || SA_KIND.system;
  const copy = () => {
    const text = msg.title + "\n\n" + msg.body;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }).catch(() => {});
    }
  };
  return (
    <div className="flex gap-3 group">
      <SAAvatar busy={false} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap text-xs mb-1.5">
          <span className="font-medium text-[#ececea]">Site Agent</span>
          <span className={SA_C.faint}>{saTime(msg.created_at)}</span>
          <span className={saCx("rounded-full px-2 py-0.5 text-[10.5px] font-medium", kind.cls)}>{kind.label}</span>
        </div>
        <div className="font-serif text-[15.5px] leading-7 text-[#e5e2d9]">
          <p className="font-semibold text-[#f4f2ec] mb-2">{msg.title}</p>
          <SAStreamText text={msg.body} animate={animate} />
        </div>
        <div className="mt-1.5 h-6 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={copy} className="text-[11px] text-[#9b9890] hover:text-[#ececea] px-1.5 py-0.5 rounded hover:bg-[#3a3a36]">
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- the panel -------------------------------------------------------------------
function SiteAgentPanel({ client, supabaseUrl, anonKey }) {
  // All hooks first - no early returns above this block.
  const [tab, setTab] = React.useState("messages");
  const [messages, setMessages] = React.useState([]);
  const [hasMore, setHasMore] = React.useState(false);
  const [animateFrom, setAnimateFrom] = React.useState(Infinity); // ids above this stream in
  const [summary, setSummary] = React.useState({ alerts: [], approvals: [], health: { full: [], quick: [] }, autonomy: "" });
  const [loaded, setLoaded] = React.useState(false);
  const [checking, setChecking] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [showJump, setShowJump] = React.useState(false);
  const scrollRef = React.useRef(null);
  const lastIdRef = React.useRef(0);
  const nearBottomRef = React.useRef(true);

  const call = React.useCallback(async (body) => {
    const { data } = await client.auth.getSession();
    const token = data && data.session && data.session.access_token;
    if (!token) throw new Error("Your session has expired - please sign in again.");
    const res = await fetch(supabaseUrl + "/functions/v1/site-agent-api", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: "Bearer " + token },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || json.message || "Request failed (" + res.status + ")");
    return json;
  }, [client, supabaseUrl, anonKey]);

  const scrollToBottom = React.useCallback((smooth) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    setShowJump(false);
  }, []);

  const loadInitial = React.useCallback(async () => {
    try {
      const res = await call({ action: "messages" });
      const rows = res.messages || [];
      setMessages(rows);
      setHasMore(!!res.has_more);
      lastIdRef.current = rows.length ? rows[rows.length - 1].id : 0;
      setAnimateFrom(lastIdRef.current); // only messages that arrive from now on stream in
      setLoaded(true);
      setTimeout(() => scrollToBottom(false), 0);
    } catch (e) {
      setError(e.message);
    }
  }, [call, scrollToBottom]);

  const loadNew = React.useCallback(async () => {
    try {
      const res = await call({ action: "messages", after_id: lastIdRef.current });
      const rows = res.messages || [];
      if (!rows.length) return 0;
      lastIdRef.current = rows[rows.length - 1].id;
      setMessages((prev) => prev.concat(rows.filter((r) => !prev.some((p) => p.id === r.id))));
      if (nearBottomRef.current) setTimeout(() => scrollToBottom(true), 50);
      else setShowJump(true);
      return rows.length;
    } catch (e) {
      setError(e.message);
      return 0;
    }
  }, [call, scrollToBottom]);

  const loadOlder = React.useCallback(async () => {
    if (!messages.length) return;
    try {
      const el = scrollRef.current;
      const before = el ? el.scrollHeight : 0;
      const res = await call({ action: "messages", before_id: messages[0].id });
      setMessages((prev) => (res.messages || []).concat(prev));
      setHasMore(!!res.has_more);
      setTimeout(() => {
        if (el) el.scrollTop = el.scrollHeight - before;
      }, 0);
    } catch (e) {
      setError(e.message);
    }
  }, [call, messages]);

  const loadSummary = React.useCallback(async () => {
    try {
      setSummary(await call({ action: "summary" }));
    } catch (e) {
      setError(e.message);
    }
  }, [call]);

  React.useEffect(() => {
    loadInitial();
    loadSummary();
  }, [loadInitial, loadSummary]);

  React.useEffect(() => {
    const t1 = setInterval(() => {
      if (!document.hidden) loadNew();
    }, SA_POLL_MESSAGES_MS);
    const t2 = setInterval(() => {
      if (!document.hidden) loadSummary();
    }, SA_POLL_SUMMARY_MS);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [loadNew, loadSummary]);

  React.useEffect(() => {
    if (tab === "messages") setTimeout(() => scrollToBottom(false), 0);
  }, [tab, scrollToBottom]);

  // ---- actions ----
  async function act(fn) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const runCheck = () => act(async () => {
    setTab("messages");
    setChecking(true);
    setTimeout(() => scrollToBottom(true), 50);
    try {
      await call({ action: "run_check", kind: "daily" });
      await loadNew();
      await loadSummary();
    } finally {
      setChecking(false);
    }
  });

  const decide = (id, action) => act(async () => {
    const note = action === "reject" ? (window.prompt("Optional: tell the agent why (or leave empty)") || "") : "";
    await call({ action, approval_id: id, note: note || undefined });
    await loadSummary();
  });

  const setAlert = (id, status) => act(async () => {
    await call({ action: "update_alert", alert_id: id, status });
    await loadSummary();
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottomRef.current) setShowJump(false);
  };

  const alerts = summary.alerts || [];
  const approvals = summary.approvals || [];
  const critical = alerts.filter((a) => a.severity === "critical").length;
  const tabCls = (active) => saCx(
    "px-3 py-1.5 text-sm rounded-lg transition-colors whitespace-nowrap",
    active ? "bg-[#3a3a36] text-[#f4f2ec]" : "text-[#9b9890] hover:text-[#ececea] hover:bg-[#30302d]",
  );
  const btn = "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium border border-[#3d3d3a] text-[#d6d3ca] hover:bg-[#30302d] transition-colors disabled:opacity-50";
  const btnPrimary = "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium bg-[#d97757] text-white hover:bg-[#c96a4b] transition-colors disabled:opacity-50";

  let lastDay = "";

  return (
    <div className={saCx("flex flex-col h-[calc(100vh-7rem)] min-h-[560px] rounded-xl overflow-hidden border", SA_C.bg, SA_C.border, SA_C.text)}>
      {/* header */}
      <div className={saCx("flex items-center gap-2 px-4 py-2.5 border-b flex-wrap", SA_C.border)}>
        <div className="flex items-center gap-2 font-medium mr-2">
          <SASpark size={16} className="text-[#d97757]" /> Site Agent
        </div>
        <div className="flex gap-1 flex-1 flex-wrap">
          <button className={tabCls(tab === "messages")} onClick={() => setTab("messages")}>Messages</button>
          <button className={tabCls(tab === "alerts")} onClick={() => setTab("alerts")}>
            Alerts{alerts.length > 0 && (
              <span className={saCx("ml-1.5 rounded-full px-1.5 text-[10px] text-white", critical ? "bg-red-600" : "bg-amber-600")}>{alerts.length}</span>
            )}
          </button>
          {approvals.length > 0 && (
            <button className={tabCls(tab === "approvals")} onClick={() => setTab("approvals")}>
              Approvals<span className="ml-1.5 rounded-full px-1.5 text-[10px] text-white bg-red-600">{approvals.length}</span>
            </button>
          )}
          <button className={tabCls(tab === "health")} onClick={() => setTab("health")}>Health</button>
        </div>
        {typeof summary.ai_spend_month_usd === "number" && (
          <span
            className="text-[11px] text-[#9b9890] border border-[#3d3d3a] rounded-full px-2 py-0.5"
            title="Estimated Claude API spend this month. Reports and checks are free; AI is only used to explain new problems."
          >
            AI this month ${summary.ai_spend_month_usd.toFixed(2)}{summary.ai_budget_usd > 0 ? " / $" + summary.ai_budget_usd.toFixed(2) : ""}
          </span>
        )}
        <button className={btnPrimary} disabled={busy} onClick={runCheck} title="Run the full check now (rule-based, free unless a new problem is found)">
          Run check now
        </button>
      </div>

      {error && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-red-950/50 border border-red-900/70 text-red-300 text-sm cursor-pointer" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {/* messages thread */}
      {tab === "messages" && (
        <div className="relative flex-1 min-h-0">
          <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
            <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-7">
              {hasMore && (
                <div className="text-center">
                  <button className={btn} onClick={loadOlder}>Load earlier messages</button>
                </div>
              )}
              {loaded && !messages.length && !checking && (
                <div className="text-center py-16 space-y-3">
                  <SASpark size={28} className="text-[#d97757] mx-auto" />
                  <div className="font-serif text-xl text-[#ececea]">No messages yet</div>
                  <div className="text-sm text-[#9b9890]">The first morning report arrives at 8:00. Alerts appear here the moment something breaks.</div>
                  <button className={btnPrimary} disabled={busy} onClick={runCheck}>Run check now</button>
                </div>
              )}
              {messages.map((m) => {
                const day = saDayLabel(m.created_at);
                const divider = day !== lastDay;
                lastDay = day;
                return (
                  <div key={m.id}>
                    {divider && (
                      <div className="flex items-center gap-3 mb-6">
                        <div className="h-px flex-1 bg-[#3d3d3a]" />
                        <span className="text-[11px] text-[#75726b]">{day}</span>
                        <div className="h-px flex-1 bg-[#3d3d3a]" />
                      </div>
                    )}
                    <SAFeedMessage msg={m} animate={m.id > animateFrom} />
                  </div>
                );
              })}
              {checking && (
                <div className="flex gap-3">
                  <SAAvatar busy={true} />
                  <div className="text-sm text-[#9b9890] pt-1 animate-pulse">Running checks…</div>
                </div>
              )}
              <div className="text-center text-[11px] text-[#75726b] pt-2">
                Site Agent posts its reports and alerts here and on Telegram.
              </div>
            </div>
          </div>
          {showJump && (
            <button
              onClick={() => scrollToBottom(true)}
              className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full px-3 py-1.5 text-xs bg-[#3a3a36] text-[#f4f2ec] border border-[#4a4a45] shadow-lg"
            >
              New messages ↓
            </button>
          )}
        </div>
      )}

      {tab === "alerts" && (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-3">
            {!alerts.length && <div className="text-center text-[#9b9890] py-10">No open alerts. ✅</div>}
            {alerts.map((a) => (
              <div key={a.id} className={saCx("bg-[#1f1e1d] border border-[#3d3d3a] border-l-4 rounded-lg p-3", SA_SEV_BORDER[a.severity])}>
                <div className="flex justify-between gap-3 flex-wrap mb-1">
                  <div className="text-[#f4f2ec] font-medium">{SA_SEV_ICON[a.severity]} {a.title}</div>
                  <div className="text-[11px] text-[#75726b]">
                    #{a.id} · since {saAgo(a.first_seen_at)}{a.occurrences > 1 ? " · seen " + a.occurrences + "×" : ""}{a.status === "acknowledged" ? " · acknowledged" : ""}
                  </div>
                </div>
                {a.ai_note && (
                  <div className="font-serif text-[14.5px] leading-6 text-[#e5e2d9] mt-2">
                    <SAMarkdown text={a.ai_note} />
                  </div>
                )}
                {a.body && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-[#9b9890]">Check details</summary>
                    <pre className="font-mono text-[12px] bg-[#262624] border border-[#3d3d3a] rounded p-2 mt-1 overflow-auto max-h-64 whitespace-pre-wrap">{a.body}</pre>
                  </details>
                )}
                <div className="flex gap-2 mt-2 flex-wrap">
                  {a.status === "open" && <button className={btn} disabled={busy} onClick={() => setAlert(a.id, "acknowledged")}>Acknowledge</button>}
                  <button className={btn} disabled={busy} onClick={() => setAlert(a.id, "resolved")}>Resolve</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "approvals" && (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-3">
            {!approvals.length && <div className="text-center text-[#9b9890] py-10">Nothing is waiting for your approval.</div>}
            {approvals.map((a) => (
              <div key={a.id} className="bg-[#1f1e1d] border border-[#3d3d3a] border-l-4 border-l-amber-500 rounded-lg p-3">
                <div className="flex justify-between gap-3 flex-wrap mb-1">
                  <div className="text-[#f4f2ec] font-medium">🔐 #{a.id} · {a.tool_name}</div>
                  <div className="text-[11px] text-[#75726b]">{saAgo(a.created_at)}</div>
                </div>
                <div className="font-serif text-[14.5px] leading-6 text-[#e5e2d9]"><SAMarkdown text={a.reason} /></div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-[#9b9890]">Exact action</summary>
                  <pre className="font-mono text-[12px] bg-[#262624] border border-[#3d3d3a] rounded p-2 mt-1 overflow-auto max-h-72 whitespace-pre-wrap">
                    {a.tool_input && typeof a.tool_input.sql === "string" ? a.tool_input.sql : saPretty(a.tool_input)}
                  </pre>
                </details>
                <div className="flex gap-2 mt-3">
                  <button className={btnPrimary} disabled={busy} onClick={() => decide(a.id, "approve")}>Approve &amp; run</button>
                  <button className={btn} disabled={busy} onClick={() => decide(a.id, "reject")}>Reject</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "health" && (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-5">
            {!summary.health.full.length && !summary.health.quick.length && (
              <div className="text-center text-[#9b9890] py-10">No health checks yet. Press “Run check now”.</div>
            )}
            {[["Quick monitor (every 15 min)", summary.health.quick], ["Full check", summary.health.full]].map(([label, rows]) => (
              rows && rows.length > 0 ? (
                <div key={label}>
                  <div className="text-xs text-[#9b9890] mb-1">{label} · {saAgo(rows[0].created_at)}</div>
                  <div className="divide-y divide-[#3d3d3a] border border-[#3d3d3a] rounded-lg bg-[#1f1e1d]">
                    {rows.slice().sort((x, y) => SA_STATUS_ORDER.indexOf(x.status) - SA_STATUS_ORDER.indexOf(y.status)).map((h) => (
                      <div key={h.check_name} className="grid grid-cols-[1.5rem_1fr] md:grid-cols-[1.5rem_16rem_1fr] gap-2 px-3 py-2 text-sm">
                        <span>{SA_STATUS_ICON[h.status]}</span>
                        <span className="font-mono text-xs text-[#d6d3ca] break-all">{h.check_name.replace(/^rule:/, "")}</span>
                        <span className="text-[#a9a69e] col-start-2 md:col-start-auto">{h.summary}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
