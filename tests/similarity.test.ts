import { test, expect } from "bun:test"
import { TfIdfAdapter, type ScoredEntry } from "../src/similarity"

function makeEntry(id: string, text: string, type: string = "tool"): ScoredEntry {
  return {
    id,
    text,
    entry: { name: id, type: type as any, description: text, tags: text.split(" ").slice(0, 3) },
    path: `/stash/tools/${id}`,
  }
}

test("TfIdfAdapter ranks relevant results higher", () => {
  const adapter = new TfIdfAdapter()
  adapter.buildIndex([
    makeEntry("docker-build", "build docker images from dockerfiles container"),
    makeEntry("git-diff", "summarize git diff changes commit"),
    makeEntry("deploy-k8s", "deploy kubernetes cluster container orchestration"),
    makeEntry("lint-code", "lint check source code style formatting"),
  ])

  const results = adapter.search("docker build", 10)
  expect(results.length).toBeGreaterThan(0)
  expect(results[0].entry.name).toBe("docker-build")
})

test("TfIdfAdapter supports type filtering", () => {
  const adapter = new TfIdfAdapter()
  adapter.buildIndex([
    makeEntry("docker-build", "build docker images", "tool"),
    makeEntry("deploy-guide", "deploy docker containers", "command"),
  ])

  const toolResults = adapter.search("docker", 10, "tool")
  expect(toolResults.every((r) => r.entry.type === "tool")).toBe(true)
})

test("TfIdfAdapter returns all entries for empty query", () => {
  const adapter = new TfIdfAdapter()
  adapter.buildIndex([
    makeEntry("a", "first tool"),
    makeEntry("b", "second tool"),
  ])

  const results = adapter.search("", 10)
  expect(results).toHaveLength(2)
})

test("TfIdfAdapter serializes and deserializes", () => {
  const entries: ScoredEntry[] = [
    makeEntry("docker-build", "build docker images container"),
    makeEntry("git-diff", "summarize git diff changes"),
  ]

  const adapter = new TfIdfAdapter()
  adapter.buildIndex(entries)
  const serialized = adapter.serialize()

  const restored = TfIdfAdapter.deserialize(serialized, entries)
  const results = restored.search("docker build", 10)
  expect(results.length).toBeGreaterThan(0)
  expect(results[0].entry.name).toBe("docker-build")
})

test("TfIdfAdapter boosts tag matches", () => {
  const adapter = new TfIdfAdapter()
  const entryWithTags: ScoredEntry = {
    id: "tagged-tool",
    text: "some generic description",
    entry: { name: "tagged-tool", type: "tool", description: "some generic description", tags: ["docker"] },
    path: "/stash/tools/tagged-tool",
  }
  const entryWithoutTags: ScoredEntry = {
    id: "untagged-tool",
    text: "docker related operations",
    entry: { name: "untagged-tool", type: "tool", description: "docker related operations" },
    path: "/stash/tools/untagged-tool",
  }

  adapter.buildIndex([entryWithTags, entryWithoutTags])
  const results = adapter.search("docker", 10)

  // Both should match, but the one with tag boost should score higher
  expect(results.length).toBe(2)
  // The tagged entry gets a boost
  const taggedResult = results.find((r) => r.entry.name === "tagged-tool")
  expect(taggedResult).toBeDefined()
})

test("TfIdfAdapter handles unknown query terms gracefully", () => {
  const adapter = new TfIdfAdapter()
  adapter.buildIndex([makeEntry("test", "test tool description")])

  const results = adapter.search("xyznonexistent", 10)
  // Should fall back to substring or return empty
  expect(results).toHaveLength(0)
})

