// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type HTMLElement, parse } from "node-html-parser";
import TurndownService from "turndown";

/**
 * Main-content extraction and HTML -> Markdown conversion for website snapshots.
 *
 * Snapshots are read back by agents as trusted knowledge, so anything a hostile
 * page can smuggle into the markdown is a prompt-injection vector. Three
 * invariants are load-bearing and each is enforced defensively:
 *
 *   1. `<script>` / `<style>` / `<noscript>` / `<template>` bodies never reach
 *      the markdown.
 *   2. Only `http:` / `https:` URLs are emitted as links or images; anything
 *      else degrades to plain text.
 *   3. A page cannot forge document structure — code fences are sized so their
 *      content cannot close them early.
 */

const DANGEROUS_TAGS = ["script", "style", "noscript", "template"] as const;

/**
 * Chrome stripped only when falling back to `<body>`. Not applied when a
 * semantic content region matched: a `<nav>` nested inside `<article>` is
 * usually in-article navigation worth keeping.
 */
const CHROME_TAGS = ["nav", "header", "footer", "aside"] as const;

/** Content-region selectors in priority order; semantic HTML beats classes. */
const CONTENT_SELECTORS = [
  "main",
  "article",
  '[role="main"]',
  "#content",
  "#main-content",
  "#docs-content",
  ".markdown-body",
  ".main-content",
  ".docs-content",
  ".content",
] as const;

/**
 * Remove raw-text blocks textually, BEFORE the DOM parse.
 *
 * This is the security boundary, not `querySelectorAll("script").remove()`.
 * `node-html-parser` only closes a raw-text element on an exactly-matching
 * lowercase `</script>`; browsers additionally accept `</SCRIPT>`,
 * `</script >`, `</script/>`, `</script foo>` and `</ script>`. On any of
 * those the parser never creates a `script` element at all and serializes the
 * script *body* as ordinary text — so DOM-level removal silently does nothing
 * and the payload lands in the snapshot while the page renders normally in a
 * browser. An unterminated `<script>` at EOF has the same effect.
 */
function scrubDangerousMarkup(html: string): string {
  let out = html;
  for (const tag of DANGEROUS_TAGS) {
    // Tolerate any end-tag spelling a browser would accept.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/\\s*${tag}\\b[^>]*>`, "gi"), " ");
    // Unterminated open tag: everything to EOF is inside the raw-text element.
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "i"), " ");
    // Any stray leftover tag of this kind.
    out = out.replace(new RegExp(`<\\/?\\s*${tag}\\b[^>]*>`, "gi"), " ");
  }
  return out;
}

function stripDangerousNodes(root: HTMLElement): void {
  for (const tag of DANGEROUS_TAGS) {
    for (const node of root.querySelectorAll(tag)) node.remove();
  }
}

