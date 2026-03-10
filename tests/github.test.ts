import { test, expect, describe, afterEach } from "bun:test"
import { GITHUB_API_BASE, githubHeaders, asRecord, asString } from "../src/github"

// ── Environment helpers ─────────────────────────────────────────────────────

const originalGithubToken = process.env.GITHUB_TOKEN

afterEach(() => {
  if (originalGithubToken === undefined) {
    delete process.env.GITHUB_TOKEN
  } else {
    process.env.GITHUB_TOKEN = originalGithubToken
  }
})

// ── GITHUB_API_BASE ─────────────────────────────────────────────────────────

describe("GITHUB_API_BASE", () => {
  test("is the GitHub API URL", () => {
    expect(GITHUB_API_BASE).toBe("https://api.github.com")
  })
})

// ── githubHeaders ───────────────────────────────────────────────────────────

describe("githubHeaders", () => {
  test("includes Accept and User-Agent headers", () => {
    delete process.env.GITHUB_TOKEN
    const headers = githubHeaders() as Record<string, string>
    expect(headers.Accept).toBe("application/vnd.github+json")
    expect(headers["User-Agent"]).toBe("agentikit-registry")
  })

  test("does not include Authorization when GITHUB_TOKEN is unset", () => {
    delete process.env.GITHUB_TOKEN
    const headers = githubHeaders() as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })

  test("includes Authorization when GITHUB_TOKEN is set", () => {
    process.env.GITHUB_TOKEN = "ghp_test_token_123"
    const headers = githubHeaders() as Record<string, string>
    expect(headers.Authorization).toBe("Bearer ghp_test_token_123")
  })

  test("trims whitespace from GITHUB_TOKEN", () => {
    process.env.GITHUB_TOKEN = "  ghp_trimmed  "
    const headers = githubHeaders() as Record<string, string>
    expect(headers.Authorization).toBe("Bearer ghp_trimmed")
  })

  test("does not include Authorization when GITHUB_TOKEN is empty", () => {
    process.env.GITHUB_TOKEN = ""
    const headers = githubHeaders() as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })

  test("does not include Authorization when GITHUB_TOKEN is whitespace-only", () => {
    process.env.GITHUB_TOKEN = "   "
    const headers = githubHeaders() as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })
})

// ── asRecord ────────────────────────────────────────────────────────────────

describe("asRecord", () => {
  test("returns object as-is for a plain object", () => {
    const obj = { key: "value", num: 42 }
    expect(asRecord(obj)).toBe(obj)
  })

  test("returns empty object for null", () => {
    expect(asRecord(null)).toEqual({})
  })

  test("returns empty object for undefined", () => {
    expect(asRecord(undefined)).toEqual({})
  })

  test("returns empty object for a string", () => {
    expect(asRecord("hello")).toEqual({})
  })

  test("returns empty object for a number", () => {
    expect(asRecord(42)).toEqual({})
  })

  test("returns empty object for a boolean", () => {
    expect(asRecord(true)).toEqual({})
  })

  test("returns empty object for an array", () => {
    expect(asRecord([1, 2, 3])).toEqual({})
  })

  test("returns the object for nested objects", () => {
    const nested = { a: { b: "c" } }
    const result = asRecord(nested)
    expect(result).toBe(nested)
    expect((result as Record<string, unknown>).a).toEqual({ b: "c" })
  })
})

// ── asString ────────────────────────────────────────────────────────────────

describe("asString", () => {
  test("returns string for a non-empty string", () => {
    expect(asString("hello")).toBe("hello")
  })

  test("returns undefined for an empty string", () => {
    expect(asString("")).toBeUndefined()
  })

  test("returns undefined for null", () => {
    expect(asString(null)).toBeUndefined()
  })

  test("returns undefined for undefined", () => {
    expect(asString(undefined)).toBeUndefined()
  })

  test("returns undefined for a number", () => {
    expect(asString(42)).toBeUndefined()
  })

  test("returns undefined for a boolean", () => {
    expect(asString(true)).toBeUndefined()
  })

  test("returns undefined for an object", () => {
    expect(asString({ toString: () => "obj" })).toBeUndefined()
  })

  test("returns undefined for an array", () => {
    expect(asString(["hello"])).toBeUndefined()
  })

  test("returns string with whitespace preserved", () => {
    expect(asString("  spaced  ")).toBe("  spaced  ")
  })
})
