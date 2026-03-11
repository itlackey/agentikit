export const GITHUB_API_BASE = "https://api.github.com";

export function githubHeaders(): HeadersInit {
  const token = process.env.GITHUB_TOKEN?.trim();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "akm-registry",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
