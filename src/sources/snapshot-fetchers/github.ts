// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { GITHUB_API_BASE, githubHeaders } from "../../integrations/github";
import { htmlToMarkdown } from "./content-extract";
import { avoidReservedBasename } from "./fetcher-util";
import { fetchPinnedText } from "./host-guard";
import type { WikiSnapshotFetcher, WikiSnapshotResult } from "./types";

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const RESERVED_GITHUB_ROOTS = new Set([
  "apps",
  "collections",
  "codespaces",
  "customer-stories",
  "education",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "orgs",
  "organizations",
  "pricing",
  "pulls",
  "search",
  "security",
  "settings",
  "solutions",
  "sponsors",
  "topics",
  "trending",
  "users",
]);
const GITHUB_README_BYTE_CAP = 5 * 1024 * 1024;
const GITHUB_README_BODY_TIMEOUT_MS = 30_000;

export interface GithubRepository {
  owner: string;
  repo: string;
}

/** Match only repository roots; deeper GitHub pages stay generic web pages. */
export function extractGithubRepository(url: URL): GithubRepository | null {
  if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return null;

  let owner: string;
  let repo: string;
  try {
    owner = decodeURIComponent(segments[0] ?? "");
    repo = decodeURIComponent(segments[1] ?? "").replace(/\.git$/i, "");
  } catch {
    return null;
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) return null;
  if (RESERVED_GITHUB_ROOTS.has(owner.toLowerCase())) return null;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

const githubFetcher: WikiSnapshotFetcher = {
  name: "github-repository",
  matches(url) {
    return extractGithubRepository(url) !== null;
  },
  async fetch(url, context): Promise<WikiSnapshotResult | null> {
    const repository = extractGithubRepository(url);
    if (!repository) return null;

    const apiUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/readme`;
    const headers = new Headers(githubHeaders(apiUrl));
    headers.set("Accept", "application/vnd.github.html+json");
    headers.set("User-Agent", "akm-cli github snapshot fetcher");
    const html = await fetchPinnedText(apiUrl, {
      headers,
      byteCap: GITHUB_README_BYTE_CAP,
      bodyTimeoutMs: GITHUB_README_BODY_TIMEOUT_MS,
      timeoutMs: context.timeoutMs,
      signal: context.signal,
    });
    if (!html) return null;

    const canonicalUrl = `https://github.com/${repository.owner}/${repository.repo}`;
    const markdown = htmlToMarkdown(html, `${canonicalUrl}/`);
    if (!markdown) return null;
    const repoName = repository.repo.startsWith(".") ? `dot-${repository.repo.slice(1)}` : repository.repo;
    const preferredName = `${repository.owner.toLowerCase()}/${repoName.toLowerCase()}`;
    return {
      url: canonicalUrl,
      title: `${repository.owner}/${repository.repo}`,
      markdown,
      preferredName: avoidReservedBasename(preferredName),
      tags: ["github", "repository", repository.owner.toLowerCase()],
    };
  },
};

export default githubFetcher;
