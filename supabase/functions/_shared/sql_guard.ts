// Classifies SQL written by the agent so the harness can decide what runs
// automatically and what needs the owner's approval.
//
// This is a guard rail, not the only line of defence: read queries also run
// inside READ ONLY transactions with a single-statement protocol, so Postgres
// itself refuses writes there even if this classifier were fooled.

export type SqlKind =
  | "read" // plain SELECT-style query
  | "write" // a single INSERT/UPDATE (with WHERE) on application tables
  | "dangerous" // anything else: DELETE, DDL, bulk/multi statements, system schemas...
  | "forbidden"; // never allowed (server file access, self-approval, role switching)

export interface SqlClassification {
  kind: SqlKind;
  statements: number;
  firstKeyword: string;
  /** Contains calls whose effects can't be rolled back (so no dry runs either). */
  sideEffects: boolean;
  /** Schema change (CREATE/ALTER/DROP/GRANT/...): must go through a recorded migration. */
  ddl: boolean;
  /** Touches Supabase-managed schemas (auth, storage, cron, vault, net...). */
  systemSchema: boolean;
  reasons: string[];
}

const isIdentChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/**
 * Lower-cases the SQL and blanks out comments and string literals (including
 * E'' and $tag$ dollar quotes), so keywords inside quoted text can't influence
 * the classification. Quoted identifiers keep their (sanitised) name.
 */
export function maskSql(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      out += " ";
      continue;
    }
    if ((ch === "e" || ch === "E") && next === "'" && !isIdentChar(sql[i - 1])) {
      i += 2;
      while (i < n) {
        if (sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += "''";
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += "''";
      continue;
    }
    if (ch === "$" && !isIdentChar(sql[i - 1])) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        out += "''";
        continue;
      }
    }
    if (ch === '"') {
      i++;
      let ident = "";
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            ident += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        ident += sql[i];
        i++;
      }
      out += ident.replace(/[^A-Za-z0-9_$]/g, "_");
      continue;
    }
    out += ch;
    i++;
  }
  return out.toLowerCase();
}

const READ_START = new Set(["select", "with", "explain", "show", "table", "values"]);
const DDL_START = new Set(["create", "alter", "drop", "comment", "grant", "revoke", "do", "security", "reindex", "cluster"]);
const MODIFYING = /\b(insert|update|delete|merge|truncate|upsert)\b/;
const PROTECTED_SCHEMAS =
  /\b(auth|storage|vault|cron|net|supabase_functions|supabase_migrations|realtime|pgsodium|pgsodium_masks|extensions|pg_catalog|information_schema|graphql|graphql_public|pgbouncer)\s*\./;
const AGENT_CONTROL_TABLES = /\b(agent_approvals|agent_audit_log)\b/;

// Calls with effects outside the transaction (or that change session state).
const SIDE_EFFECT_FUNCS =
  /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|set_config|pg_advisory_\w+|pg_try_advisory_\w+|dblink\w*|pg_sleep\w*|pg_notify|lo_\w+|http_\w+|pg_switch_wal|pg_create_restore_point)\s*\(/;
// Functions a plain read query should never call.
const READ_DENY_FUNCS = /\b(nextval|setval|pg_read_file|pg_read_binary_file|pg_ls_\w+|pg_stat_file|pg_file_\w+)\s*\(/;

const FORBIDDEN: Array<[RegExp, string]> = [
  [
    /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_ls_logdir|pg_ls_waldir|pg_stat_file|lo_import|lo_export)\s*\(/,
    "reads or writes server files",
  ],
  [/\bcopy\b[\s\S]*\bprogram\b/, "runs a shell program"],
  [/\balter\s+system\b/, "changes server configuration"],
  [/\bset\s+(session\s+|local\s+)?role\b|\bsession\s+authorization\b/, "switches database role"],
];

function splitStatements(masked: string): string[] {
  return masked
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function firstKeyword(stmt: string): string {
  return /^[\s(]*([a-z_]+)/.exec(stmt)?.[1] ?? "";
}

export function classifySql(sql: string): SqlClassification {
  const masked = maskSql(sql);
  const statements = splitStatements(masked);
  const first = statements.length ? firstKeyword(statements[0]) : "";
  const reasons: string[] = [];
  const sideEffects = SIDE_EFFECT_FUNCS.test(masked);
  const ddl = statements.some((s) => DDL_START.has(firstKeyword(s)));
  const sysMatch = PROTECTED_SCHEMAS.exec(masked);
  const systemSchema = sysMatch !== null;
  const base = { statements: statements.length, firstKeyword: first, sideEffects, ddl, systemSchema };

  if (statements.length === 0) {
    return { ...base, kind: "forbidden", sideEffects: false, reasons: ["empty statement"] };
  }

  for (const [re, why] of FORBIDDEN) {
    if (re.test(masked)) reasons.push(why);
  }
  const allReads = statements.every((s) => READ_START.has(firstKeyword(s))) && !MODIFYING.test(masked);
  if (!allReads && AGENT_CONTROL_TABLES.test(masked)) {
    reasons.push("modifies the agent's own approval/audit records");
  }
  if (reasons.length) {
    return { ...base, kind: "forbidden", reasons };
  }

  // ---- read? -------------------------------------------------------------------
  if (
    statements.length === 1 &&
    READ_START.has(first) &&
    !MODIFYING.test(masked) &&
    !/\binto\b/.test(masked) && // SELECT ... INTO creates a table
    !/\bfor\s+(no\s+key\s+)?(update|share)\b/.test(masked) &&
    !sideEffects &&
    !READ_DENY_FUNCS.test(masked)
  ) {
    return { ...base, kind: "read", reasons: [] };
  }

  // ---- small, safe write? -------------------------------------------------------
  if (statements.length > 1) reasons.push(`${statements.length} statements in one call`);
  const isInsertOrUpdate = first === "insert" || first === "update" ||
    (first === "with" && /\b(insert|update)\b/.test(masked));
  if (!isInsertOrUpdate) {
    reasons.push(`${first.toUpperCase() || "UNKNOWN"} statement`);
  }
  const bad = /\b(delete|merge|truncate|drop|alter|create|grant|revoke)\b/.exec(masked);
  if (bad) reasons.push(`contains ${bad[1].toUpperCase()}`);
  if (sysMatch) reasons.push(`touches the system schema "${sysMatch[1]}"`);
  // (ignores INSERT ... ON CONFLICT DO UPDATE, which only touches conflicting rows)
  if (/(?<!\bdo\s+)\bupdate\b/.test(masked) && !/\bwhere\b/.test(masked)) {
    reasons.push("UPDATE without WHERE (would change every row)");
  }
  if (sideEffects) reasons.push("calls functions with side effects outside the transaction");

  if (reasons.length === 0) {
    return { ...base, kind: "write", reasons: [] };
  }
  return { ...base, kind: "dangerous", reasons };
}

/** Removes trailing semicolons/whitespace so a query can be wrapped as a subquery. */
export function stripTrailingSemicolons(sql: string): string {
  return sql.replace(/[\s;]+$/g, "");
}