/** True for the only link schemes we will emit into agent-facing markdown. */
export function isSafeLinkUrl(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

/**
 * Resolve an href/src for emission: absolute, http(s) only, credentials
 * stripped. Returns null when the URL must not be emitted.
 */
function resolveEmittableUrl(raw: string, pageUrl: string): string | null {
  try {
    const resolved = new URL(raw, pageUrl);
    if (!isSafeLinkUrl(resolved)) return null;
    // `validateWebsiteUrl` rejects credentials on input URLs; do not let them
    // re-enter through a link inside page content.
    resolved.username = "";
    resolved.password = "";
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * Escape characters that would let attacker-controlled text break out of a
 * markdown link/image and start a new one. `alt` and link labels are raw page
 * strings; an alt of `x](javascript:alert(1))` otherwise emits a second,
 * unvalidated destination ahead of the validated `src`.
 */
function escapeMarkdownLabel(value: string): string {
  return value
    .replace(/([\\[\]])/g, "\\$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Percent-encode parens in a link destination. Unescaped parens truncate the
 * link and spill the remainder into the document as live markup. Encoding
 * (rather than the `<...>` destination form) keeps the result free of `<`, so
 * {@link escapeResidualMarkup} cannot corrupt it afterwards.
 */
function markdownDestination(url: string): string {
  return url.replaceAll("(", "%28").replaceAll(")", "%29");
}

/**
 * Guard against pathological nesting. `node-html-parser` and Turndown both
 * recurse, and ~20k nested elements (well under the page byte cap) overflows
 * the stack — which would otherwise abort an entire crawl.
 */
const MAX_NESTING_DEPTH = 2_000;

function exceedsNestingBudget(html: string): boolean {
  let depth = 0;
  let max = 0;
  const tagPattern = /<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g;
  for (const match of html.matchAll(tagPattern)) {
    const closing = match[1] === "/";
    const selfClosing = match[3] === "/";
    if (selfClosing) continue;
    if (closing) depth = Math.max(0, depth - 1);
    else {
      depth += 1;
      if (depth > max) max = depth;
      if (max > MAX_NESTING_DEPTH) return true;
    }
  }
  return false;
}

/** Last-resort conversion when the document is too deep to parse safely. */
function plainTextFallback(html: string): string {
  return scrubDangerousMarkup(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Select the main-content region of a document and return its HTML.
 *
 * Falls back to `<body>` minus page chrome, then to the whole document, so a
 * page with no semantic markup still yields content rather than nothing.
 */
export function extractMainContentHtml(html: string): string {
  const root = parse(scrubDangerousMarkup(html), { comment: false });
  stripDangerousNodes(root);

  for (const selector of CONTENT_SELECTORS) {
    const match = root.querySelector(selector);
    // Ignore a region that matched structurally but carries no prose — a
    // decorative wrapper should not shadow the real content below it.
    if (match && match.textContent.trim()) return match.toString();
  }

  const body = root.querySelector("body");
  if (body) {
    for (const tag of CHROME_TAGS) {
      for (const node of body.querySelectorAll(tag)) node.remove();
    }
    if (body.textContent.trim()) return body.toString();
  }

  return root.toString();
}

/** Read a fence language off `class="language-ts"` / `class="lang-ts"`. */
function fenceLanguage(className: string): string {
  return /(?:language|lang)-([\w+#-]+)/.exec(className)?.[1] ?? "";
}

/**
 * Size a fence so its own content cannot close it. Turndown's default rule
 * does this; the custom rule below must not regress it, or a page can end the
 * fence early and inject forged headings and prose into the snapshot.
 */
function fenceFor(code: string): string {
  let longest = 0;
  for (const run of code.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

function createTurndown(pageUrl: string): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    bulletListMarker: "-",
  });

  // Defense in depth: these are already scrubbed textually and removed from
  // the DOM. A caller converting raw HTML must not be able to leak them either.
  service.remove([...DANGEROUS_TAGS]);

  service.addRule("fencedCodeBlock", {
    filter: (node: Node): boolean =>
      node.nodeName === "PRE" && Boolean(node.firstChild) && node.firstChild?.nodeName === "CODE",
    replacement: (_content: string, node: Node): string => {
      const code = node.firstChild as (Element & { textContent: string }) | null;
      const language = fenceLanguage(code?.getAttribute?.("class") ?? "");
      const text = (code?.textContent ?? "").replace(/\n+$/, "");
      if (!text.trim()) return "\n\n";
      const fence = fenceFor(text);
      return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
    },
  });

  service.addRule("safeLink", {
    filter: (node: Node): boolean => node.nodeName === "A",
    replacement: (content: string, node: Node): string => {
      const label = content.trim();
      if (!label) return "";
      const href = (node as Element).getAttribute("href");
      if (!href) return label;
      const resolved = resolveEmittableUrl(href, pageUrl);
      if (!resolved) return label;
      return `[${escapeMarkdownLabel(label)}](${markdownDestination(resolved)})`;
    },
  });

  // Turndown's built-in image rule emits `src` verbatim — no scheme check and
  // no base resolution — so `javascript:` / `data:` srcs would slip past the
  // anchor policy entirely.
  service.addRule("safeImage", {
    filter: (node: Node): boolean => node.nodeName === "IMG",
    replacement: (_content: string, node: Node): string => {
      const element = node as Element;
      const alt = escapeMarkdownLabel(element.getAttribute("alt") ?? "");
      const src = element.getAttribute("src");
      if (!src) return alt;
      const resolved = resolveEmittableUrl(src, pageUrl);
      return resolved ? `![${alt}](${markdownDestination(resolved)})` : alt;
    },
  });

  return service;
}

/**
 * Escape markup that survives conversion as literal text.
 *
 * Turndown does not escape `<`, so page text written as `&lt;script&gt;`
 * (harmless, visible text on the page) would otherwise become a live
 * `<script>` tag in the markdown and execute in any renderer that passes raw
 * HTML through.
 */
function escapeResidualMarkup(markdown: string): string {
  // Only `<` that begins a tag-like construct; a bare `a < b` stays readable.
  return markdown.replace(/<(?=[a-zA-Z/!?])/g, "&lt;");
}

/**
 * Convert a page to Markdown, scoped to its main-content region.
 *
 * `pageUrl` resolves relative hrefs; it is not fetched.
 */
export function htmlToMarkdown(html: string, pageUrl: string): string {
  let markdown: string;
  if (exceedsNestingBudget(html)) {
    markdown = plainTextFallback(html);
  } else {
    try {
      markdown = createTurndown(pageUrl).turndown(extractMainContentHtml(html));
    } catch {
      // Depth budget is a heuristic; a parser or converter blow-up must
      // degrade this page, never abort the surrounding crawl.
      markdown = plainTextFallback(html);
    }
  }
  return escapeResidualMarkup(markdown)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Collect links from the WHOLE document, not the extracted content region.
 *
 * Deliberate and load-bearing: nav/header/footer links are how a crawl
 * discovers pages. Narrowing this to the content region would silently shrink
 * every crawl to whatever the first page happens to link inline.
 */
export function extractDocumentLinks(html: string, pageUrl: string): URL[] {
  const links: URL[] = [];
  let anchors: { getAttribute(name: string): string | undefined }[];
  try {
    anchors = parse(scrubDangerousMarkup(html), { comment: false }).querySelectorAll("a");
  } catch {
    return links;
  }
  for (const anchor of anchors) {
    const href = anchor.getAttribute("href")?.trim();
    if (!href || href.startsWith("#")) continue;
    try {
      const resolved = new URL(href, pageUrl);
      if (isSafeLinkUrl(resolved)) links.push(resolved);
    } catch {
      /* ignore malformed hrefs */
    }
  }
  return links;
}
