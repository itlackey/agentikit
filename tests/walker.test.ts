import { test, expect, describe } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { walkStash } from "../src/walker"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-walker-"))
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

describe("walkStash", () => {
  test("returns empty array for non-existent directory", () => {
    expect(walkStash("/nonexistent/path", "tool")).toEqual([])
  })

  test("returns empty array for empty directory", () => {
    const dir = tmpDir()
    expect(walkStash(dir, "tool")).toEqual([])
  })

  test("groups tool files by parent directory", () => {
    const root = tmpDir()
    writeFile(path.join(root, "docker", "build.sh"), "echo build\n")
    writeFile(path.join(root, "docker", "compose.sh"), "echo compose\n")
    writeFile(path.join(root, "git", "diff.ts"), "console.log('diff')\n")

    const groups = walkStash(root, "tool")
    expect(groups).toHaveLength(2)

    const dockerGroup = groups.find((g) => g.dirPath.endsWith("docker"))
    const gitGroup = groups.find((g) => g.dirPath.endsWith("git"))

    expect(dockerGroup).toBeDefined()
    expect(dockerGroup!.files).toHaveLength(2)
    expect(gitGroup).toBeDefined()
    expect(gitGroup!.files).toHaveLength(1)
  })

  test("skips .stash.json files", () => {
    const root = tmpDir()
    writeFile(path.join(root, "group", "tool.sh"), "echo hi\n")
    writeFile(path.join(root, "group", ".stash.json"), '{"entries":[]}')

    const groups = walkStash(root, "tool")
    expect(groups).toHaveLength(1)
    const files = groups[0].files
    expect(files).toHaveLength(1)
    expect(files[0]).toContain("tool.sh")
  })

  test("only includes relevant files for tool type", () => {
    const root = tmpDir()
    writeFile(path.join(root, "group", "tool.sh"), "echo hi\n")
    writeFile(path.join(root, "group", "README.md"), "ignore\n")
    writeFile(path.join(root, "group", "data.json"), "{}")

    const groups = walkStash(root, "tool")
    expect(groups).toHaveLength(1)
    expect(groups[0].files).toHaveLength(1)
  })

  test("only includes SKILL.md for skill type", () => {
    const root = tmpDir()
    writeFile(path.join(root, "review", "SKILL.md"), "# Review\n")
    writeFile(path.join(root, "review", "README.md"), "ignore\n")
    writeFile(path.join(root, "refactor", "SKILL.md"), "# Refactor\n")

    const groups = walkStash(root, "skill")
    expect(groups).toHaveLength(2)
    for (const group of groups) {
      expect(group.files).toHaveLength(1)
      expect(group.files[0]).toContain("SKILL.md")
    }
  })

  test("only includes .md for command type", () => {
    const root = tmpDir()
    writeFile(path.join(root, "release.md"), "release\n")
    writeFile(path.join(root, "setup.sh"), "echo setup\n")

    const groups = walkStash(root, "command")
    expect(groups).toHaveLength(1)
    expect(groups[0].files).toHaveLength(1)
    expect(groups[0].files[0]).toContain("release.md")
  })

  test("walks nested directories", () => {
    const root = tmpDir()
    writeFile(path.join(root, "a", "b", "c", "deep.sh"), "echo deep\n")

    const groups = walkStash(root, "tool")
    expect(groups).toHaveLength(1)
    expect(groups[0].files[0]).toContain("deep.sh")
  })

  test("includes files from root level", () => {
    const root = tmpDir()
    writeFile(path.join(root, "deploy.sh"), "echo deploy\n")

    const groups = walkStash(root, "tool")
    expect(groups).toHaveLength(1)
    expect(groups[0].dirPath).toBe(root)
  })

  test("handles knowledge type (.md files)", () => {
    const root = tmpDir()
    writeFile(path.join(root, "guide.md"), "# Guide\n")
    writeFile(path.join(root, "reference.md"), "# Reference\n")
    writeFile(path.join(root, "data.json"), "{}")

    const groups = walkStash(root, "knowledge")
    expect(groups).toHaveLength(1)
    expect(groups[0].files).toHaveLength(2)
  })
})
