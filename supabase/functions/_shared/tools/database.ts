import { clip, db, errorMessage, protocol, toJson } from "../db.ts";
import { config } from "../config.ts";
import { classifySql, stripTrailingSemicolons } from "../sql_guard.ts";
import { requestApproval } from "../approval_requests.ts";
import { type AgentTool, optBool, optNum, optStr, str } from "./types.ts";

class Rollback extends Error {
  constructor(readonly result: unknown) {
    super("rollback");
  }
}
class TooManyRows extends Error {
  constructor(readonly count: number) {
    super(`too many rows: ${count}`);
  }
}

type PgResult = unknown[] & { count?: number; command?: string };

/** Rows affected by a single- or multi-statement result from postgres.js. */
function affected(res: unknown): { count: number; commands: string[]; rows: unknown[] } {
  const parts: PgResult[] = Array.isArray(res) && res.length > 0 && Array.isArray(res[0]) && (res as PgResult).count === undefined
    ? (res as PgResult[])
    : [res as PgResult];
  let count = 0;
  const commands: string[] = [];
  let rows: unknown[] = [];
  for (const p of parts) {
    count += typeof p.count === "number" ? p.count : 0;
    if (p.command) commands.push(p.command);
    if (Array.isArray(p) && p.length) rows = p;
  }
  return { count, commands, rows };
}

function rowsPreview(rows: unknown[], max = 50): string {
  if (!rows.length) return "";
  return `\nReturned rows${rows.length > max ? ` (first ${max} of ${rows.length})` : ""}:\n${toJson(rows.slice(0, max))}`;
}

// -----------------------------------------------------------------------------

const dbSchema: AgentTool = {
  name: "db_schema",
  description: "Describe the database structure. Without `table`: lists tables/views in a schema with approximate row counts, " +
    "RLS status, and the schema's functions. With `table`: columns (types, nullability, defaults), constraints, " +
    "indexes, RLS policies, triggers, and the view definition for views. Use this before writing queries.",
  input_schema: {
    type: "object",
    properties: {
      schema: { type: "string", description: "Schema name, default 'public'." },
      table: { type: "string", description: "Table or view name to describe in detail." },
    },
  },
  risk: "read",
  async run(input) {
    const sql = db();
    const schema = optStr(input, "schema") ?? "public";
    const table = optStr(input, "table");

    if (!table) {
      const relations = await sql`
        select c.relname as name,
               case c.relkind when 'r' then 'table' when 'p' then 'table' when 'v' then 'view'
                              when 'm' then 'materialized view' when 'f' then 'foreign table' end as type,
               greatest(c.reltuples, 0)::bigint as approx_rows,
               c.relrowsecurity as rls_enabled,
               (select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = ${schema} and c.relkind in ('r', 'p', 'v', 'm', 'f')
        order by c.relname`;
      const functions = await sql`
        select p.proname as name, pg_get_function_identity_arguments(p.oid) as args,
               case p.prokind when 'f' then 'function' when 'p' then 'procedure' else p.prokind::text end as kind,
               p.prosecdef as security_definer
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = ${schema}
        order by p.proname
        limit 300`;
      return clip(toJson({ schema, relations, functions }));
    }

    const [rel] = await sql`
      select c.oid, c.relkind, c.relrowsecurity as rls_enabled, greatest(c.reltuples, 0)::bigint as approx_rows
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${schema} and c.relname = ${table}`;
    if (!rel) return { content: `No table or view "${schema}.${table}" found.`, isError: true };

    const columns = await sql`
      select column_name as name, data_type, udt_name, is_nullable = 'YES' as nullable, column_default as default
      from information_schema.columns
      where table_schema = ${schema} and table_name = ${table}
      order by ordinal_position`;
    const constraints = await sql`
      select conname as name, pg_get_constraintdef(oid) as definition
      from pg_constraint where conrelid = ${rel.oid}`;
    const indexes = await sql`
      select indexname as name, indexdef as definition
      from pg_indexes where schemaname = ${schema} and tablename = ${table}`;
    const policies = await sql`
      select policyname as name, cmd, roles, qual as using, with_check
      from pg_policies where schemaname = ${schema} and tablename = ${table}`;
    const triggers = await sql`
      select tgname as name, pg_get_triggerdef(oid) as definition, tgenabled <> 'D' as enabled
      from pg_trigger where tgrelid = ${rel.oid} and not tgisinternal`;
    const view_definition = rel.relkind === "v" || rel.relkind === "m"
      ? (await sql`select pg_get_viewdef(${rel.oid}::oid, true) as def`)[0]?.def
      : undefined;

    return clip(toJson({
      table: `${schema}.${table}`,
      approx_rows: rel.approx_rows,
      rls_enabled: rel.rls_enabled,
      columns,
      constraints,
      indexes,
      policies,
      triggers,
      view_definition,
    }));
  },
};

