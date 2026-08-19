// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { toErrorMessage } from "./common";

/** Structural subset shared by config, providers, diagnostics, and output. */
export interface RegistryUrlDescriptor {
  url: string;
  name?: string;
}

export const REGISTRY_CREDENTIALS_UNSUPPORTED =
  "Registry URLs must not include username or password credentials. Authenticated registries are not supported by the built-in static-index or skills-sh providers; configure a credential-free HTTPS endpoint.";

const INVALID_REGISTRY_URL_LABEL = "(invalid registry URL)";
const HTTP_SCHEME_START = /h[\t\r\n]*t[\t\r\n]*t[\t\r\n]*p[\t\r\n]*(?:s[\t\r\n]*)?:/giu;
const AUTHORITY_PREFIX_SEPARATOR = new Set(["\t", "\r", "\n", "\\", "/"]);
const AUTHORITY_STRUCTURAL_BOUNDARY = new Set(["\\", "/", "?", "#"]);
const AUTHORITY_AMBIGUOUS_BOUNDARY = new Set(["&", ",", ";", ")"]);
const AUTHORITY_SOFT_BOUNDARY = new Set(["\t", "\r", "\n", " ", '"', "'", "`", "<", ">"]);

type RegistryUrlScanMode = "strict" | "diagnostic";

interface RegistryUrlStart {
  start: number;
  authorityStart: number;
}

interface UserinfoSpan {
  start: number;
  end: number;
}

/**
 * Detect URL userinfo without broadening this issue into general URL/network
 * validation (the SSRF/redirect boundary is tracked separately in #767).
 * Whole configured values use WHATWG parsing; strict bounded scanning catches
 * nested, control-obfuscated, and special-scheme URL starts. Free-text error
 * sanitization uses the separate conservative mode below.
 */
export function hasRegistryUrlCredentials(raw: string): boolean {
  const parsed = parseWholeHttpUrl(raw);
  if (parsed && (parsed.username.length > 0 || parsed.password.length > 0)) return true;
  return registryUrlStarts(raw).some((start) => findUserinfoSpan(raw, start, "strict") !== undefined);
}

/**
 * The only formatter for configured registry URLs. Credential-free valid URLs
 * retain their authored spelling; userinfo is removed structurally. Invalid
 * strings fail closed rather than being echoed into a diagnostic.
 */
export function formatRegistryUrl(raw: string): string {
  const parsed = parseWholeHttpUrl(raw);
  if (parsed) {
    if (parsed.username || parsed.password) {
      // A whole configured value is unambiguous. Always clear WHATWG userinfo
      // structurally; textual deletion can otherwise stop at the first of
      // several `@` characters and leave the real credential behind.
      parsed.username = "";
      parsed.password = "";
      return redactDetectedUserinfo(parsed.toString(), "strict");
    }
    return redactDetectedUserinfo(raw, "strict");
  }
  const formatted = redactDetectedUserinfo(raw, "strict");
  if (registryUrlStarts(raw)[0]?.start === 0 && formatted !== raw) return formatted;
  return INVALID_REGISTRY_URL_LABEL;
}

/** A consistent human label built on the safe URL formatter. */
export function formatRegistryLabel(entry: RegistryUrlDescriptor): string {
  const url = formatRegistryUrl(entry.url);
  return entry.name ? `${entry.name} (${url})` : url;
}

/** Actionable fail-closed warning for runtime inputs that bypass config load. */
export function formatRegistryCredentialWarning(entry: RegistryUrlDescriptor): string {
  return `Registry ${formatRegistryLabel(entry)} was ignored. ${REGISTRY_CREDENTIALS_UNSUPPORTED}`;
}

/** Copy a registry entry for any structured-output boundary. */
export function registryEntryForOutput<T extends RegistryUrlDescriptor>(entry: T): T {
  return { ...entry, url: formatRegistryUrl(entry.url) };
}

/**
 * Remove userinfo from every HTTP(S) URL token in an untrusted error/warning
 * string while leaving ordinary credential-free query/path text untouched.
 */
