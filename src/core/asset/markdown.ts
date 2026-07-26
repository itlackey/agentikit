// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { parseFrontmatter } from "./frontmatter";

// ── Types ───────────────────────────────────────────────────────────────────

export interface TocHeading {
  level: number;
  text: string;
  line: number;
}

export interface KnowledgeToc {
  headings: TocHeading[];
  totalLines: number;
}

/** Stable GitHub-style selector for a Markdown heading. */
export function markdownHeadingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]+/gu, "-")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function markdownFragmentSlugs(content: string): string[] {
  return uniqueHeadingSlugs(parseMarkdownToc(content).headings).filter(Boolean);
}

function uniqueHeadingSlugs(headings: TocHeading[]): string[] {
  const used = new Set<string>();
  return headings.map((heading) => {
    const base = markdownHeadingSlug(heading.text);
    if (!base) return "";
    let slug = base;
    let suffix = 0;
    while (used.has(slug)) slug = `${base}-${++suffix}`;
    used.add(slug);
    return slug;
  });
}

// ── Parsing ─────────────────────────────────────────────────────────────────

export function parseMarkdownToc(content: string): KnowledgeToc {
  const lines = content.split(/\r?\n/);
  const headings: TocHeading[] = [];

  const parsed = parseFrontmatter(content);
  const start = parsed.frontmatter ? parsed.bodyStartLine - 1 : 0;

  let inFence = false;
  for (let i = start; i < lines.length; i++) {
    // Track fenced code blocks (``` or ~~~) so headings inside them are skipped.
    if (/^\s*(`{3,}|~{3,})/.test(lines[i]!)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = lines[i]!.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      headings.push({
        level: match[1]!.length,
        text: match[2]!.replace(/\s+#+\s*$/, "").trim(),
        line: i + 1,
      });
    }
  }

  return { headings, totalLines: lines.length };
}

// ── Extraction ──────────────────────────────────────────────────────────────

export function extractSection(
  content: string,
  heading: string,
): { content: string; startLine: number; endLine: number } | null {
  const lines = content.split(/\r?\n/);
  const headings = parseMarkdownToc(content).headings;
  const fragment = heading.trim();
  const slugIndex = uniqueHeadingSlugs(headings).indexOf(fragment);
  const exact =
    slugIndex < 0 ? headings.find((candidate) => candidate.text.toLowerCase() === fragment.toLowerCase()) : undefined;
  const selected = slugIndex >= 0 ? headings[slugIndex] : exact;
  if (!selected) return null;

  const next = headings.find((candidate) => candidate.line > selected.line && candidate.level <= selected.level);
  const startIdx = selected.line - 1;
  const endIdx = next ? next.line - 1 : lines.length;
  return {
    content: lines.slice(startIdx, endIdx).join("\n"),
    startLine: selected.line,
    endLine: endIdx,
  };
}

export function extractLineRange(content: string, start: number, end: number): string {
  const lines = content.split(/\r?\n/);
  if (end < start) return "";
  const s = Math.max(1, Math.min(start, lines.length));
  const e = Math.min(end, lines.length);
  return lines.slice(s - 1, e).join("\n");
}

export function extractFrontmatterOnly(content: string): string | null {
  const parsed = parseFrontmatter(content);
  return parsed.frontmatter;
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatToc(toc: KnowledgeToc): string {
  if (toc.headings.length === 0) {
    return `(no headings found — ${toc.totalLines} lines total)`;
  }

  const lineWidth = String(toc.totalLines).length;
  const parts = toc.headings.map((h) => {
    const lineNum = `L${String(h.line).padStart(lineWidth)}`;
    const indent = "  ".repeat(h.level - 1);
    const prefix = "#".repeat(h.level);
    return `${lineNum}  ${indent}${prefix} ${h.text}`;
  });

  parts.push(`\n${toc.totalLines} lines total`);
  return parts.join("\n");
}

// ── Fence stripping ──────────────────────────────────────────────────────────

/**
 * Best-effort fence stripping. Strips `<think>` reasoning blocks emitted by
 * local LLMs (e.g. Qwen3) before the content, which otherwise breaks YAML
 * frontmatter detection. Only strips outer triple-fence pairs — leaves inner
 * code blocks intact.
 */
export function stripMarkdownFences(raw: string): string {
  const stripped = raw
    .trim()
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
  const fence = stripped.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fence) return fence[1]!.trim();
  return stripped;
}
