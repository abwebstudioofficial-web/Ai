// Run with:  deno test --allow-env supabase/functions/_shared/tools/website_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { extractLinks } from "./website.ts";

Deno.test("links inside in-browser JSX / templates are ignored, real markup is kept", () => {
  const html = `<script src="a.js"></script>
<script type="text/babel">const x = <img src={photo} />; const y = <a href="/inside-code">x</a>;</script>
<img src="logo.png"><a href="page.html">p</a><img src="\${url}"><img src="{dataUrl}">`;
  assertEquals(extractLinks(html, "https://example.com/app/"), {
    scripts: ["https://example.com/app/a.js"],
    styles: [],
    images: ["https://example.com/app/logo.png"],
    pages: ["https://example.com/app/page.html"],
  });
});
