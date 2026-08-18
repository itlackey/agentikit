// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type HTMLElement, parse } from "node-html-parser";
import TurndownService from "turndown";
import { escapeMarkdownStructure } from "./fetcher-util";

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
 * Scrub patterns for {@link scrubDangerousMarkup}, compiled once at module
 * load rather than per call — this runs on every crawled page.
 */
const DANGEROUS_TAG_PATTERNS = DANGEROUS_TAGS.map((tag) => ({
  // A full block with any end-tag spelling a browser would accept.
  full: new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/\\s*${tag}\\b[^>]*>`, "gi"),
  // Unterminated open tag: everything to EOF is inside the raw-text element.
  unterminated: new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "i"),
  // Any stray leftover tag of this kind.
  stray: new RegExp(`<\\/?\\s*${tag}\\b[^>]*>`, "gi"),
}));

const PAGE_CHROME_SELECTORS = ["nav", "header", "footer", "aside"] as const;

/** Inform-parity classed chrome removed from whichever content region wins. */
const UNWANTED_CLASS_SELECTORS = [
  ".nav",
  ".navigation",
  ".menu",
  ".sidebar",
  ".advertisement",
  ".ad",
  ".social",
  ".share",
  ".comments",
  ".related",
  ".breadcrumb",
  ".breadcrumbs",
  ".cookie-notice",
  ".popup",
  ".modal",
  ".overlay",
] as const;

/** Content-region selectors in priority order; narrow regions beat app shells. */
const CONTENT_SELECTORS = [
  ".markdown-body",
  ".article-content",
  ".entry-content",
  ".post-content",
  ".docs-content",
  ".main-content",
  "#docs-content",
  "#main-content",
  '[role="main"]',
  "main",
  "article",
  "#content",
  ".content",
] as const;

const ARTICLE_METADATA_SELECTORS = new Set([".article-content", ".entry-content", ".post-content"]);

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
  for (const pattern of DANGEROUS_TAG_PATTERNS) {
    out = out.replace(pattern.full, " ").replace(pattern.unterminated, " ").replace(pattern.stray, " ");
  }
  return out;
}

function stripDangerousNodes(root: HTMLElement): void {
  for (const tag of DANGEROUS_TAGS) {
    for (const node of root.querySelectorAll(tag)) node.remove();
  }
}

function isExplicitlyHidden(node: HTMLElement): boolean {
  if (node.hasAttribute("hidden") || node.hasAttribute("inert")) return true;
  if (node.getAttribute("aria-hidden")?.toLowerCase() === "true") return true;
  const style = node.getAttribute("style")?.toLowerCase();
  if (!style) return false;
  return style.split(";").some((declaration) => {
    const [property, value] = declaration.split(":", 2).map((part) => part?.trim());
    return (
      (property === "display" && value?.startsWith("none")) ||
      (property === "visibility" && value?.startsWith("hidden"))
    );
  });
}

function isHiddenRegion(node: HTMLElement): boolean {
  let current: HTMLElement | null = node;
  while (current) {
    if (isExplicitlyHidden(current)) return true;
    const parentNode = current.parentNode as HTMLElement | null;
    current = parentNode && typeof parentNode.tagName === "string" ? parentNode : null;
  }
  return false;
}

function isInUnwantedRegion(node: HTMLElement): boolean {
  let current: HTMLElement | null = node;
  while (current) {
    const tagName = current.tagName.toLowerCase();
    if (PAGE_CHROME_SELECTORS.some((selector) => selector === tagName)) return true;
    const classes = new Set((current.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
    if (UNWANTED_CLASS_SELECTORS.some((selector) => classes.has(selector.slice(1)))) return true;
    const parentNode = current.parentNode as HTMLElement | null;
    current = parentNode && typeof parentNode.tagName === "string" ? parentNode : null;
  }
  return false;
}

function stripUnwantedNodes(root: HTMLElement, preserveSemanticChrome = false): void {
  for (const node of root.querySelectorAll("*")) {
    if (isExplicitlyHidden(node)) node.remove();
  }
  for (const selector of PAGE_CHROME_SELECTORS) {
    if (preserveSemanticChrome && selector !== "nav") continue;
    for (const node of root.querySelectorAll(selector)) {
      node.remove();
    }
  }
  for (const selector of UNWANTED_CLASS_SELECTORS) {
    for (const node of root.querySelectorAll(selector)) node.remove();
  }
}

function enclosingArticle(node: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = node;
  while (current) {
    if (typeof current.tagName === "string" && current.tagName.toLowerCase() === "article") return current;
    const parentNode: HTMLElement | null = current.parentNode as HTMLElement | null;
    current = parentNode && typeof parentNode.tagName === "string" ? parentNode : null;
  }
  return null;
}

function hasMatchingAncestor(candidate: HTMLElement, matches: Set<HTMLElement>): boolean {
  let current = candidate.parentNode as HTMLElement | null;
  while (current && typeof current.tagName === "string") {
    if (matches.has(current)) return true;
    current = current.parentNode as HTMLElement | null;
  }
  return false;
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

/**
 * HTML5 void elements. They have no closing tag and are conventionally written
 * WITHOUT a trailing slash, so a depth counter that only decrements on `</x>`
 * or `<x/>` treats each one as a permanent +1. The counter then measured total
 * void-element COUNT rather than nesting depth, and an ordinary page with more
 * than MAX_NESTING_DEPTH images or line breaks was misjudged as pathologically
 * nested and degraded to plain text.
 */
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function exceedsNestingBudget(html: string): boolean {
  let depth = 0;
  let max = 0;
  const tagPattern = /<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g;
  for (const match of html.matchAll(tagPattern)) {
    const closing = match[1] === "/";
    const selfClosing = match[3] === "/";
    if (selfClosing) continue;
    if (VOID_ELEMENTS.has(match[2]!.toLowerCase())) continue;
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
  const text = scrubDangerousMarkup(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return escapeMarkdownStructure(text.replace(/([\\[\]`])/g, "\\$1"));
}

