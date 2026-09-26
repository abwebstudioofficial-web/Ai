// Run with:  deno test supabase/functions/_shared/sql_guard_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { classifySql, maskSql } from "./sql_guard.ts";

const kind = (sql: string) => classifySql(sql).kind;

Deno.test("plain reads", () => {
  assertEquals(kind("select * from orders where eta < current_date"), "read");
  assertEquals(kind("  (select 1) union (select 2);  "), "read");
  assertEquals(kind("with x as (select 1) select * from x"), "read");
  assertEquals(kind("explain select * from orders"), "read");
  assertEquals(kind("select count(*) from auth.users"), "read");
  assertEquals(kind("select updated_at, created_at from orders"), "read");
});

Deno.test("keywords inside strings and comments are ignored", () => {
  assertEquals(kind("select * from orders where note = '; drop table orders; --'"), "read");
  assertEquals(kind("select $$;delete from x$$"), "read");
  assertEquals(kind("select $tag$ it's ; truncate $tag$ as t"), "read");
  assertEquals(kind("/* delete from orders */ select 1"), "read");
  assertEquals(kind("select 1 -- ; drop table orders"), "read");
  assertEquals(kind("select E'it\\'s; delete' as s"), "read");
  assertEquals(maskSql(`select "Weird;Name" from t`), "select weird_name from t");
});

Deno.test("reads that are not really reads", () => {
  assertEquals(kind("select * into backup_orders from orders"), "dangerous");
  assertEquals(kind("select * from orders for update"), "dangerous");
  assertEquals(kind("with d as (delete from orders returning *) select * from d"), "dangerous");
  assertEquals(kind("explain analyze delete from orders"), "dangerous");
  assertEquals(kind("select pg_terminate_backend(123)"), "dangerous");
  assertEquals(kind("select nextval('orders_seq')"), "dangerous");
  assertEquals(kind("select 1; select 2"), "dangerous");
});

Deno.test("small writes run automatically", () => {
  assertEquals(kind("update orders set eta = '2026-10-01' where id = 'ORD-1'"), "write");
  assertEquals(kind("update orders set updated_at = now() where created_at < now()"), "write");
  assertEquals(kind("insert into customers (id, name) values ('C9', 'New Co')"), "write");
  assertEquals(kind("insert into t (a) values (1) on conflict (a) do update set a = excluded.a"), "write");
});

Deno.test("dangerous changes need approval", () => {
  assertEquals(kind("update orders set cancelled = true"), "dangerous");
  assertEquals(kind("delete from orders where id = 'x'"), "dangerous");
  assertEquals(kind("drop table orders"), "dangerous");
  assertEquals(kind("alter table orders add column x int"), "dangerous");
  assertEquals(kind("truncate orders"), "dangerous");
  assertEquals(kind("update auth.users set email = 'x' where id = '1'"), "dangerous");
  assertEquals(kind(`update "auth"."users" set email = 'x' where id = '1'`), "dangerous");
  assertEquals(kind("update orders set eta = null where id = '1'; delete from orders"), "dangerous");
  assertEquals(kind("create index on orders (eta)"), "dangerous");
  assertEquals(kind("do $$ begin perform 1; end $$"), "dangerous");
});

Deno.test("forbidden statements", () => {
  assertEquals(kind("select pg_read_file('/etc/passwd')"), "forbidden");
  assertEquals(kind("copy orders to program 'curl evil'"), "forbidden");
  assertEquals(kind("update agent_approvals set status = 'approved' where id = 1"), "forbidden");
  assertEquals(kind("delete from agent_audit_log"), "forbidden");
  assertEquals(kind("set role postgres"), "forbidden");
  assertEquals(kind("alter system set work_mem = '1GB'"), "forbidden");
  assertEquals(kind("   ;  "), "forbidden");
  // reading the agent's own tables is fine
  assertEquals(kind("select * from agent_approvals where status = 'pending'"), "read");
});

Deno.test("schema changes and system schemas are flagged", () => {
  assertEquals(classifySql("create index on orders (eta)").ddl, true);
  assertEquals(classifySql("alter table orders add column x int").ddl, true);
  assertEquals(classifySql("grant select on orders to anon").ddl, true);
  assertEquals(classifySql("do $$ begin perform 1; end $$").ddl, true);
  assertEquals(classifySql("update orders set eta = null where id = '1'").ddl, false);
  assertEquals(classifySql("delete from orders where id = '1'").ddl, false);
  assertEquals(classifySql("select cron.unschedule('fetch-pso-diesel-price-daily')").systemSchema, true);
  assertEquals(classifySql("update cron.job set schedule = '0 1 * * *' where jobid = 1").systemSchema, true);
  assertEquals(classifySql("select * from orders").systemSchema, false);
});
