// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type HTMLElement, parse } from "node-html-parser";
import TurndownService from "turndown";

/**
 * Main-content extraction and HTML -> Markdown conversion for website snapshots.
 *
 * Replaces the hand-rolled regex converter that previously lived in
 * `website-ingest.ts`. Two behaviors from that converter are load-bearing and
 * are preserved here deliberately:
 *
 *   1. `<script>` / `<style>` / `<noscript>` / `<template>` content must never
 *      reach the markdown. Enforced twice — stripped from the parsed DOM AND
 *      registered with Turndown's `remove()` — because a snapshot is fed to
 *      agents as trusted knowledge and inline JS masquerading as prose is a
 *      prompt-injection vector.
 *   2. Only `http:` / `https:` links are emitted as markdown links. Anything
 *      else (`javascript:`, `data:`, `file:`, …) degrades to its plain text
 *      label rather than becoming a clickable link in agent-facing content.
 */

/** Blocks removed wholesale before conversion — never contribute prose. */
const DANGEROUS_TAGS = ["script", "style", "noscript", "template"] as const;

/**
 * Chrome stripped only when falling back to `<body>`. Not applied when a
 * semantic content region matched: a `<nav>` nested inside `<article>` is
 * usually in-article navigation worth keeping.
 */
const CHROME_TAGS = ["nav", "header", "footer", "aside"] as const;

/**
 * Content-region selectors in priority order. First match wins, so semantic
 * HTML beats class-name heuristics.
 */
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
 * Select the main-content region of a document and return its HTML.
 *
 * Falls back to `<body>` minus page chrome, then to the whole document, so a
 * page with no semantic markup still yields content rather than nothing.
 */
export function extractMainContentHtml(html: string): string {
  const root = parse(html, { comment: false });
  stripDangerousNodes(root);

  for (const selector of CONTENT_SELECTORS) {
    const match = root.querySelector(selector);
    // Ignore a region that matched structurally but carries no prose — a
    // decorative `<main>` wrapper should not shadow the real content below it.
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

function createTurndown(pageUrl: string): TurndownService {
  const service = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    emDelimiter: "_",
    bulletListMarker: "-",
  });

  // Defense in depth: these are already gone from the DOM, but a caller
  // converting raw HTML directly must not be able to leak them either.
  service.remove([...DANGEROUS_TAGS]);

  service.addRule("fencedCodeBlock", {
    filter: (node: Node): boolean =>
      node.nodeName === "PRE" && Boolean(node.firstChild) && node.firstChild?.nodeName === "CODE",
    replacement: (_content: string, node: Node): string => {
      const code = node.firstChild as (Element & { textContent: string }) | null;
      const language = fenceLanguage(code?.getAttribute?.("class") ?? "");
      const text = (code?.textContent ?? "").replace(/\n+$/, "");
      if (!text.trim()) return "\n\n";
      return `\n\n\`\`\`${language}\n${text}\n\`\`\`\n\n`;
    },
  });

  service.addRule("safeLink", {
    filter: (node: Node): boolean => node.nodeName === "A",
    replacement: (content: string, node: Node): string => {
      const label = content.trim();
      if (!label) return "";
      const href = (node as Element).getAttribute("href");
      if (!href) return label;
      try {
        const resolved = new URL(href, pageUrl);
        // Non-http(s) schemes degrade to plain text rather than becoming a
        // clickable link — see the module header.
        return isSafeLinkUrl(resolved) ? `[${label}](${resolved.toString()})` : label;
      } catch {
        return label;
      }
    },
  });

  return service;
}

/**
 * Convert a page to Markdown, scoped to its main-content region.
 *
 * `pageUrl` resolves relative hrefs; it is not fetched.
 */
export function htmlToMarkdown(html: string, pageUrl: string): string {
  const contentHtml = extractMainContentHtml(html);
  const markdown = createTurndown(pageUrl).turndown(contentHtml);
  return markdown
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
  const root = parse(html, { comment: false });
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