const dbQuery: AgentTool = {
  name: "db_query",
  description:
    "Run ONE read-only SQL query (SELECT / WITH / EXPLAIN / SHOW) against the production Postgres database and get the rows " +
    "back as JSON. Runs inside a READ ONLY transaction with a 30s timeout, so it can never change data. " +
    "Aggregate in SQL (count, group by, date math) instead of pulling thousands of rows, and alias duplicate column " +
    "names (rows come back as JSON objects). " +
    "Useful helpers: public.agent_today() = today's date in the business timezone; public.agent_container_view = one row per container.",
  input_schema: {
    type: "object",
    properties: {
      sql: { type: "string", description: "A single read-only SQL statement." },
      max_rows: { type: "integer", description: "Maximum rows to return (default 200, max 2000)." },
    },
    required: ["sql"],
  },
  risk: "read",
  async run(input) {
    const query = str(input, "sql");
    const maxRows = optNum(input, "max_rows", 200, 1, 2000);
    const cls = classifySql(query);
    if (cls.kind !== "read") {
      return {
        isError: true,
        content: `Not a plain read-only query (${cls.reasons.join("; ") || cls.kind}). ` +
          "Use db_execute for anything that changes data or schema, and send one statement at a time.",
      };
    }
    const wrap = ["select", "with", "table", "values"].includes(cls.firstKeyword);
    const text = wrap
      ? `select * from (\n${stripTrailingSemicolons(query)}\n) as _agent_q limit ${maxRows + 1}`
      : stripTrailingSemicolons(query);

    const started = Date.now();
    const rows = await db().begin("read only", async (tx) => {
      await tx.unsafe("set local statement_timeout = '30s'");
      // Take a snapshot first: after this, the transaction can't be switched to read-write.
      await tx.unsafe("select 1");
      return await tx.unsafe(text, [], protocol(false)) as unknown as unknown[];
    });
    const truncated = rows.length > maxRows;
    const shown = truncated ? rows.slice(0, maxRows) : rows;
    const header = `${shown.length} row(s)${truncated ? ` (more exist - limited to ${maxRows})` : ""} in ${
      Date.now() - started
    }ms`;
    return clip(`${header}\n${toJson(shown)}`, 24_000);
  },
};

/** Executes SQL in a transaction, then rolls it back; reports what would have changed. */
async function dryRun(query: string, simple: boolean) {
  try {
    await db().begin(async (tx) => {
      await tx.unsafe("set local statement_timeout = '60s'");
      const res = await tx.unsafe(query, [], protocol(simple));
      throw new Rollback(res);
    });
  } catch (e) {
    if (e instanceof Rollback) {
      const a = affected(e.result);
      return clip(
        `DRY RUN (rolled back, nothing changed): ${a.commands.join(", ") || "statement"} would affect ${a.count} row(s).` +
          rowsPreview(a.rows),
      );
    }
    return { isError: true, content: `Dry run failed: ${errorMessage(e)}` };
  }
  return { isError: true, content: "Dry run did not complete." };
}

const dbExecute: AgentTool = {
  name: "db_execute",
  description: "Change DATA in the production database (INSERT / UPDATE / DELETE). Schema changes (CREATE, ALTER, DROP, GRANT, " +
    "functions, policies, indexes...) are NOT allowed here - use db_migration so they're recorded in the migration history. " +
    "ALWAYS run with `dry_run: true` first: it executes the statement and rolls it back, telling you exactly how many rows " +
    "would change. Whether the real change runs immediately or becomes an approval request depends on the autonomy mode " +
    `(in 'standard' mode a single INSERT/UPDATE with WHERE touching at most ${config.maxAutoRows} rows runs immediately). ` +
    "Anything touching pg_cron, auth, storage or vault always needs the owner's approval. Add RETURNING to see changed rows.",
  input_schema: {
    type: "object",
    properties: {
      sql: { type: "string", description: "SQL to execute." },
      reason: {
        type: "string",
        description:
          "Plain-language explanation for the owner: what is wrong, what this changes (how many rows), and why it's safe.",
      },
      dry_run: { type: "boolean", description: "Execute then roll back, to preview the effect. Default false." },
    },
    required: ["sql", "reason"],
  },
  risk: (input) => {
    const cls = classifySql(typeof input.sql === "string" ? input.sql : "");
    if (cls.kind === "forbidden" || cls.ddl) return "read"; // run() refuses these - no approval request
    if (input.dry_run === true && !cls.sideEffects) return "read";
    if (cls.systemSchema) return "owner";
    return cls.kind === "dangerous" ? "dangerous" : "write";
  },
  async run(input, ctx) {
    const query = str(input, "sql");
    str(input, "reason");
    const cls = classifySql(query);

    if (cls.kind === "forbidden") {
      return {
        outcome: "blocked",
        isError: true,
        content: `Blocked: this statement ${cls.reasons.join("; ")}. This is never allowed.`,
      };
    }
    if (cls.ddl) {
      return {
        outcome: "blocked",
        isError: true,
        content:
          "Schema changes must go through db_migration (so they appear in the Supabase migration history). Nothing was run.",
      };
    }
    const simple = cls.statements > 1; // simple protocol is required for multiple statements
    if (optBool(input, "dry_run")) {
      if (cls.sideEffects) {
        return { isError: true, content: "Can't dry-run: the statement calls functions whose effects can't be rolled back." };
      }
      return await dryRun(query, simple);
    }

    const enforceLimit = !ctx.approved && config.autonomy === "standard";
    try {
      const res = await db().begin(async (tx) => {
        await tx.unsafe(`set local statement_timeout = '${enforceLimit ? 30 : 300}s'`);
        const r = await tx.unsafe(query, [], protocol(simple));
        const a = affected(r);
        if (enforceLimit && a.count > config.maxAutoRows) throw new TooManyRows(a.count);
        return r;
      });
      const a = affected(res);
      return clip(`OK: ${a.commands.join(", ") || "statement"} affected ${a.count} row(s). Committed.` + rowsPreview(a.rows));
    } catch (e) {
      if (e instanceof TooManyRows) {
        return await requestApproval(
          ctx,
          "db_execute",
          input,
          `(This change would affect ${e.count} rows - above the automatic limit of ${config.maxAutoRows}. Nothing was changed yet.)`,
        );
      }
      return { isError: true, content: `Failed (nothing was changed): ${errorMessage(e)}` };
    }
  },
};

