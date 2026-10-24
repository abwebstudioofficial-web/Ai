// Run with:  deno test supabase/functions/_shared/autofix_policy_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { changedLines, checkFixPolicy, validateRepro } from "./autofix_policy.ts";

const ctx = (body: string) => `function OrderForm() {\n  const [qty, setQty] = useState("");\n${body}\n  return null;\n}`;

Deno.test("only the really changed lines count (context lines don't)", () => {
  const find = ctx(`  <input value={qty} />`);
  const replace = ctx(`  <input value={qty} onChange={(e) => setQty(e.target.value)} />`);
  assertEquals(changedLines({ find, replace }), {
    removed: ["  <input value={qty} />"],
    added: ["  <input value={qty} onChange={(e) => setQty(e.target.value)} />"],
  });
  const r = checkFixPolicy([{ find, replace }]);
  assertEquals(r, { linesChanged: 1, violations: [] });
});

Deno.test("a small UI fix is allowed even if unchanged context mentions money or roles", () => {
  const find = `  const total = sum(rows); // role check below\n  <button onClick={open}>Add</button>`;
  const replace = `  const total = sum(rows); // role check below\n  <button type="button" onClick={() => open()}>Add</button>`;
  assertEquals(checkFixPolicy([{ find, replace }]).violations, []);
});

Deno.test("changes to forbidden areas are never auto-merged", () => {
  const cases: [string, string, string][] = [
    ["const fee = 10;", "const amount = qty * rate;", "amounts or financial calculations"],
    ["x", "if (session.role === 'admin') show();", "user roles"],
    ["x", "await supabaseClient.from('orders').update(row).eq('id', id);", "loading or saving data"],
    ["x", "askDelete({ entity: 'orders', id });", "deleting"],
    ["x", "window.ResearchAgent.configure(cfg);", "research assistant"],
    ["x", '<script src="https://evil.example/x.js"></script>', "scripts, links"],
    ["x", "localStorage.setItem('k', v);", "scripts, links, storage"],
  ];
  for (const [find, replace, why] of cases) {
    const v = checkFixPolicy([{ find, replace }]).violations;
    assert(v.some((x) => x.includes(why)), `expected "${why}" for: ${replace} -> got ${JSON.stringify(v)}`);
  }
});

Deno.test("big changes need approval", () => {
  const replace = Array.from({ length: 31 }, (_, i) => `  <div>line ${i}</div>`).join("\n");
  const r = checkFixPolicy([{ find: "  <div>old</div>", replace }]);
  assertEquals(r.linesChanged, 31);
  assert(r.violations.some((v) => v.includes("limited to 30")));
  assertEquals(checkFixPolicy([]).violations, ["no changes"]);
});

Deno.test("the reproduction is validated", () => {
  const ok = {
    steps: [{ nav: "Invoices" }, { click: "text=New Invoice" }, { fill: ["#qty", "3"] }],
    target_error: "Cannot read properties",
  };
  assertEquals(validateRepro(ok), null);
  assertEquals(validateRepro({ ...ok, mock_data: { orders: [{ id: "o1" }] } }), null);
  assert(validateRepro({ steps: [{ click: "x", fill: ["a", "b"] }], target_error: "boom!" })?.includes("exactly one"));
  assert(validateRepro({ steps: [{ fill: "a" }], target_error: "boom!" })?.includes("[selector, value]"));
  assert(validateRepro({ steps: [], target_error: "x" })?.includes("target_error"));
  assert(validateRepro({ steps: [{ click: "x" }], target_error: "boom -->" })?.includes("-->"));
  assert(validateRepro({ steps: [], target_error: "boom!", mock_data: { orders: "x" } })?.includes("array of rows"));
});
