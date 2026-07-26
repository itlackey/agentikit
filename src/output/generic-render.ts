// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Generic `md` / `html` rendering of a shaped output envelope (D7).
 *
 * Every command gets `json`, `jsonl`, and `yaml` for free because those are
 * serializations of the envelope rather than renderings of it. `md` and `html`
 * are renderings, and before D7 only `akm health` had them: `md` silently
 * emitted the JSON envelope everywhere else and `html` threw. Three failure
 * modes on one documented-Stable contract.
 *
 * These functions close that gap structurally rather than per command. A
 * command that registers a bespoke renderer (`akm health`) still wins; every
 * other command falls back to a real rendering derived from whatever its
 * envelope happens to contain. The shape is discovered, not declared, so a new
 * command is covered the day it is added.
 *
 * Deliberately dependency-free apart from the shared detail types: this module
 * sits underneath the per-command renderer registries and must not import
 * them.
 */

/** A row of an array-of-uniform-objects table: every entry shares these keys. */
type TableRow = Record<string, unknown>;

/**
 * True when `value` is a non-empty array of plain objects — the shape worth
 * rendering as a table rather than as a nested list. Uniformity is judged on
 * the union of keys, not on strict equality, so one row carrying an extra
 * optional field still tabulates (its column is simply blank elsewhere).
 */
function isTabular(value: unknown): value is TableRow[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((row) => row !== null && typeof row === "object" && !Array.isArray(row));
}

/** Column order for a table: first appearance across all rows, order-stable. */
function tableColumns(rows: readonly TableRow[]): string[] {
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  return columns;
}

/**
 * Render a leaf value for display. Objects and arrays that reach a cell are
 * JSON-encoded rather than expanded — a table cell is not a place to nest.
 */
function displayScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

// ── Markdown ─────────────────────────────────────────────────────────────────

/** Escape the one character that can break a Markdown table row. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function markdownTable(rows: readonly TableRow[]): string[] {
  const columns = tableColumns(rows);
  if (columns.length === 0) return [];
  const lines = [
    `| ${columns.join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${columns.map((c) => escapeCell(displayScalar(row[c]))).join(" | ")} |`),
  ];
  return lines;
}

function markdownValue(value: unknown, depth: number): string[] {
  if (isTabular(value)) return markdownTable(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return ["_(none)_"];
    return value.map((item) => `- ${escapeCell(displayScalar(item))}`);
  }
  if (value !== null && typeof value === "object") {
    const lines: string[] = [];
    for (const [key, nested] of Object.entries(value)) {
      // Headings stop at h6; deeper nesting continues as bolded labels.
      const heading = "#".repeat(Math.min(depth, 6));
      lines.push(depth <= 6 ? `${heading} ${key}` : `**${key}**`, "", ...markdownValue(nested, depth + 1), "");
    }
    return lines;
  }
  return [displayScalar(value) === "" ? "_(empty)_" : displayScalar(value)];
}

/**
 * Render a shaped envelope as Markdown. `command` titles the document so a
 * rendered file identifies itself once detached from the invocation.
 */
export function renderGenericMarkdown(command: string, value: unknown): string {
  const body =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value).flatMap(([key, nested]) => [`## ${key}`, "", ...markdownValue(nested, 3), ""])
      : markdownValue(value, 2);
  const lines = [`# ${command}`, "", ...body];
  const rendered = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return `${rendered}\n`;
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape every value that reaches the document — this is untrusted content. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

function htmlTable(rows: readonly TableRow[]): string {
  const columns = tableColumns(rows);
  if (columns.length === 0) return "";
  const head = `<tr>${columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join("")}</tr>`;
  const body = rows
    .map((row) => `<tr>${columns.map((c) => `<td>${escapeHtml(displayScalar(row[c]))}</td>`).join("")}</tr>`)
    .join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function htmlValue(value: unknown, depth: number): string {
  if (isTabular(value)) return htmlTable(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "<p><em>(none)</em></p>";
    return `<ul>${value.map((item) => `<li>${escapeHtml(displayScalar(item))}</li>`).join("")}</ul>`;
  }
  if (value !== null && typeof value === "object") {
    const level = Math.min(depth, 6);
    return Object.entries(value)
      .map(([key, nested]) => `<h${level}>${escapeHtml(key)}</h${level}>${htmlValue(nested, depth + 1)}`)
      .join("");
  }
  const scalar = displayScalar(value);
  return scalar === "" ? "<p><em>(empty)</em></p>" : `<p>${escapeHtml(scalar)}</p>`;
}

/**
 * Render a shaped envelope as a self-contained HTML document.
 *
 * Self-contained matters: the output is routinely redirected to a file and
 * opened directly, so it carries its own minimal styling and references
 * nothing external.
 */
export function renderGenericHtml(command: string, value: unknown): string {
  const body =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value)
          .map(([key, nested]) => `<h2>${escapeHtml(key)}</h2>${htmlValue(nested, 3)}`)
          .join("")
      : htmlValue(value, 2);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>akm ${escapeHtml(command)}</title>`,
    "<style>",
    "body{font:16px/1.5 system-ui,sans-serif;margin:2rem auto;max-width:60rem;padding:0 1rem}",
    "table{border-collapse:collapse;width:100%;margin:0 0 1rem}",
    "th,td{border:1px solid #8884;padding:.35rem .6rem;text-align:left}",
    "th{background:#8881}",
    "h1{margin-bottom:1.5rem}",
    "@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}",
    "</style>",
    "</head>",
    "<body>",
    `<h1>akm ${escapeHtml(command)}</h1>`,
    body === "" ? "<p><em>(no output)</em></p>" : body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