/**
 * Select the main-content region of a document and return its HTML.
 *
 * Falls back to `<body>` minus page chrome, then to the whole document, so a
 * page with no semantic markup still yields content rather than nothing.
 */
/**
 * Select the content region from an already-parsed, already-scrubbed root
 * (dangerous nodes removed). Mutates the root when it falls back to `<body>`.
 */
function selectMainContentFromRoot(root: HTMLElement): string {
  for (const selector of CONTENT_SELECTORS) {
    const candidates = root
      .querySelectorAll(selector)
      .filter((match) => match.textContent.trim() && !isHiddenRegion(match) && !isInUnwantedRegion(match));
    const candidateSet = new Set(candidates);
    const matches = candidates.filter((match) => !hasMatchingAncestor(match, candidateSet));
    // Repeated cards/articles usually form a listing. Let a broader primary
    // container (or the body fallback) retain all of them instead of silently
    // truncating the page to the first match.
    if (matches.length > 1) continue;
    const match = matches[0];
    // Ignore a region that matched structurally but carries no prose — a
    // decorative wrapper should not shadow the real content below it.
    if (match) {
      const region = ARTICLE_METADATA_SELECTORS.has(selector) ? (enclosingArticle(match) ?? match) : match;
      stripUnwantedNodes(region, true);
      if (region.textContent.trim()) return region.toString();
    }
  }

  const body = root.querySelector("body");
  if (body) {
    stripUnwantedNodes(body);
    if (body.textContent.trim()) return body.toString();
  }

  stripUnwantedNodes(root);
  return root.toString();
}

