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
