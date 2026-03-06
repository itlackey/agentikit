import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  agentikitSearch,
  agentikitOpen,
  agentikitRun,
  type SearchHit,
} from "../src/stash"

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
}

test("agentikitSearch only includes tool files with .sh/.ts/.js and returns runCmd", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "tools", "deploy.sh"), "#!/usr/bin/env bash\necho deploy\n")
  writeFile(path.join(stashDir, "tools", "script.ts"), "console.log('x')\n")
  writeFile(path.join(stashDir, "tools", "README.md"), "ignore\n")

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = agentikitSearch({ query: "", type: "tool" })

  expect(result.hits.length).toBe(2)
  expect(result.hits.every((hit: SearchHit) => hit.type === "tool")).toBe(true)
  expect(result.hits.some((hit: SearchHit) => hit.name === "README.md")).toBe(false)
  expect(result.hits.some((hit: SearchHit) => typeof hit.runCmd === "string")).toBe(true)
})

test("agentikitSearch creates bun runCmd from nearest package.json up to tools root", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  const nestedTool = path.join(stashDir, "tools", "group", "nested", "job.js")
  writeFile(nestedTool, "console.log('job')\n")
  writeFile(path.join(stashDir, "tools", "group", "package.json"), '{"name":"group"}')
  writeFile(path.join(stashDir, "tools", "package.json"), '{"name":"root"}')

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = agentikitSearch({ query: "job", type: "tool" })

  expect(result.hits.length).toBe(1)
  expect(result.hits[0].runCmd ?? "").toMatch(/^cd ".+\/tools\/group" && bun ".+\/job\.js"$/)
  expect(result.hits[0].kind).toBe("bun")
})

test("agentikitSearch only includes bun install in runCmd when AGENTIKIT_BUN_INSTALL is enabled", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  const nestedTool = path.join(stashDir, "tools", "group", "nested", "job.js")
  writeFile(nestedTool, "console.log('job')\n")
  writeFile(path.join(stashDir, "tools", "group", "package.json"), '{"name":"group"}')

  process.env.AGENTIKIT_STASH_DIR = stashDir
  process.env.AGENTIKIT_BUN_INSTALL = "true"
  try {
    const result = agentikitSearch({ query: "job", type: "tool" })
    expect(result.hits.length).toBe(1)
    expect(result.hits[0].runCmd ?? "").toMatch(/^cd ".+\/tools\/group" && bun install && bun ".+\/job\.js"$/)
    expect(result.hits[0].kind).toBe("bun")
  } finally {
    delete process.env.AGENTIKIT_BUN_INSTALL
  }
})

test("agentikitOpen returns full payloads for skill/command/agent", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "skills", "ops", "SKILL.md"), "# Ops\n")
  writeFile(path.join(stashDir, "commands", "release.md"), '---\ndescription: "Release command"\n---\nrun release\n')
  writeFile(path.join(stashDir, "agents", "coach.md"), '---\ndescription: "Coach"\nmodel: "gpt-5"\n---\nGuide users\n')

  process.env.AGENTIKIT_STASH_DIR = stashDir

  const skill = agentikitOpen({ ref: "skill:ops" })
  const command = agentikitOpen({ ref: "command:release.md" })
  const agent = agentikitOpen({ ref: "agent:coach.md" })

  expect(skill.type).toBe("skill")
  expect(skill.content ?? "").toMatch(/Ops/)
  expect(command.type).toBe("command")
  expect(command.template ?? "").toMatch(/run release/)
  expect(command.description).toBe("Release command")
  expect(agent.type).toBe("agent")
  expect(agent.prompt ?? "").toMatch(/Guide users/)
  expect(agent.modelHint).toBe("gpt-5")
})

test("agentikitOpen returns clear error when stash type root is missing", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  try {
    process.env.AGENTIKIT_STASH_DIR = stashDir
    expect(() => agentikitOpen({ ref: "agent:missing.md" })).toThrow(
      /Stash type root not found for ref: agent:missing\.md/,
    )
  } finally {
    fs.rmSync(stashDir, { recursive: true, force: true })
  }
})

test("agentikitRun executes a shell tool and returns its output", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "tools", "hello.sh"), "#!/usr/bin/env bash\necho 'hello from stash'\n")

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = agentikitRun({ ref: "tool:hello.sh" })

  expect(result.type).toBe("tool")
  expect(result.name).toBe("hello.sh")
  expect(result.output).toMatch(/hello from stash/)
  expect(result.exitCode).toBe(0)
})

test("agentikitRun returns non-zero exitCode when tool fails", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  writeFile(path.join(stashDir, "tools", "failing.sh"), "#!/usr/bin/env bash\necho 'oops' >&2\nexit 1\n")

  process.env.AGENTIKIT_STASH_DIR = stashDir
  const result = agentikitRun({ ref: "tool:failing.sh" })

  expect(result.type).toBe("tool")
  expect(result.exitCode).not.toBe(0)
  expect(result.output).toMatch(/oops/)
})

test("agentikitRun throws when given a non-tool ref", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  process.env.AGENTIKIT_STASH_DIR = stashDir
  expect(() => agentikitRun({ ref: "skill:ops" })).toThrow(/agentikitRun only supports tool refs/)
})

test("agentikitOpen rejects malformed open ref encoding", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  process.env.AGENTIKIT_STASH_DIR = stashDir
  expect(() => agentikitOpen({ ref: "tool:%E0%A4%A" })).toThrow(/Invalid open ref encoding/)
})

test("agentikitOpen rejects traversal and absolute path refs", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  process.env.AGENTIKIT_STASH_DIR = stashDir

  expect(() => agentikitOpen({ ref: "tool:..%2Foutside.sh" })).toThrow(/Invalid open ref name/)
  expect(() => agentikitOpen({ ref: "tool:%2Fetc%2Fpasswd" })).toThrow(/Invalid open ref name/)
})

test("agentikitOpen blocks symlink escapes outside stash type root", () => {
  const stashDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-stash-"))
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-outside-"))
  const outsideFile = path.join(outsideDir, "outside.sh")
  const symlinkFile = path.join(stashDir, "tools", "link.sh")
  writeFile(outsideFile, "echo outside\n")
  fs.mkdirSync(path.join(stashDir, "tools"), { recursive: true })

  try {
    fs.symlinkSync(outsideFile, symlinkFile)
  } catch {
    // Symlinks not supported in this environment — skip
    return
  }

  process.env.AGENTIKIT_STASH_DIR = stashDir
  expect(() => agentikitOpen({ ref: "tool:link.sh" })).toThrow(/Ref resolves outside the stash root/)
})
