import { test, expect } from "bun:test"
import { tokenize } from "../src/similarity"

test("tokenize splits text and removes stop words", () => {
  const tokens = tokenize("build docker images from dockerfiles container")
  expect(tokens).toContain("build")
  expect(tokens).toContain("docker")
  expect(tokens).toContain("container")
  expect(tokens).not.toContain("from") // stop word
})

test("tokenize handles empty input", () => {
  const tokens = tokenize("")
  expect(tokens).toHaveLength(0)
})

test("tokenize removes short tokens", () => {
  const tokens = tokenize("a b cd efg")
  expect(tokens).not.toContain("a")
  expect(tokens).not.toContain("b")
  expect(tokens).toContain("cd")
  expect(tokens).toContain("efg")
})
