import { postgres } from "./deps.ts";
import { config } from "./config.ts";

// Direct Postgres connection (SUPABASE_DB_URL is provided automatically to every
// Edge Function). prepare:false keeps it compatible with the transaction pooler.
let client: postgres.Sql | null = null;

export function db(): postgres.Sql {
  if (!client) {
    if (!config.dbUrl) throw new Error("SUPABASE_DB_URL is not set");
    const asText = (oid: number) => ({ to: oid, from: [oid], serialize: (x: unknown) => String(x), parse: (x: string) => x });
    client = postgres(config.dbUrl, {
      prepare: false,
      max: 4,
      idle_timeout: 20,
      connect_timeout: 15,
      onnotice: () => {},
      types: {
        // Keep dates/timestamps exactly as Postgres prints them (no JS timezone shifts).
        date: asText(1082),
        timestamp: asText(1114),
        timestamptz: asText(1184),
        // bigint ids/counts as plain numbers (safe far beyond any realistic row count).
        int8: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
      },
    });
  }
  return client;
}

/**
 * postgres.js honours `{ simple }` at runtime but doesn't declare it in its types.
 * simple:false forces the extended protocol, which Postgres limits to ONE statement.
 */
export const protocol = (simple: boolean) => ({ simple }) as unknown as postgres.UnsafeQueryOptions;

/** JSON.stringify that survives bigint / Date / Buffer values coming from Postgres. */
export function toJson(value: unknown, space?: number): string {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
      return v;
    },
    space,
  );
}

/** Keep tool output inside a sane size so one big result can't flood the context. */
export function clip(text: string, max = 16_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} more characters]`;
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    // postgres.js errors carry useful extra fields
    const pg = e as Error & { detail?: string; hint?: string; code?: string; position?: string };
    const parts = [pg.message];
    if (pg.code) parts.push(`(code ${pg.code})`);
    if (pg.detail) parts.push(`detail: ${pg.detail}`);
    if (pg.hint) parts.push(`hint: ${pg.hint}`);
    return parts.join(" ");
  }
  return String(e);
}
