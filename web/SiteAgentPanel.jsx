// =============================================================================
// Site Agent panel for LogistiX (index.html)
// =============================================================================
// Paste this whole block into index.html's existing <script type="text/babel">,
// at MODULE SCOPE (outside every component, e.g. just before the main App
// component). It uses only globals the page already loads: React 18 UMD +
// Tailwind CDN. It does NOT use the Supabase client for data - it only asks it
// for the signed-in user's access token and talks to the site-agent-chat Edge
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

const SA_POLL_WORKING_MS = 2500;
const SA_POLL_IDLE_MS = 20000;
const SA_STATUS_ORDER = ["fail", "warn", "ok", "skipped"];
const SA_STATUS_ICON = { ok: "✅", warn: "🟡", fail: "🔴", skipped: "⚪" };
const SA_SEV_ICON = { critical: "🔴", warning: "🟡", info: "ℹ️" };
const SA_SEV_BORDER = { critical: "border-l-red-500", warning: "border-l-amber-500", info: "border-l-blue-500" };

function saCx(...a) {
  return a.filter(Boolean).join(" ");
}

function saAgo(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return new Date(iso).toLocaleDateString();
}

function saPretty(v) {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch (e) {
    return String(v);
  }
}

function saResultText(block) {
  if (!block) return "";
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (b && typeof b.text === "string" ? b.text : saPretty(b))).join("\n");
  return saPretty(c);
}

