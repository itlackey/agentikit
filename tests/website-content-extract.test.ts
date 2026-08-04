// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * P2 — main-content extraction: unit tests.
 *
 * Pins the two behaviors most at risk in the move from the hand-rolled regex
 * converter to a DOM parse plus Turndown:
 *   - script/style/noscript content must never reach the markdown
 *   - only http(s) links may be emitted as markdown links
 * plus the regression trap that crawl-queue link extraction stays WHOLE-PAGE
 * while only the saved markdown is content-scoped.
 *
 * Pure functions over HTML strings — no network, no filesystem.
 */
import { describe, expect, test } from "bun:test";
import {
  extractDocumentLinks,
  extractMainContentHtml,
  htmlToMarkdown,
} from "../src/sources/snapshot-fetchers/content-extract";

const PAGE_URL = "https://docs.example.com/guide/intro";

const DOCS_LAYOUT = `<!doctype html>
<html><head><title>Intro</title></head>
<body>
  <header><h1>SiteName</h1></header>
  <nav><a href="/guide/install">Install</a><a href="/guide/api">API</a></nav>
  <main>
    <h1>Getting started</h1>
    <p>Real content lives here.</p>
    <pre><code class="language-ts">const x: number = 1;</code></pre>
  </main>
  <aside><p>Sponsored placement</p></aside>
  <footer><p>Copyright boilerplate</p></footer>
</body></html>`;

const BLOG_LAYOUT = `<!doctype html>
<html><body>
  <nav><a href="/archive">Archive</a></nav>
  <article>
    <h2>Post title</h2>
    <p>Post body text.</p>
  </article>
  <footer>Footer junk</footer>
</body></html>`;

const NO_SEMANTICS = `<!doctype html>
<html><body>
  <div class="wrapper"><p>Bare div content.</p></div>
</body></html>`;

const NESTED_MAIN = `<!doctype html>
<html><body>
  <main id="outer">
    <p>Outer main text.</p>
    <main id="inner"><p>Inner main text.</p></main>
  </main>
</body></html>`;

