// Run with:  deno test supabase/functions/_shared/tools/github_test.ts
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { applyEdits } from "./github.ts";

const file = `function A() {\n  const [x] = useState(0);\n  return x;\n}\nfunction B() {\n  return 1;\n}\n`;

Deno.test("applies exact edits to the latest file", () => {
  const out = applyEdits(file, [{ find: "return 1;", replace: "return 2;" }], "index.html");
  assertEquals(out.includes("return 2;"), true);
  assertEquals(out.includes("useState(0)"), true);
});

Deno.test("refuses edits whose text is missing (file changed meanwhile)", () => {
  assertThrows(() => applyEdits(file, [{ find: "return 3;", replace: "x" }], "index.html"), Error, "not found");
});

Deno.test("refuses ambiguous edits", () => {
  assertThrows(() => applyEdits(file, [{ find: "return", replace: "x" }], "index.html"), Error, "more than once");
});

Deno.test("edits apply in order", () => {
  const out = applyEdits(file, [{ find: "return 1;", replace: "return 9;" }, { find: "return 9;", replace: "return 10;" }], "f");
  assertEquals(out.includes("return 10;"), true);
});