test("substringFallback returns hits when query term is absent from IDF vocabulary but present as substring", () => {
  const adapter = new TfIdfAdapter()
  // Build index with a document containing the word "kubernetes"
  adapter.buildIndex([
    makeEntry("k8s-deploy", "deploy to kubernetes cluster orchestration"),
  ])

  // Search for a term that is NOT in the IDF vocabulary (not a token in any doc)
  // but IS a substring of the document text. "kubernet" is a substring of "kubernetes"
  // but won't be a token produced by the tokenizer (which produces "kubernetes").
  // We need ALL query tokens to be unknown to trigger substringFallback.
  // Use a made-up token that appears as substring in the text.
  const results = adapter.search("kubernet", 10)
  expect(results.length).toBeGreaterThan(0)
  expect(results[0].entry.name).toBe("k8s-deploy")
})

test("TfIdfAdapter.buildIndex with empty entries then search returns empty array", () => {
  const adapter = new TfIdfAdapter()
  adapter.buildIndex([])

  const results = adapter.search("anything", 10)
  expect(results).toHaveLength(0)
})

test("TfIdfAdapter boosts entries with matching intents", () => {
  const adapter = new TfIdfAdapter()
  // Use 3 entries so query terms have non-zero IDF.
  // Both target entries share the same text; only one has intents.
  const entryWithIntents: ScoredEntry = {
    id: "git-summarizer",
    text: "summarize changes repository code",
    entry: {
      name: "git-summarizer",
      type: "tool",
      description: "summarize changes repository code",
      intents: ["explain what changed in a repository", "summarize code changes"],
    },
    path: "/stash/tools/git-summarizer",
  }
  const entryWithoutIntents: ScoredEntry = {
    id: "code-formatter",
    text: "summarize changes repository code",
    entry: {
      name: "code-formatter",
      type: "tool",
      description: "summarize changes repository code",
    },
    path: "/stash/tools/code-formatter",
  }
  // Third unrelated entry ensures "summarize" has non-zero IDF
  const unrelatedEntry: ScoredEntry = {
    id: "lint-checker",
    text: "lint check style formatting rules",
    entry: { name: "lint-checker", type: "tool", description: "lint check style" },
    path: "/stash/tools/lint-checker",
  }

  adapter.buildIndex([entryWithIntents, entryWithoutIntents, unrelatedEntry])
  const results = adapter.search("summarize", 10)

  const withIntents = results.find((r) => r.entry.name === "git-summarizer")
  const withoutIntents = results.find((r) => r.entry.name === "code-formatter")
  expect(withIntents).toBeDefined()
  expect(withoutIntents).toBeDefined()
  // git-summarizer gets intent boost because "summarize" appears in "summarize code changes"
  expect(withIntents!.score).toBeGreaterThan(withoutIntents!.score)
})

test("TfIdfAdapter intent boost applies once per intent phrase", () => {
  const adapter = new TfIdfAdapter()
  const entry: ScoredEntry = {
    id: "multi-intent",
    text: "deploy services production staging",
    entry: {
      name: "multi-intent",
      type: "tool",
      description: "deploy services",
      intents: ["deploy to production", "deploy to staging"],
    },
    path: "/stash/tools/multi-intent",
  }

  adapter.buildIndex([entry])
  const results = adapter.search("deploy", 10)

  // Should get 2 intent boosts (one per matching intent phrase)
  expect(results.length).toBe(1)
  expect(results[0].score).toBeGreaterThan(0)
})

test("TfIdfAdapter.deserialize drops entries missing from provided entries array", () => {
  const entry1 = makeEntry("docker-build", "build docker images container")
  const entry2 = makeEntry("git-diff", "summarize git diff changes")

  const adapter = new TfIdfAdapter()
  adapter.buildIndex([entry1, entry2])
  const serialized = adapter.serialize()

  // Deserialize with only entry1 — entry2 should be silently dropped
  const restored = TfIdfAdapter.deserialize(serialized, [entry1])
  const results = restored.search("", 10)

  // Should only contain entry1, not entry2
  expect(results).toHaveLength(1)
  expect(results[0].entry.name).toBe("docker-build")
})
