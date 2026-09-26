// Sends messages to the owners/team on every configured channel:
// Telegram, email (Resend), SMS/WhatsApp (Twilio) and Slack/Discord webhooks.
// Channels without credentials are simply skipped.

import { config, type Severity, severityAtLeast } from "./config.ts";

export interface Notice {
  title: string;
  body: string;
  severity: Severity;
  kind: "alert" | "report" | "approval" | "recovery" | "system";
  /** Send even if below NOTIFY_MIN_SEVERITY (reports, approvals, explicit agent messages). */
  force?: boolean;
}

const ICON: Record<Notice["kind"], (s: Severity) => string> = {
  alert: (s) => (s === "critical" ? "🔴" : s === "warning" ? "🟡" : "ℹ️"),
  report: () => "📋",
  approval: () => "🔐",
  recovery: () => "✅",
  system: () => "🤖",
};

export function formatNotice(n: Notice): string {
  const link = config.notify.dashboardUrl ? `\n\nOpen dashboard: ${config.notify.dashboardUrl}` : "";
  return `${ICON[n.kind](n.severity)} ${n.title}\n\n${n.body.trim()}${link}`;
}

function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

async function post(url: string, init: RequestInit): Promise<void> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  await res.body?.cancel();
}

export async function sendTelegram(chatId: string, text: string): Promise<void> {
  const token = config.notify.telegramBotToken;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  for (const part of chunks(text, 4000)) {
    await post(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: part, disable_web_page_preview: true }),
    });
  }
}

async function sendEmail(subject: string, text: string): Promise<void> {
  const n = config.notify;
  await post("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${n.resendApiKey}` },
    body: JSON.stringify({
      from: n.emailFrom,
      to: n.emailTo,
      subject,
      text,
      html: `<pre style="font-family:ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;font-size:14px">${
        text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      }</pre>`,
    }),
  });
}

async function sendTwilio(text: string): Promise<void> {
  const n = config.notify;
  // SMS / WhatsApp bodies are limited to 1600 characters.
  const body = text.length > 1500 ? `${text.slice(0, 1450)}\n…(full text in the dashboard)` : text;
  const auth = btoa(`${n.twilioSid}:${n.twilioToken}`);
  for (const to of n.twilioTo) {
    await post(`https://api.twilio.com/2010-04-01/Accounts/${n.twilioSid}/Messages.json`, {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: n.twilioFrom, Body: body }),
    });
  }
}

async function sendWebhook(text: string): Promise<void> {
  const url = config.notify.webhookUrl;
  const isDiscord = /discord(app)?\.com\/api\/webhooks/.test(url);
  for (const part of chunks(text, isDiscord ? 1900 : 3500)) {
    await post(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(isDiscord ? { content: part } : { text: part }),
    });
  }
}

/** Returns one status line per channel (useful for the agent and for logs). */
export async function notifyOwners(n: Notice): Promise<string[]> {
  if (!n.force && !severityAtLeast(n.severity, config.notify.minSeverity)) {
    return [
      `not sent: severity "${n.severity}" is below NOTIFY_MIN_SEVERITY (${config.notify.minSeverity}); visible in the dashboard`,
    ];
  }
  const text = formatNotice(n);
  const c = config.notify;
  const jobs: Array<[string, () => Promise<void>]> = [];
  if (c.telegramBotToken && c.telegramChatIds.length) {
    jobs.push(["telegram", async () => {
      for (const id of c.telegramChatIds) await sendTelegram(id, text);
    }]);
  }
  if (c.resendApiKey && c.emailFrom && c.emailTo.length) jobs.push(["email", () => sendEmail(n.title, text)]);
  if (c.twilioSid && c.twilioToken && c.twilioFrom && c.twilioTo.length) jobs.push(["sms/whatsapp", () => sendTwilio(text)]);
  if (c.webhookUrl) jobs.push(["webhook", () => sendWebhook(text)]);

  if (jobs.length === 0) return ["no notification channels configured (dashboard only)"];

  const results = await Promise.allSettled(jobs.map(([, fn]) => fn()));
  return results.map((r, i) => {
    const name = jobs[i][0];
    if (r.status === "fulfilled") return `${name}: sent`;
    console.error(`notify ${name} failed`, r.reason);
    return `${name}: FAILED (${r.reason instanceof Error ? r.reason.message : String(r.reason)})`;
  });
}