// ---- tiny markdown renderer (React elements only - no innerHTML) -------------
function saInline(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={i++} className="text-white">{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("*")) out.push(<strong key={i++} className="text-white">{tok.slice(1, -1)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={i++} className="px-1 rounded bg-slate-800 text-[0.92em]">{tok.slice(1, -1)}</code>);
    else out.push(<a key={i++} href={tok} target="_blank" rel="noreferrer" className="text-blue-400 underline">{tok}</a>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function SAMarkdown({ text }) {
  const parts = String(text || "").split(/```[a-zA-Z]*\n?/);
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {parts.map((part, idx) => {
        if (idx % 2 === 1) {
          return (
            <pre key={idx} className="bg-slate-950 border border-slate-800 rounded-md p-2 text-xs overflow-auto whitespace-pre-wrap">
              {part.replace(/\n$/, "")}
            </pre>
          );
        }
        return part.split(/\n{2,}/).map((para, j) => {
          const lines = para.split("\n").filter((l) => l.trim() !== "");
          if (!lines.length) return null;
          if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l))) {
            return (
              <ul key={idx + "-" + j} className="list-disc pl-5 space-y-0.5">
                {lines.map((l, k) => <li key={k}>{saInline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""))}</li>)}
              </ul>
            );
          }
          return (
            <p key={idx + "-" + j}>
              {lines.map((l, k) => (
                <span key={k}>
                  {/^#{1,4}\s/.test(l) ? <strong className="text-white">{saInline(l.replace(/^#{1,4}\s/, ""))}</strong> : saInline(l)}
                  {k < lines.length - 1 && <br />}
                </span>
              ))}
            </p>
          );
        });
      })}
    </div>
  );
}

// ---- one tool call ("step") with its result ------------------------------------
function SAToolStep({ call, result }) {
  const input = call.input || {};
  const summary = typeof input.sql === "string"
    ? input.sql.replace(/\s+/g, " ").slice(0, 90)
    : input.url || input.title || input.path || input.grep || "";
  const failed = result && result.is_error === true;
  return (
    <details className={saCx("max-w-3xl w-full rounded-lg border text-xs bg-slate-900/60", failed ? "border-red-900" : "border-slate-800")}>
      <summary className="cursor-pointer px-3 py-1.5 flex gap-2 items-center text-slate-400 select-none">
        <span>{!result ? "⏳" : failed ? "⚠️" : "🔧"}</span>
        <span className="font-mono text-slate-200">{String(call.name)}</span>
        {summary && <span className="truncate">{String(summary)}</span>}
      </summary>
      <div className="px-3 pb-2">
        <div className="text-[10px] uppercase tracking-wide text-slate-500 mt-1">Input</div>
        <pre className="bg-slate-950 border border-slate-800 rounded p-2 overflow-auto max-h-64 whitespace-pre-wrap">{saPretty(input)}</pre>
        {result && (
          <>
            <div className="text-[10px] uppercase tracking-wide text-slate-500 mt-1">Result</div>
            <pre className="bg-slate-950 border border-slate-800 rounded p-2 overflow-auto max-h-64 whitespace-pre-wrap">
              {saResultText(result).slice(0, 8000)}
            </pre>
          </>
        )}
      </div>
    </details>
  );
}

function SAMessageList({ messages }) {
  const results = React.useMemo(() => {
    const map = {};
    (messages || []).forEach((m) => {
      if (m.role !== "user") return;
      (m.content || []).forEach((b) => {
        if (b.type === "tool_result") map[b.tool_use_id] = b;
      });
    });
    return map;
  }, [messages]);

  return (
    <>
      {(messages || []).map((m) => {
        if (m.role === "user") {
          if (m.display_text) {
            return (
              <div key={m.id} className="self-end max-w-3xl bg-blue-600/20 border border-blue-600/40 text-slate-100 rounded-2xl rounded-br-sm px-4 py-2">
                <SAMarkdown text={m.display_text} />
              </div>
            );
          }
          const texts = (m.content || []).filter((b) => b.type === "text").map((b) => String(b.text));
          if (!texts.length) return null; // only tool results - shown with their tool calls
          const text = texts.join("\n\n");
          return (
            <details key={m.id} className="self-center max-w-3xl text-xs text-slate-500">
              <summary className="cursor-pointer">🤖 {text.split("\n")[0].replace(/^\[|\]$/g, "").slice(0, 140)}</summary>
              <pre className="whitespace-pre-wrap bg-slate-900/60 border border-slate-800 rounded p-2 mt-1">{text}</pre>
            </details>
          );
        }
        return (
          <div key={m.id} className="flex flex-col gap-1.5 items-start">
            {(m.content || []).map((b, i) => {
              if (b.type === "text" && String(b.text).trim()) {
                return (
                  <div key={i} className="max-w-3xl bg-slate-900 border border-slate-800 text-slate-200 rounded-2xl rounded-bl-sm px-4 py-2">
                    <SAMarkdown text={b.text} />
                  </div>
                );
              }
              if (b.type === "tool_use") return <SAToolStep key={i} call={b} result={results[b.id]} />;
              if (b.type === "server_tool_use") {
                const q = b.input && b.input.query;
                return <div key={i} className="text-xs text-slate-500 px-1">🔎 Web search{q ? ": " + q : ""}</div>;
              }
              if (b.type === "compaction") return <div key={i} className="text-xs text-slate-500 px-1">🗜️ Earlier conversation summarised</div>;
              return null;
            })}
          </div>
        );
      })}
    </>
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

// ---- the panel -------------------------------------------------------------------
function SiteAgentPanel({ client, supabaseUrl, anonKey }) {
  // All hooks first - no early returns above this block.
  const [tab, setTab] = React.useState("chat");
  const [summary, setSummary] = React.useState({ conversations: [], alerts: [], approvals: [], health: { full: [], quick: [] }, autonomy: "" });
  const [selected, setSelected] = React.useState(null);
  const [conv, setConv] = React.useState({ messages: [], run: null });
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [loaded, setLoaded] = React.useState(false);
  const bottomRef = React.useRef(null);

  const call = React.useCallback(async (body) => {
    const { data } = await client.auth.getSession();
    const token = data && data.session && data.session.access_token;
    if (!token) throw new Error("Your session has expired - please sign in again.");
    const res = await fetch(supabaseUrl + "/functions/v1/site-agent-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: anonKey, Authorization: "Bearer " + token },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || json.message || "Request failed (" + res.status + ")");
    return json;
  }, [client, supabaseUrl, anonKey]);

  const loadSummary = React.useCallback(async () => {
    try {
      setSummary(await call({ action: "summary" }));
      setLoaded(true);
    } catch (e) {
      setError(e.message);
    }
  }, [call]);

  const loadConversation = React.useCallback(async (id) => {
    if (!id) return;
    try {
      setConv(await call({ action: "get_conversation", conversation_id: id }));
    } catch (e) {
      setError(e.message);
    }
  }, [call]);

  const run = conv.run;
  const working = !!run && (run.status === "queued" || run.status === "running");

  React.useEffect(() => {
    loadSummary();
    const t = setInterval(() => {
      if (!document.hidden) loadSummary();
    }, SA_POLL_IDLE_MS);
    return () => clearInterval(t);
  }, [loadSummary]);

  React.useEffect(() => {
    if (selected) loadConversation(selected);
    else setConv({ messages: [], run: null });
  }, [selected, loadConversation]);

  React.useEffect(() => {
    if (!selected || !working) return undefined;
    const t = setInterval(() => loadConversation(selected), SA_POLL_WORKING_MS);
    return () => clearInterval(t);
  }, [selected, working, loadConversation]);

  // When a run finishes, refresh alerts/approvals too.
  React.useEffect(() => {
    if (!working && selected) loadSummary();
  }, [working, selected, loadSummary]);

  React.useEffect(() => {
    if (bottomRef.current) bottomRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [conv.messages.length, working]);

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

  const send = () => act(async () => {
    const message = draft.trim();
    if (!message || working) return;
    const res = await call({ action: "send", message, conversation_id: selected || undefined });
    setDraft("");
    if (res.conversation_id !== selected) setSelected(res.conversation_id);
    else await loadConversation(res.conversation_id);
    loadSummary();
  });

  const stop = () => act(async () => {
    if (run) await call({ action: "stop", run_id: run.id });
    await loadConversation(selected);
  });

  const decide = (id, action) => act(async () => {
    const note = action === "reject" ? (window.prompt("Optional: tell the agent why (or leave empty)") || "") : "";
    await call({ action, approval_id: id, note: note || undefined });
    await loadSummary();
  });

  const runFullCheck = () => act(async () => {
    const res = await call({ action: "run_check", kind: "daily" });
    setTab("chat");
    setSelected(res.conversation_id);
    loadSummary();
  });

  const setAlert = (id, status) => act(async () => {
    await call({ action: "update_alert", alert_id: id, status });
    await loadSummary();
  });

  const askAbout = (a) => {
    setTab("chat");
    setSelected(null);
    setDraft('Look into alert #' + a.id + ' ("' + a.title + '") and fix it if you can.');
  };

  const alerts = summary.alerts || [];
  const approvals = summary.approvals || [];
  const critical = alerts.filter((a) => a.severity === "critical").length;
  const tabCls = (active) => saCx(
    "px-3 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
    active ? "border-blue-600 text-white" : "border-transparent text-slate-500 hover:text-slate-300",
  );
  const btn = "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium bg-slate-900 border border-slate-800 text-slate-300 hover:bg-slate-800 transition-colors disabled:opacity-50";
  const btnPrimary = "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-50";

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)] min-h-[560px] bg-slate-950 text-slate-200 border border-slate-800 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 border-b border-slate-800 bg-slate-900/50 flex-wrap">
        <div className="flex items-center gap-2 py-2 font-semibold text-white">
          <SiteAgentIcon size={18} className="text-blue-400" /> Site Agent
          {summary.autonomy && (
            <span className="text-[10px] font-normal uppercase tracking-wide text-slate-500 border border-slate-800 rounded px-1.5 py-0.5">
              {summary.autonomy === "readonly" ? "approve every change" : summary.autonomy}
            </span>
          )}
          {typeof summary.ai_spend_month_usd === "number" && (
            <span
              className="text-[10px] font-normal text-slate-500 border border-slate-800 rounded px-1.5 py-0.5"
              title="Estimated Claude API spend this month (checks and reports are free; AI is only used for your questions and to explain new problems)"
            >
              AI this month ${summary.ai_spend_month_usd.toFixed(2)}{summary.ai_budget_usd > 0 ? " / $" + summary.ai_budget_usd.toFixed(2) : ""}
            </span>
          )}
        </div>
        <div className="flex gap-1 flex-1 flex-wrap">
          <button className={tabCls(tab === "chat")} onClick={() => setTab("chat")}>Chat</button>
          <button className={tabCls(tab === "alerts")} onClick={() => setTab("alerts")}>
            Alerts{alerts.length > 0 && (
              <span className={saCx("ml-1.5 rounded-full px-1.5 text-[10px] text-white", critical ? "bg-red-600" : "bg-amber-600")}>{alerts.length}</span>
            )}
          </button>
          <button className={tabCls(tab === "approvals")} onClick={() => setTab("approvals")}>
            Approvals{approvals.length > 0 && <span className="ml-1.5 rounded-full px-1.5 text-[10px] text-white bg-red-600">{approvals.length}</span>}
          </button>
          <button className={tabCls(tab === "health")} onClick={() => setTab("health")}>Health</button>
        </div>
        <button className={btn} disabled={busy} onClick={runFullCheck} title="Run the full morning check now (rule-based, no AI cost unless a new problem is found)">
          {busy ? "Working…" : "Run full check"}
        </button>
      </div>

      {error && (
        <div className="mx-4 mt-3 px-3 py-2 rounded-lg bg-red-950/60 border border-red-900 text-red-300 text-sm cursor-pointer" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {tab === "chat" && (
        <div className="flex flex-1 min-h-0 flex-col md:flex-row">
          <div className="md:w-60 shrink-0 border-b md:border-b-0 md:border-r border-slate-800 overflow-y-auto p-2 flex md:flex-col gap-1 max-h-40 md:max-h-none">
            <button className={saCx(btnPrimary, "justify-center mb-1 shrink-0")} onClick={() => setSelected(null)}>+ New chat</button>
            {(summary.conversations || []).map((c) => (
              <button
                key={c.id}
                onClick={() => setSelected(c.id)}
                className={saCx("text-left rounded-md px-2 py-1.5 shrink-0 md:shrink", c.id === selected ? "bg-slate-800" : "hover:bg-slate-900")}
              >
                <div className="text-xs text-slate-200 truncate max-w-[14rem]">
                  {c.source === "system" ? "🤖 " : c.source === "telegram" ? "✈️ " : ""}{c.title}
                </div>
                <div className="text-[10px] text-slate-500">{saAgo(c.updated_at)}</div>
              </button>
            ))}
          </div>

          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
              {!selected && (
                <div className="text-center text-slate-500 py-10 text-sm space-y-2">
                  <div className="text-slate-300 font-medium">Ask anything about the site and your data.</div>
                  <div>“Which containers are running late?” · “Check the website for broken pages” · “Why did the fuel price stop updating?” · “Summarise today's orders”</div>
                  <div className="text-xs">Each question costs a few cents of AI time. Morning reports and alerts are free.</div>
                </div>
              )}
              <SAMessageList messages={conv.messages} />
              {working && (
                <div className="flex items-center gap-3 text-slate-400 text-sm">
                  <span className="animate-pulse">● ● ●</span> Working…
                  <button className={btn} onClick={stop}>Stop</button>
                </div>
              )}
              {run && run.status === "error" && (
                <div className="px-3 py-2 rounded-lg bg-red-950/60 border border-red-900 text-red-300 text-sm">The agent hit an error: {run.error}</div>
              )}
              <div ref={bottomRef} />
            </div>
            <div className="flex gap-2 p-3 border-t border-slate-800 items-end">
              <textarea
                value={draft}
                rows={2}
                disabled={working}
                placeholder={working ? "The agent is working…" : "Message Site Agent (Enter to send, Shift+Enter for a new line)"}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                className="flex-1 resize-y min-h-[42px] max-h-48 rounded-lg bg-slate-900 border border-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-blue-600"
              />
              <button className={btnPrimary} disabled={busy || working || !draft.trim()} onClick={send}>Send</button>
            </div>
          </div>
        </div>
      )}

      {tab === "alerts" && (
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loaded && !alerts.length && <div className="text-center text-slate-500 py-10">No open alerts. ✅</div>}
          {alerts.map((a) => (
            <div key={a.id} className={saCx("bg-slate-900/50 border border-slate-800 border-l-4 rounded-lg p-3", SA_SEV_BORDER[a.severity])}>
              <div className="flex justify-between gap-3 flex-wrap mb-1">
                <div className="text-slate-100 font-medium">{SA_SEV_ICON[a.severity]} {a.title}</div>
                <div className="text-[11px] text-slate-500">
                  #{a.id} · {a.category} · {saAgo(a.last_seen_at)}{a.occurrences > 1 ? " · seen " + a.occurrences + "×" : ""}{a.status === "acknowledged" ? " · acknowledged" : ""}
                </div>
              </div>
              {a.body && <div className="text-slate-300"><SAMarkdown text={a.body} /></div>}
              <div className="flex gap-2 mt-2 flex-wrap">
                {a.status === "open" && <button className={btn} disabled={busy} onClick={() => setAlert(a.id, "acknowledged")}>Acknowledge</button>}
                <button className={btn} disabled={busy} onClick={() => setAlert(a.id, "resolved")}>Resolve</button>
                <button className={btn} onClick={() => askAbout(a)}>Ask agent</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "approvals" && (
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loaded && !approvals.length && <div className="text-center text-slate-500 py-10">Nothing is waiting for your approval.</div>}
          {approvals.map((a) => (
            <div key={a.id} className="bg-slate-900/50 border border-slate-800 border-l-4 border-l-amber-500 rounded-lg p-3">
              <div className="flex justify-between gap-3 flex-wrap mb-1">
                <div className="text-slate-100 font-medium">🔐 #{a.id} · {a.tool_name}</div>
                <div className="text-[11px] text-slate-500">{saAgo(a.created_at)}</div>
              </div>
              <div className="text-slate-300"><SAMarkdown text={a.reason} /></div>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-slate-500">Exact action</summary>
                <pre className="bg-slate-950 border border-slate-800 rounded p-2 mt-1 text-xs overflow-auto max-h-72 whitespace-pre-wrap">
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
      )}

      {tab === "health" && (
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {loaded && !summary.health.full.length && !summary.health.quick.length && (
            <div className="text-center text-slate-500 py-10">No health checks yet. Press “Run full check”.</div>
          )}
          {[["Quick monitor (every 15 min)", summary.health.quick], ["Full check", summary.health.full]].map(([label, rows]) => (
            rows && rows.length > 0 ? (
              <div key={label}>
                <div className="text-xs text-slate-500 mb-1">{label} · {saAgo(rows[0].created_at)}</div>
                <div className="divide-y divide-slate-800 border border-slate-800 rounded-lg bg-slate-900/40">
                  {rows.slice().sort((x, y) => SA_STATUS_ORDER.indexOf(x.status) - SA_STATUS_ORDER.indexOf(y.status)).map((h) => (
                    <div key={h.check_name} className="grid grid-cols-[1.5rem_1fr] md:grid-cols-[1.5rem_16rem_1fr] gap-2 px-3 py-2 text-sm">
                      <span>{SA_STATUS_ICON[h.status]}</span>
                      <span className="font-mono text-xs text-slate-300 break-all">{h.check_name.replace(/^rule:/, "")}</span>
                      <span className="text-slate-400 col-start-2 md:col-start-auto">{h.summary}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null
          ))}
        </div>
      )}
    </div>
  );
}