export function redactCredentialBearingUrls(message: string): string {
  return redactDetectedUserinfo(message, "diagnostic");
}

/** Fetch errors are untrusted: runtimes often include the request URL. */
export function formatRegistryError(error: unknown): string {
  return redactCredentialBearingUrls(toErrorMessage(error));
}

function redactDetectedUserinfo(raw: string, mode: RegistryUrlScanMode): string {
  let formatted = raw;
  const starts = registryUrlStarts(raw);
  for (let i = starts.length - 1; i >= 0; i--) {
    const start = starts[i];
    if (start === undefined) continue;
    const span = findUserinfoSpan(formatted, start, mode);
    if (!span) continue;
    formatted = `${formatted.slice(0, span.start)}${formatted.slice(span.end)}`;
  }
  return formatted;
}

function registryUrlStarts(raw: string): RegistryUrlStart[] {
  return Array.from(raw.matchAll(HTTP_SCHEME_START), (match) => {
    let authorityStart = match.index + match[0].length;
    while (authorityStart < raw.length && AUTHORITY_PREFIX_SEPARATOR.has(raw[authorityStart] ?? "")) {
      authorityStart++;
    }
    return { start: match.index, authorityStart };
  });
}

function findUserinfoSpan(
  raw: string,
  urlStart: RegistryUrlStart,
  mode: RegistryUrlScanMode,
): UserinfoSpan | undefined {
  const { authorityStart } = urlStart;
  let crossedAmbiguousBoundary = false;
  let lastAt = -1;
  for (let cursor = authorityStart; cursor < raw.length; cursor++) {
    const char = raw[cursor];
    if (char === undefined) return undefined;
    if (char === "@") {
      if (cursor > authorityStart) lastAt = cursor;
      continue;
    }
    if (AUTHORITY_STRUCTURAL_BOUNDARY.has(char)) return userinfoSpan(authorityStart, lastAt);

    const isSoftBoundary = AUTHORITY_SOFT_BOUNDARY.has(char);
    const isAmbiguousBoundary = AUTHORITY_AMBIGUOUS_BOUNDARY.has(char);
    if (!isSoftBoundary && !isAmbiguousBoundary) continue;
    if (mode === "diagnostic" && cursor === authorityStart && isSoftBoundary) return undefined;
    if (lastAt >= 0 && mode === "diagnostic") {
      const apparentHost = raw.slice(lastAt + 1, cursor);
      if (looksLikeDiagnosticHostPrefix(apparentHost)) return userinfoSpan(authorityStart, lastAt);
    }
    if (crossedAmbiguousBoundary) continue;

    const prefix = raw.slice(authorityStart, cursor);
    // Strict configured/provider handling crosses soft delimiters even after a
    // host-shaped username: WHATWG accepts those values as nested userinfo.
    // Conservative free-text handling stops at an apparent host so a later
    // ordinary email is not consumed. Ambiguous query/list punctuation still
    // requires an explicit username:password prefix in either mode.
    if (
      (mode === "diagnostic" && looksLikeDiagnosticHostPrefix(prefix)) ||
      (isAmbiguousBoundary && !prefix.includes(":"))
    ) {
      return userinfoSpan(authorityStart, lastAt);
    }
    crossedAmbiguousBoundary = true;
  }
  return userinfoSpan(authorityStart, lastAt);
}

function userinfoSpan(authorityStart: number, lastAt: number): UserinfoSpan | undefined {
  return lastAt > authorityStart ? { start: authorityStart, end: lastAt + 1 } : undefined;
}

function looksLikeDiagnosticHostPrefix(raw: string): boolean {
  if (raw.startsWith("[")) return true;
  const hostname = raw.split(":", 1)[0]?.toLowerCase() ?? "";
  return hostname === "localhost" || hostname.startsWith("xn--") || hostname.includes(".");
}

function parseWholeHttpUrl(raw: string): URL | undefined {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