function migrationVersion(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${
    p(d.getUTCSeconds())
  }`;
}

const dbMigration: AgentTool = {
  name: "db_migration",
  description:
    "Apply a SCHEMA change (create/alter/drop table, column, index, view, function, trigger, RLS policy, grant...) as a " +
    "Supabase migration: it runs in one transaction and is recorded in supabase_migrations.schema_migrations, exactly like " +
    "migrations applied from the Supabase CLI or dashboard. Use `dry_run: true` first to check it runs cleanly (rolled back). " +
    "Keep each migration small and focused. Make it safe to re-run where possible (IF NOT EXISTS / OR REPLACE). " +
    "Never change the existing Edge Functions or pg_cron schedules: those always need the owner's approval.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "snake_case migration name, e.g. add_index_orders_eta" },
      sql: { type: "string", description: "The migration SQL (may contain several statements)." },
      reason: { type: "string", description: "Why this schema change is needed and what it affects, in plain language." },
      dry_run: { type: "boolean" },
    },
    required: ["name", "sql", "reason"],
  },
  risk: (input) => {
    const cls = classifySql(typeof input.sql === "string" ? input.sql : "");
    if (cls.kind === "forbidden") return "read"; // run() refuses it
    if (input.dry_run === true && !cls.sideEffects) return "read";
    return cls.systemSchema ? "owner" : "dangerous";
  },
  async run(input) {
    const name = str(input, "name").trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 80);
    const query = str(input, "sql");
    str(input, "reason");
    const cls = classifySql(query);
    if (cls.kind === "forbidden") {
      return {
        outcome: "blocked",
        isError: true,
        content: `Blocked: this statement ${cls.reasons.join("; ")}. This is never allowed.`,
      };
    }
    if (optBool(input, "dry_run")) {
      if (cls.sideEffects) {
        return { isError: true, content: "Can't dry-run: the SQL calls functions whose effects can't be rolled back." };
      }
      return await dryRun(query, true);
    }
    let version = migrationVersion();
    try {
      await db().begin(async (tx) => {
        await tx.unsafe("set local statement_timeout = '120s'");
        const [{ ok }] = await tx`select to_regclass('supabase_migrations.schema_migrations') is not null as ok`;
        if (!ok) throw new Error("supabase_migrations.schema_migrations not found - can't record the migration");
        // Versions must be unique and increasing (two migrations in the same second get +1).
        const [{ latest }] = await tx<{ latest: string | null }[]>`
          select max(version) as latest from supabase_migrations.schema_migrations where version ~ '^[0-9]{14}$'`;
        if (latest && latest >= version) version = String(BigInt(latest) + 1n);
        await tx.unsafe(query, [], protocol(true));
        await tx`
          insert into supabase_migrations.schema_migrations (version, name, statements)
          values (${version}, ${name}, ${[query]})`;
      });
      return `Migration ${version}_${name} applied and recorded in the migration history.`;
    } catch (e) {
      return { isError: true, content: `Migration failed and was rolled back (nothing changed): ${errorMessage(e)}` };
    }
  },
};

export const databaseTools: AgentTool[] = [dbSchema, dbQuery, dbExecute, dbMigration];