describe("content region selection", () => {
  test("docs layout: keeps main, drops nav/header/aside/footer", () => {
    const md = htmlToMarkdown(DOCS_LAYOUT, PAGE_URL);
    expect(md).toContain("Getting started");
    expect(md).toContain("Real content lives here.");
    expect(md).not.toContain("Sponsored placement");
    expect(md).not.toContain("Copyright boilerplate");
    expect(md).not.toContain("SiteName");
  });

  test("blog layout: article wins over surrounding chrome", () => {
    const md = htmlToMarkdown(BLOG_LAYOUT, PAGE_URL);
    expect(md).toContain("Post title");
    expect(md).toContain("Post body text.");
    expect(md).not.toContain("Footer junk");
    expect(md).not.toContain("Archive");
  });

  test("no semantic markup: falls back to body content", () => {
    const md = htmlToMarkdown(NO_SEMANTICS, PAGE_URL);
    expect(md).toContain("Bare div content.");
  });

  test("nested <main>: outermost wins and inner text is retained", () => {
    const md = htmlToMarkdown(NESTED_MAIN, PAGE_URL);
    expect(md).toContain("Outer main text.");
    expect(md).toContain("Inner main text.");
  });

  test("empty content region does not shadow real content below it", () => {
    const html = `<html><body><main></main><article><p>Actual prose.</p></article></body></html>`;
    expect(htmlToMarkdown(html, PAGE_URL)).toContain("Actual prose.");
  });

  test("extractMainContentHtml returns the region, not the whole document", () => {
    const html = extractMainContentHtml(DOCS_LAYOUT);
    expect(html).toContain("Real content lives here.");
    expect(html).not.toContain("Sponsored placement");
  });

  test("a narrow markdown body wins over a repository application main", () => {
    const html = `<html><body><main>
      <nav>Code Issues Pull requests Actions</nav>
      <div class="repository-toolbar">Branch picker and file controls</div>
      <article class="markdown-body"><h1>AirLLM</h1><p>The actual README.</p></article>
      <div>Footer-like repository controls</div>
    </main></body></html>`;
    const md = htmlToMarkdown(html, "https://github.com/example/airllm");
    expect(md).toContain("# AirLLM");
    expect(md).toContain("The actual README.");
    expect(md).not.toContain("Pull requests");
    expect(md).not.toContain("repository controls");
  });

  test("a narrow markdown body wins over broad id-based content", () => {
    const html = `<html><body><div id="main-content">
      <div>Application toolbar</div>
      <article class="markdown-body"><h1>README</h1><p>Narrow content.</p></article>
      <div>Application footer controls</div>
    </div></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("# README");
    expect(md).toContain("Narrow content.");
    expect(md).not.toContain("Application toolbar");
    expect(md).not.toContain("footer controls");
  });

  test("a markdown body stays narrower than its article wrapper", () => {
    const html = `<html><body><article>
      <div>Article toolbar</div>
      <div class="markdown-body"><h1>README</h1><p>Narrow body.</p></div>
      <footer>Article wrapper footer</footer>
    </article></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("Narrow body.");
    expect(md).not.toContain("Article toolbar");
    expect(md).not.toContain("wrapper footer");
  });

  test("an article keeps its own semantic header, footer, and aside", () => {
    const html = `<html><body><header>Site header</header><article>
      <header><h1>Post title</h1><p>By Ada</p></header>
      <div class="article-content"><p>Post body.</p></div>
      <aside>Key takeaway.</aside>
      <footer>Updated yesterday.</footer>
    </article><footer>Site footer</footer></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("# Post title");
    expect(md).toContain("By Ada");
    expect(md).toContain("Key takeaway.");
    expect(md).toContain("Updated yesterday.");
    expect(md).not.toContain("Site header");
    expect(md).not.toContain("Site footer");
  });

  test("article metadata survives when a surrounding main region wins", () => {
    const html = `<html><body><header>Site header</header><main><article>
      <header><h1>Post title</h1><p>By Ada</p></header>
      <p>Post body.</p>
      <aside>Key takeaway.</aside>
      <footer>Updated yesterday.</footer>
    </article></main><footer>Site footer</footer></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("# Post title");
    expect(md).toContain("By Ada");
    expect(md).toContain("Key takeaway.");
    expect(md).toContain("Updated yesterday.");
    expect(md).not.toContain("Site header");
    expect(md).not.toContain("Site footer");
  });

  test("semantic metadata survives directly inside a selected main region", () => {
    const html = `<html><body><header>Site header</header><main>
      <header><h1>Document title</h1><p>Maintained by Ada.</p></header>
      <p>Document body.</p><aside>Important callout.</aside><footer>Updated yesterday.</footer>
    </main><footer>Site footer</footer></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("# Document title");
    expect(md).toContain("Maintained by Ada.");
    expect(md).toContain("Important callout.");
    expect(md).toContain("Updated yesterday.");
    expect(md).not.toContain("Site header");
    expect(md).not.toContain("Site footer");
  });

  test("unwanted chrome is removed from inside a selected main region", () => {
    const html = `<html><body><main>
      <div class="menu">On this page</div>
      <p>Useful prose.</p>
      <div class="related">Related stories</div>
      <div class="cookie-notice">Accept cookies</div>
    </main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("Useful prose.");
    expect(md).not.toContain("On this page");
    expect(md).not.toContain("Related stories");
    expect(md).not.toContain("Accept cookies");
  });

  test("an explicit main region wins over an unrelated article teaser", () => {
    const html = `<html><body>
      <article><h2>Unrelated teaser</h2><p>Card copy.</p></article>
      <main class="main-content"><h1>Actual documentation</h1><p>Primary content.</p></main>
    </body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("Actual documentation");
    expect(md).toContain("Primary content.");
    expect(md).not.toContain("Unrelated teaser");
  });

  test("repeated article regions retain the complete listing", () => {
    const html = `<html><body><main>
      <article><h2>First post</h2></article>
      <article><h2>Second post</h2></article>
    </main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("First post");
    expect(md).toContain("Second post");
  });

  test("an empty first narrow region does not hide a later populated match", () => {
    const html = `<html><body><div class="markdown-body"></div>
      <div class="markdown-body"><h1>Actual content</h1></div></body></html>`;
    expect(htmlToMarkdown(html, PAGE_URL)).toContain("# Actual content");
  });

  test("a hidden narrow region does not override visible main content", () => {
    const html = `<html><body>
      <div class="markdown-body" hidden><h1>Forged hidden content</h1></div>
      <main><h1>Visible content</h1><p>Keep this.</p></main>
    </body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("# Visible content");
    expect(md).toContain("Keep this.");
    expect(md).not.toContain("Forged hidden content");
  });

  test("an unwanted narrow root does not override visible main content", () => {
    const html = `<html><body>
      <div class="markdown-body overlay"><h1>Overlay copy</h1></div>
      <main><h1>Actual content</h1></main>
    </body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("# Actual content");
    expect(md).not.toContain("Overlay copy");
  });

  test.each([
    ["unwanted class", '<div class="overlay"><div class="markdown-body">Overlay copy</div></div>'],
    ["page chrome", '<aside><div class="markdown-body">Sidebar copy</div></aside>'],
  ])("a narrow region inside %s does not override visible main content", (_label, wrapped) => {
    const html = `<html><body>${wrapped}<main><h1>Actual content</h1></main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("# Actual content");
    expect(md).not.toContain("Overlay copy");
    expect(md).not.toContain("Sidebar copy");
  });

  test("nested matches select the outer content region without falling back to body", () => {
    const html = `<html><body><div>Outside shell</div><main>
      <p>Outer content.</p><main><p>Inner content.</p></main>
    </main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("Outer content.");
    expect(md).toContain("Inner content.");
    expect(md).not.toContain("Outside shell");
  });
});