export function extractMainContentHtml(html: string): string {
  const root = parse(scrubDangerousMarkup(html), { comment: false });
  stripDangerousNodes(root);
  return selectMainContentFromRoot(root);
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

  const tableSupport = new WeakMap<Node, boolean>();
  const tableFor = (node: Node): Element | null => {
    let current: Node | null = node;
    while (current) {
      if (current.nodeName === "TABLE") return current as Element;
      current = current.parentNode;
    }
    return null;
  };
  const cellsFor = (row: Element): Element[] =>
    Array.from(row.childNodes).filter(
      (child): child is ChildNode & Element => child.nodeName === "TH" || child.nodeName === "TD",
    );
  const hasUnsupportedSpan = (cell: Element): boolean => {
    const colspan = cell.getAttribute("colspan");
    const rowspan = cell.getAttribute("rowspan");
    return (colspan !== null && colspan !== "1") || (rowspan !== null && rowspan !== "1");
  };
  const isSupportedTable = (table: Element): boolean => {
    const cached = tableSupport.get(table);
    if (cached !== undefined) return cached;
    const hasAncestorTable = table.parentNode !== null && tableFor(table.parentNode) !== null;
    let ancestor = table.parentNode;
    while (ancestor) {
      if (ancestor.nodeName === "TABLE") {
        tableSupport.set(table, false);
        return false;
      }
      ancestor = ancestor.parentNode;
    }
    const rows: Element[] = [];
    let hasCaption = false;
    let hasNestedTable = false;
    const visit = (node: Node): void => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeName === "TABLE") {
          hasNestedTable = true;
          continue;
        }
        if (child.nodeName === "CAPTION") hasCaption = true;
        if (child.nodeName === "TR") rows.push(child as ChildNode & Element);
        visit(child);
      }
    };
    visit(table);
    const firstCells = rows[0] ? cellsFor(rows[0]) : [];
    const supported =
      rows.length > 0 &&
      !hasAncestorTable &&
      !hasCaption &&
      !hasNestedTable &&
      firstCells.length > 0 &&
      firstCells.every((cell) => cell.nodeName === "TH" && !hasUnsupportedSpan(cell)) &&
      rows.slice(1).every((row) => {
        const cells = cellsFor(row);
        return (
          cells.length === firstCells.length &&
          cells.every((cell) => cell.nodeName === "TD" && !hasUnsupportedSpan(cell))
        );
      });
    tableSupport.set(table, supported);
    return supported;
  };
  const isInSupportedTable = (node: Node): boolean => {
    const table = tableFor(node);
    return table !== null && isSupportedTable(table);
  };

  service.addRule("tableCell", {
    filter: (node: Node): boolean => (node.nodeName === "TH" || node.nodeName === "TD") && isInSupportedTable(node),
    replacement: (content: string): string => {
      const cell = content
        .replace(/\|/g, "\\|")
        .replace(/\r?\n+/g, " ")
        .trim();
      return ` ${cell} |`;
    },
  });

  service.addRule("tableRow", {
    filter: (node: Node): boolean => node.nodeName === "TR" && isInSupportedTable(node),
    replacement: (content: string, node: Node): string => {
      const cells = Array.from(node.childNodes).filter((child) => child.nodeName === "TH" || child.nodeName === "TD");
      if (cells.length === 0) return "";
      const row = `|${content.trimEnd()}\n`;
      const isHeader = cells.every((cell) => cell.nodeName === "TH");
      return isHeader ? `${row}|${cells.map(() => " --- |").join("")}\n` : row;
    },
  });

  service.addRule("table", {
    filter: (node: Node): boolean => node.nodeName === "TABLE" && isInSupportedTable(node),
    replacement: (content: string): string => `\n\n${content.trim().replace(/\n\s*\n/g, "\n")}\n\n`,
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
 * Apply {@link escapeResidualMarkup} everywhere EXCEPT inside fenced code
 * blocks.
 *
 * Markup inside a fence is inert — a renderer shows it as text, it cannot
 * execute — so the escape buys no safety there and actively corrupts content.
 * Turndown emits code with entities already decoded, so a documentation page
 * showing `&lt;div&gt;` in a `<pre><code>` block became a fence containing
 * `<div>`, which this rewrote to `&lt;div>`: a half-escaped, wrong-on-both-ends
 * rendering of the example the page exists to show. Every HTML, XML and JSX
 * snippet in a snapshot was affected.
 */
function escapeOutsideCodeFences(markdown: string): string {
  const lines = markdown.split("\n");
  let inFence = false;
  let fenceMarker = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      if (!inFence) {
        inFence = true;
        fenceMarker = marker[0]!;
      } else if (marker[0] === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (!inFence) lines[i] = escapeResidualMarkup(line);
  }
  return lines.join("\n");
}

/** Escape residual markup, then normalize whitespace, into the final snapshot. */
function finalizeMarkdown(markdown: string): string {
  return escapeOutsideCodeFences(markdown)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Turn an already-scrubbed root into snapshot Markdown (mutates the root). */
function markdownFromRoot(root: HTMLElement, html: string, pageUrl: string): string {
  if (exceedsNestingBudget(html)) return plainTextFallback(html);
  try {
    stripDangerousNodes(root);
    return createTurndown(pageUrl).turndown(selectMainContentFromRoot(root));
  } catch {
    // Depth budget is a heuristic; a parser or converter blow-up must
    // degrade this page, never abort the surrounding crawl.
    return plainTextFallback(html);
  }
}

/**
 * Collect http(s) links from an already-parsed, already-scrubbed root. Read
 * BEFORE any content-region mutation so nav/header/footer links survive.
 */
function collectLinksFromRoot(root: HTMLElement, pageUrl: string): URL[] {
  const links: URL[] = [];
  for (const anchor of root.querySelectorAll("a")) {
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
      markdown = plainTextFallback(html);
    }
  }
  return finalizeMarkdown(markdown);
}

/**
 * Crawl-path entry point: convert a page AND collect its links from a SINGLE
 * parse. The content region and the whole-document link set both derive from
 * the same DOM, so a crawled page is scrubbed and parsed once, not twice.
 *
 * Links are collected from the whole document (nav/header/footer included —
 * that is how a crawl discovers pages) and read before the content-region
 * selection mutates the tree.
 */
export function htmlToMarkdownAndLinks(html: string, pageUrl: string): { markdown: string; links: URL[] } {
  let root: HTMLElement | null = null;
  try {
    root = parse(scrubDangerousMarkup(html), { comment: false });
  } catch {
    root = null;
  }
  const links = root ? collectLinksFromRoot(root, pageUrl) : [];
  const markdown = root ? markdownFromRoot(root, html, pageUrl) : plainTextFallback(html);
  return { markdown: finalizeMarkdown(markdown), links };
}

/**
 * Collect links from the WHOLE document, not the extracted content region.
 *
 * Deliberate and load-bearing: nav/header/footer links are how a crawl
 * discovers pages. Narrowing this to the content region would silently shrink
 * every crawl to whatever the first page happens to link inline.
 */
export function extractDocumentLinks(html: string, pageUrl: string): URL[] {
  let root: HTMLElement;
  try {
    root = parse(scrubDangerousMarkup(html), { comment: false });
  } catch {
    return [];
  }
  return collectLinksFromRoot(root, pageUrl);
}