describe("dangerous content never reaches markdown", () => {
  test("script bodies are stripped", () => {
    const html = `<html><body><main><p>Visible.</p><script>alert("PWNED_TOKEN")</script></main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("Visible.");
    expect(md).not.toContain("PWNED_TOKEN");
    expect(md).not.toContain("alert");
  });

  test("style bodies are stripped", () => {
    const html = `<html><body><main><p>Visible.</p><style>.x{content:"CSS_TOKEN"}</style></main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).not.toContain("CSS_TOKEN");
  });

  test("noscript and template bodies are stripped", () => {
    const html = `<html><body><main><p>Visible.</p><noscript>NOSCRIPT_TOKEN</noscript><template>TEMPLATE_TOKEN</template></main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).not.toContain("NOSCRIPT_TOKEN");
    expect(md).not.toContain("TEMPLATE_TOKEN");
  });

  test("script outside the content region is stripped too", () => {
    const html = `<html><head><script>HEAD_TOKEN</script></head><body><div><p>Body text.</p><script>BODY_TOKEN</script></div></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).not.toContain("HEAD_TOKEN");
    expect(md).not.toContain("BODY_TOKEN");
  });
});

describe("link safety in emitted markdown", () => {
  test("http(s) links are emitted with absolute resolved URLs", () => {
    const html = `<html><body><main><a href="/guide/next">Next</a></main></body></html>`;
    expect(htmlToMarkdown(html, PAGE_URL)).toContain("[Next](https://docs.example.com/guide/next)");
  });

  test.each([
    ["javascript:", `<a href="javascript:alert(1)">Click</a>`],
    ["data:", `<a href="data:text/html;base64,PHNjcmlwdD4=">Click</a>`],
    ["file:", `<a href="file:///etc/passwd">Click</a>`],
    ["mailto:", `<a href="mailto:a@b.example">Click</a>`],
  ])("%s href degrades to plain text, not a link", (_scheme, anchor) => {
    const md = htmlToMarkdown(`<html><body><main>${anchor}</main></body></html>`, PAGE_URL);
    expect(md).toContain("Click");
    expect(md).not.toContain("](");
  });

  test("anchors with no text produce no markdown link", () => {
    const html = `<html><body><main><p>Before</p><a href="/x"></a><p>After</p></main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).not.toContain("](");
    expect(md).toContain("Before");
    expect(md).toContain("After");
  });
});

describe("crawl-queue link extraction stays whole-page", () => {
  // Regression trap: narrowing this to the content region would silently
  // shrink every crawl, since nav links are how pages are discovered.
  test("nav and footer links are still discovered even though they are not in the markdown", () => {
    const hrefs = extractDocumentLinks(DOCS_LAYOUT, PAGE_URL).map((u) => u.pathname);
    expect(hrefs).toContain("/guide/install");
    expect(hrefs).toContain("/guide/api");

    const md = htmlToMarkdown(DOCS_LAYOUT, PAGE_URL);
    expect(md).not.toContain("/guide/install");
  });

  test("non-http(s) and fragment-only hrefs are excluded from the queue", () => {
    const html = `<html><body>
      <a href="https://ok.example/a">ok</a>
      <a href="javascript:alert(1)">bad</a>
      <a href="mailto:a@b.example">mail</a>
      <a href="#section">frag</a>
    </body></html>`;
    const urls = extractDocumentLinks(html, PAGE_URL);
    expect(urls.map((u) => u.toString())).toEqual(["https://ok.example/a"]);
  });

  test("relative hrefs resolve against the page URL", () => {
    const html = `<html><body><a href="../other">rel</a></body></html>`;
    expect(extractDocumentLinks(html, PAGE_URL)[0]?.toString()).toBe("https://docs.example.com/other");
  });
});

describe("markdown fidelity", () => {
  test("code fence carries the language from a language-* class", () => {
    const md = htmlToMarkdown(DOCS_LAYOUT, PAGE_URL);
    expect(md).toContain("```ts");
    expect(md).toContain("const x: number = 1;");
  });

  test("code fence without a language class still fences", () => {
    const html = `<html><body><main><pre><code>plain code</code></pre></main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("```");
    expect(md).toContain("plain code");
  });

  test("tables and nested lists survive conversion", () => {
    const html = `<html><body><main>
      <ul><li>one<ul><li>nested</li></ul></li></ul>
      <table><tr><th>H</th></tr><tr><td>Cell</td></tr></table>
    </main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("one");
    expect(md).toContain("nested");
    expect(md).toContain("Cell");
  });

  test("a headered table becomes a GFM table", () => {
    const html = `<html><body><main><table>
      <thead><tr><th>Name</th><th>Value</th></tr></thead>
      <tbody><tr><td>alpha</td><td>one</td></tr></tbody>
    </table></main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("| Name | Value |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| alpha | one |");
  });

  const unsupportedTables: Array<[string, string, string[]]> = [
    ["headerless", `<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>`, ["A", "B", "C", "D"]],
    ["row header", `<table><tr><th>A</th><th>B</th></tr><tr><th>C</th><td>D</td></tr></table>`, ["A", "B", "C", "D"]],
    [
      "multiple header rows",
      `<table><tr><th>A</th><th>B</th></tr><tr><th>C</th><th>D</th></tr><tr><td>E</td><td>F</td></tr></table>`,
      ["A", "B", "C", "D", "E", "F"],
    ],
    ["spanning cell", `<table><tr><th colspan="2">A</th></tr><tr><td>B</td><td>C</td></tr></table>`, ["A", "B", "C"]],
    [
      "caption",
      `<table><caption>Metrics</caption><tr><th>A</th><th>B</th></tr><tr><td>C</td><td>D</td></tr></table>`,
      ["Metrics", "A", "B", "C", "D"],
    ],
    [
      "nested",
      `<table><tr><th>A</th><th>B</th></tr><tr><td>C</td><td><table><tr><th>X</th></tr><tr><td>Y</td></tr></table></td></tr></table>`,
      ["A", "B", "C", "X", "Y"],
    ],
  ];

  test.each(unsupportedTables)("an unsupported %s table falls back without malformed GFM", (_label, table, text) => {
    const md = htmlToMarkdown(`<html><body><main>${table}</main></body></html>`, PAGE_URL);
    expect(md).not.toContain("| ---");
    for (const value of text) expect(md).toContain(value);
  });

  test("headings become atx and output has no runs of blank lines", () => {
    const md = htmlToMarkdown(DOCS_LAYOUT, PAGE_URL);
    expect(md).toContain("# Getting started");
    expect(md).not.toMatch(/\n{3,}/);
  });

  test("entities are decoded", () => {
    const html = `<html><body><main><p>a &amp; b &lt; c &nbsp;d</p></main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("a & b < c");
  });
});

describe("security regressions (found in review)", () => {
  // HIGH: node-html-parser only closes a raw-text element on an exactly
  // matching lowercase `</script>`. Every other spelling a browser accepts
  // desynced the parse, so no script element existed to remove and the body
  // was serialized as prose — invisible to anyone viewing the page.
  test.each([
    ["uppercase close", "</SCRIPT>"],
    ["trailing space", "</script >"],
    ["trailing tab", "</script\t>"],
    ["trailing newline", "</script\n>"],
    ["self-closing slash", "</script/>"],
    ["attribute junk", "</script foo>"],
    ["space after slash", "</ script>"],
  ])("script body does not leak with a %s end tag", (_label, closeTag) => {
    const html = `<html><body><main><p>Visible.</p><script>LEAKED_PAYLOAD_TOKEN${closeTag}<p>After.</p></main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).not.toContain("LEAKED_PAYLOAD_TOKEN");
  });

  test("unterminated script at EOF does not leak its body", () => {
    const html = `<html><body><main><p>Visible.</p><script>LEAKED_PAYLOAD_TOKEN`;
    expect(htmlToMarkdown(html, PAGE_URL)).not.toContain("LEAKED_PAYLOAD_TOKEN");
  });

  test.each(["</STYLE>", "</style >", "</style/>"])("style body does not leak with %s", (closeTag) => {
    const html = `<html><body><main><p>Visible.</p><style>LEAKED_CSS_TOKEN${closeTag}</main></body></html>`;
    expect(htmlToMarkdown(html, PAGE_URL)).not.toContain("LEAKED_CSS_TOKEN");
  });

  // MEDIUM: Turndown's built-in image rule emitted src verbatim, bypassing
  // the anchor scheme policy entirely.
  test.each([
    ["javascript:alert(1)"],
    ["data:image/svg+xml,x"],
    ["file:///etc/passwd"],
  ])("image src %s is not emitted as a link", (src) => {
    const md = htmlToMarkdown(`<html><body><main><img src="${src}" alt="ALTTEXT"></main></body></html>`, PAGE_URL);
    expect(md).toContain("ALTTEXT");
    expect(md).not.toContain("](");
  });

  test("relative image src resolves against the page URL", () => {
    const md = htmlToMarkdown(`<html><body><main><img src="/img/a.png" alt="A"></main></body></html>`, PAGE_URL);
    expect(md).toContain("![A](https://docs.example.com/img/a.png)");
  });

  // MEDIUM: a hardcoded 3-backtick fence let code content close the fence
  // early and inject forged headings as real markdown.
  test("code containing a triple backtick cannot break out of its fence", () => {
    const payload = "const a = 1;\n```\n\n# FORGED HEADING\n\n```js\nconst b = 2;";
    const md = htmlToMarkdown(
      `<html><body><main><pre><code class="language-js">${payload}</code></pre></main></body></html>`,
      PAGE_URL,
    );
    // The heading text is still present, but sealed inside a widened fence
    // rather than acting as a real heading.
    const fence = /^(`{4,})js\n([\s\S]*)\n\1$/.exec(md.trim());
    expect(fence).not.toBeNull();
    expect(fence?.[2]).toContain("# FORGED HEADING");
  });

  // MEDIUM: deep nesting overflowed the stack and aborted the whole crawl.
  test("pathologically nested markup degrades instead of throwing", () => {
    const deep = `<html><body><main>${"<div>".repeat(20_000)}DEEP_CONTENT${"</div>".repeat(20_000)}</main></body></html>`;
    let md = "";
    expect(() => {
      md = htmlToMarkdown(deep, PAGE_URL);
    }).not.toThrow();
    expect(md).toContain("DEEP_CONTENT");
  });

  test("the deep-markup fallback cannot emit forged Markdown", () => {
    const deep = `<html><body><main>${"<div>".repeat(20_000)}# FORGED [click](javascript:alert(1))${"</div>".repeat(20_000)}</main></body></html>`;
    const md = htmlToMarkdown(deep, PAGE_URL);
    expect(md).not.toMatch(/^# FORGED/);
    expect(md).not.toMatch(/(?<!\\)\]\(javascript:/);
  });

  // LOW: Turndown does not escape `<`, so visible page text written as
  // &lt;script&gt; became a live tag in the markdown.
  test("entity-encoded markup stays inert in the output", () => {
    const html = `<html><body><main><p>&lt;script&gt;alert(1)&lt;/script&gt;</p></main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).not.toContain("<script>");
    expect(md).not.toContain("<img");
  });

  // LOW: parens in a destination truncated the link and spilled markup.
  test("a URL containing parens is wrapped so it cannot truncate", () => {
    const html = `<html><body><main><a href="https://ok.example/a(b)c">L</a></main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).toContain("[L](https://ok.example/a%28b%29c)");
  });

  // LOW: credentials are rejected on input URLs; they must not re-enter
  // through a link inside page content.
  test("embedded credentials are stripped from emitted links", () => {
    const html = `<html><body><main><a href="https://user:pw@ok.example/x">L</a></main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).not.toContain("user:pw");
    expect(md).toContain("https://ok.example/x");
  });
});

describe("codex review regressions", () => {
  // Alt text participates in markdown syntax, so a validated src alone does
  // not uphold the scheme invariant: `x](javascript:...)` in alt emits a
  // second, unvalidated destination ahead of the real one.
  test("image alt text cannot inject a second destination", () => {
    const html = `<html><body><main><img src="https://ok.example/a.png" alt="x](javascript:alert(1))"></main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).not.toMatch(/(?<!\\)\]\(javascript:/);
    expect(md).toContain("https://ok.example/a.png");
  });

  test("link label text cannot inject a second destination", () => {
    const html = `<html><body><main><a href="https://ok.example/x">a](javascript:alert(1))b</a></main></body></html>`;
    const md = htmlToMarkdown(html, PAGE_URL);
    expect(md).not.toMatch(/(?<!\\)\]\(javascript:/);
  });
});
