import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFileContext, buildRenderContext, getRenderer } from "../src/file-context";
import { agentHandler } from "../src/handlers/agent-handler";
import { commandHandler } from "../src/handlers/command-handler";
import { knowledgeHandler } from "../src/handlers/knowledge-handler";
import { isMarkdownFile, markdownAssetPath, markdownCanonicalName } from "../src/handlers/markdown-helpers";
import { scriptHandler } from "../src/handlers/script-handler";
import { skillHandler } from "../src/handlers/skill-handler";
import { toolHandler } from "../src/handlers/tool-handler";
import {
  resolveExecHints,
  detectExecHints,
  extractCommentTags,
  INTERPRETER_MAP,
  SETUP_SIGNALS,
} from "../src/renderers";
import type { StashEntry } from "../src/metadata";
import type { LocalSearchHit } from "../src/stash-types";

// ── Temp directory helpers ──────────────────────────────────────────────────

const createdTmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-handlers-"));
  createdTmpDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

afterAll(() => {
  for (const dir of createdTmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Environment variable safety ─────────────────────────────────────────────

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ── 3.1 Tool handler ───────────────────────────────────────────────────────

describe("toolHandler", () => {
  test("buildShowResponse returns run for .sh file", () => {
    const stashDir = tmpDir();
    const toolPath = path.join(stashDir, "tools", "deploy.sh");
    writeFile(toolPath, "#!/bin/bash\necho deploy\n");

    const res = toolHandler.buildShowResponse({
      name: "deploy.sh",
      path: toolPath,
      content: "#!/bin/bash\necho deploy\n",
      stashDirs: [stashDir],
    });

    expect(res.run).toBeDefined();
    expect(res.run).toContain("bash");
    expect(res.run).toContain("deploy.sh");
  });

  test("buildShowResponse returns run for .ts file", () => {
    const stashDir = tmpDir();
    const toolPath = path.join(stashDir, "tools", "run.ts");
    writeFile(toolPath, "console.log('hi')\n");

    const res = toolHandler.buildShowResponse({
      name: "run.ts",
      path: toolPath,
      content: "console.log('hi')\n",
      stashDirs: [stashDir],
    });

    expect(res.run).toBeDefined();
    expect(res.run).toContain("bun");
    expect(res.run).toContain("run.ts");
  });

  test("buildShowResponse without stashDirs returns content", () => {
    const res = toolHandler.buildShowResponse({
      name: "deploy.sh",
      path: "/fake/deploy.sh",
      content: "#!/bin/bash\necho deploy\n",
    });

    expect(res.content).toBe("#!/bin/bash\necho deploy\n");
    expect(res.run).toBeUndefined();
  });

  test("enrichSearchHit sets run on hit", () => {
    const stashDir = tmpDir();
    const toolPath = path.join(stashDir, "tools", "deploy.sh");
    writeFile(toolPath, "#!/bin/bash\necho deploy\n");

    const hit: LocalSearchHit = {
      hitSource: "local",
      type: "tool",
      name: "deploy.sh",
      path: toolPath,
      openRef: "tool:deploy.sh",
      editable: false,
    };

    toolHandler.enrichSearchHit!(hit, stashDir);

    expect(hit.run).toBeDefined();
    expect(hit.run).toContain("bash");
    expect(hit.run).toContain("deploy.sh");
  });

  test("enrichSearchHit ignores ENOENT", () => {
    const stashDir = tmpDir();
    const hit: LocalSearchHit = {
      hitSource: "local",
      type: "tool",
      name: "missing.sh",
      path: path.join(stashDir, "tools", "missing.sh"),
      openRef: "tool:missing.sh",
      editable: false,
    };

    // Should not throw
    expect(() => toolHandler.enrichSearchHit!(hit, stashDir)).not.toThrow();
  });

  test("isRelevantFile accepts .sh .ts .js .ps1 .cmd .bat", () => {
    for (const ext of [".sh", ".ts", ".js", ".ps1", ".cmd", ".bat"]) {
      expect(toolHandler.isRelevantFile(`script${ext}`)).toBe(true);
    }
  });

  test("isRelevantFile rejects .md .py .txt", () => {
    for (const ext of [".md", ".py", ".txt"]) {
      expect(toolHandler.isRelevantFile(`file${ext}`)).toBe(false);
    }
  });
});

// ── 3.2 Script handler ─────────────────────────────────────────────────────

describe("scriptHandler", () => {
  test("buildShowResponse returns run for runnable extensions", () => {
    for (const ext of [".sh", ".ts", ".js"]) {
      const stashDir = tmpDir();
      const scriptPath = path.join(stashDir, "scripts", `run${ext}`);
      writeFile(scriptPath, "echo hello\n");

      const res = scriptHandler.buildShowResponse({
        name: `run${ext}`,
        path: scriptPath,
        content: "echo hello\n",
        stashDirs: [stashDir],
      });

      expect(res.run).toBeDefined();
      expect(res.type).toBe("script");
      if (ext === ".sh") {
        expect(res.run).toContain("bash");
      } else {
        expect(res.run).toContain("bun");
      }
    }
  });

  test("buildShowResponse returns run for non-runnable extensions (now detected)", () => {
    for (const ext of [".py", ".rb"]) {
      const stashDir = tmpDir();
      const scriptPath = path.join(stashDir, "scripts", `run${ext}`);
      writeFile(scriptPath, "print('hi')\n");

      const res = scriptHandler.buildShowResponse({
        name: `run${ext}`,
        path: scriptPath,
        content: "print('hi')\n",
        stashDirs: [stashDir],
      });

      // With exec hints, .py and .rb now get auto-detected interpreters
      expect(res.run).toBeDefined();
      expect(res.type).toBe("script");
      if (ext === ".py") {
        expect(res.run).toContain("python");
      } else {
        expect(res.run).toContain("ruby");
      }
    }
  });

  test("isRelevantFile accepts broad script extensions", () => {
    for (const ext of [".py", ".rb", ".go", ".lua", ".pl", ".php", ".sh", ".ts", ".js"]) {
      expect(scriptHandler.isRelevantFile(`script${ext}`)).toBe(true);
    }
  });

  test("isRelevantFile rejects non-script extensions", () => {
    for (const ext of [".md", ".txt", ".json"]) {
      expect(scriptHandler.isRelevantFile(`file${ext}`)).toBe(false);
    }
  });
});

// ── 3.3 Skill handler ──────────────────────────────────────────────────────

describe("skillHandler", () => {
  test("buildShowResponse returns type skill with content", () => {
    const res = skillHandler.buildShowResponse({
      name: "ops",
      path: "/stash/skills/ops/SKILL.md",
      content: "# Ops Skill\nDo ops stuff.",
    });

    expect(res.type).toBe("skill");
    expect(res.name).toBe("ops");
    expect(res.content).toBe("# Ops Skill\nDo ops stuff.");
  });

  test("toCanonicalName returns directory name", () => {
    const result = skillHandler.toCanonicalName("/stash/skills", "/stash/skills/ops/SKILL.md");
    expect(result).toBe("ops");
  });

  test("toCanonicalName returns undefined for root SKILL.md", () => {
    const result = skillHandler.toCanonicalName("/stash/skills", "/stash/skills/SKILL.md");
    expect(result).toBeUndefined();
  });

  test("toAssetPath appends SKILL.md", () => {
    const result = skillHandler.toAssetPath("root", "ops");
    expect(result).toBe(path.join("root", "ops", "SKILL.md"));
  });

  test("isRelevantFile only accepts SKILL.md", () => {
    expect(skillHandler.isRelevantFile("SKILL.md")).toBe(true);
    expect(skillHandler.isRelevantFile("skill.md")).toBe(false);
    expect(skillHandler.isRelevantFile("README.md")).toBe(false);
    expect(skillHandler.isRelevantFile("SKILL.txt")).toBe(false);
  });
});

// ── 3.4 Knowledge handler ──────────────────────────────────────────────────

describe("knowledgeHandler", () => {
  const sampleMarkdown = [
    "---",
    "title: Guide",
    "---",
    "# Introduction",
    "Welcome to the guide.",
    "",
    "## Setup",
    "Install things.",
    "",
    "## Usage",
    "Use things.",
  ].join("\n");

  test("buildShowResponse with mode full returns entire content", () => {
    const res = knowledgeHandler.buildShowResponse({
      name: "guide.md",
      path: "/stash/knowledge/guide.md",
      content: sampleMarkdown,
      view: { mode: "full" },
    });

    expect(res.type).toBe("knowledge");
    expect(res.content).toBe(sampleMarkdown);
  });

  test("buildShowResponse with default mode returns entire content", () => {
    const res = knowledgeHandler.buildShowResponse({
      name: "guide.md",
      path: "/stash/knowledge/guide.md",
      content: sampleMarkdown,
    });

    expect(res.content).toBe(sampleMarkdown);
  });

  test("buildShowResponse with mode toc returns formatted TOC", () => {
    const res = knowledgeHandler.buildShowResponse({
      name: "guide.md",
      path: "/stash/knowledge/guide.md",
      content: sampleMarkdown,
      view: { mode: "toc" },
    });

    expect(res.content).toBeDefined();
    expect(res.content).toContain("Introduction");
    expect(res.content).toContain("Setup");
    expect(res.content).toContain("Usage");
  });

  test("buildShowResponse with mode section extracts heading", () => {
    const res = knowledgeHandler.buildShowResponse({
      name: "guide.md",
      path: "/stash/knowledge/guide.md",
      content: sampleMarkdown,
      view: { mode: "section", heading: "Setup" },
    });

    expect(res.content).toBeDefined();
    expect(res.content).toContain("## Setup");
    expect(res.content).toContain("Install things.");
  });

  test("buildShowResponse with mode section returns error for missing heading", () => {
    const res = knowledgeHandler.buildShowResponse({
      name: "guide.md",
      path: "/stash/knowledge/guide.md",
      content: sampleMarkdown,
      view: { mode: "section", heading: "Nonexistent" },
    });

    expect(res.content).toContain('Section "Nonexistent" not found');
    expect(res.content).toContain("Try --view toc");
  });

  test("buildShowResponse with mode lines returns line range", () => {
    const res = knowledgeHandler.buildShowResponse({
      name: "guide.md",
      path: "/stash/knowledge/guide.md",
      content: sampleMarkdown,
      view: { mode: "lines", start: 4, end: 5 },
    });

    expect(res.content).toBeDefined();
    expect(res.content).toContain("Introduction");
    // Verify bounds: lines 4-5 should NOT include content from line 7+
    expect(res.content).not.toContain("Setup");
    expect(res.content).not.toContain("Install things.");
  });

  test("buildShowResponse with mode frontmatter returns YAML", () => {
    const res = knowledgeHandler.buildShowResponse({
      name: "guide.md",
      path: "/stash/knowledge/guide.md",
      content: sampleMarkdown,
      view: { mode: "frontmatter" },
    });

    expect(res.content).toBeDefined();
    expect(res.content).toContain("title");
  });

  test("buildShowResponse with mode frontmatter returns no-frontmatter message", () => {
    const noFrontmatter = "# Just a heading\nSome content.";
    const res = knowledgeHandler.buildShowResponse({
      name: "plain.md",
      path: "/stash/knowledge/plain.md",
      content: noFrontmatter,
      view: { mode: "frontmatter" },
    });

    expect(res.content).toBe("(no frontmatter)");
  });
});

// ── 3.5 Command handler ────────────────────────────────────────────────────

describe("commandHandler", () => {
  test("buildShowResponse extracts description from frontmatter", () => {
    const content = ["---", "description: Deploy to production", "---", "Run the deploy script with {{env}}."].join(
      "\n",
    );

    const res = commandHandler.buildShowResponse({
      name: "deploy.md",
      path: "/stash/commands/deploy.md",
      content,
    });

    expect(res.type).toBe("command");
    expect(res.description).toBe("Deploy to production");
  });

  test("buildShowResponse extracts template from content", () => {
    const content = ["---", "description: Deploy to production", "---", "Run the deploy script with {{env}}."].join(
      "\n",
    );

    const res = commandHandler.buildShowResponse({
      name: "deploy.md",
      path: "/stash/commands/deploy.md",
      content,
    });

    expect(res.template).toBe("Run the deploy script with {{env}}.");
  });

  test("buildShowResponse handles missing frontmatter", () => {
    const content = "Just a plain command template.";

    const res = commandHandler.buildShowResponse({
      name: "plain.md",
      path: "/stash/commands/plain.md",
      content,
    });

    expect(res.type).toBe("command");
    expect(res.description).toBeUndefined();
    expect(res.template).toBe("Just a plain command template.");
  });
});

// ── 3.6 Agent handler ──────────────────────────────────────────────────────

describe("agentHandler", () => {
  test("buildShowResponse extracts prompt with prefix", () => {
    const content = ["---", "description: Code reviewer", "---", "You are a code reviewer."].join("\n");

    const res = agentHandler.buildShowResponse({
      name: "reviewer.md",
      path: "/stash/agents/reviewer.md",
      content,
    });

    expect(res.type).toBe("agent");
    expect(res.prompt).toBeDefined();
    expect(res.prompt).toContain("Dispatching prompt");
    expect(res.prompt).toContain("verbatim");
    expect(res.prompt).toContain("non-compliant");
    expect(res.prompt).toContain("You are a code reviewer.");
  });

  test("buildShowResponse extracts modelHint from frontmatter", () => {
    const content = ["---", "model: gpt-4", "---", "You are an assistant."].join("\n");

    const res = agentHandler.buildShowResponse({
      name: "assistant.md",
      path: "/stash/agents/assistant.md",
      content,
    });

    expect(res.modelHint).toBe("gpt-4");
  });

  test("buildShowResponse extracts toolPolicy from frontmatter", () => {
    const content = ["---", "tools:", "  read: allow", "  write: deny", "---", "You are an assistant."].join("\n");

    const res = agentHandler.buildShowResponse({
      name: "assistant.md",
      path: "/stash/agents/assistant.md",
      content,
    });

    expect(res.toolPolicy).toBeDefined();
    expect(res.toolPolicy).toEqual({ read: "allow", write: "deny" });
  });

  test("buildShowResponse handles missing frontmatter fields", () => {
    const content = "You are a simple agent.";

    const res = agentHandler.buildShowResponse({
      name: "simple.md",
      path: "/stash/agents/simple.md",
      content,
    });

    expect(res.type).toBe("agent");
    expect(res.description).toBeUndefined();
    expect(res.modelHint).toBeUndefined();
    expect(res.toolPolicy).toBeUndefined();
    expect(res.prompt).toContain("You are a simple agent.");
  });
});

// ── 3.7 Markdown helpers ───────────────────────────────────────────────────

describe("markdown helpers", () => {
  test("isMarkdownFile returns true for .md", () => {
    expect(isMarkdownFile("guide.md")).toBe(true);
    expect(isMarkdownFile("README.MD")).toBe(true);
  });

  test("isMarkdownFile returns false for .txt", () => {
    expect(isMarkdownFile("notes.txt")).toBe(false);
  });

  test("isMarkdownFile returns false for non-markdown extensions", () => {
    expect(isMarkdownFile("script.sh")).toBe(false);
    expect(isMarkdownFile("data.json")).toBe(false);
  });

  test("markdownCanonicalName returns POSIX relative path", () => {
    const result = markdownCanonicalName("/stash/knowledge", "/stash/knowledge/guides/setup.md");
    expect(result).toBe("guides/setup.md");
  });

  test("markdownCanonicalName returns filename for flat structure", () => {
    const result = markdownCanonicalName("/stash/knowledge", "/stash/knowledge/intro.md");
    expect(result).toBe("intro.md");
  });

  test("markdownAssetPath joins typeRoot and name", () => {
    const result = markdownAssetPath("/stash/knowledge", "guides/setup.md");
    expect(result).toBe(path.join("/stash/knowledge", "guides/setup.md"));
  });
});

// ── Renderer equivalents ────────────────────────────────────────────────────
// These tests verify that the new renderer system produces equivalent output
// to the legacy handlers above.

describe("tool-script renderer", () => {
  test("buildShowResponse returns run for .sh file", () => {
    const stashDir = tmpDir();
    const toolPath = path.join(stashDir, "tools", "deploy.sh");
    writeFile(toolPath, "#!/bin/bash\necho deploy\n");

    const renderer = getRenderer("tool-script")!;
    const ctx = buildFileContext(stashDir, toolPath);
    const match = { type: "tool", specificity: 10, renderer: "tool-script", meta: { name: "deploy.sh" } };
    const renderCtx = buildRenderContext(ctx, match, [stashDir]);
    const res = renderer.buildShowResponse(renderCtx);

    expect(res.run).toBeDefined();
    expect(res.run).toContain("bash");
    expect(res.type).toBe("tool");
  });

  test("buildShowResponse returns run for .ts file", () => {
    const stashDir = tmpDir();
    const toolPath = path.join(stashDir, "tools", "run.ts");
    writeFile(toolPath, "console.log('hi')\n");

    const renderer = getRenderer("tool-script")!;
    const ctx = buildFileContext(stashDir, toolPath);
    const match = { type: "tool", specificity: 10, renderer: "tool-script", meta: { name: "run.ts" } };
    const renderCtx = buildRenderContext(ctx, match, [stashDir]);
    const res = renderer.buildShowResponse(renderCtx);

    expect(res.run).toBeDefined();
    expect(res.run).toContain("bun");
    expect(res.type).toBe("tool");
  });
});

describe("skill-md renderer", () => {
  test("buildShowResponse returns skill content", () => {
    const stashDir = tmpDir();
    const skillPath = path.join(stashDir, "skills", "ops", "SKILL.md");
    writeFile(skillPath, "# Ops Skill\nDo ops stuff.");

    const renderer = getRenderer("skill-md")!;
    const ctx = buildFileContext(stashDir, skillPath);
    const match = { type: "skill", specificity: 10, renderer: "skill-md", meta: { name: "ops" } };
    const renderCtx = buildRenderContext(ctx, match, [stashDir]);
    const res = renderer.buildShowResponse(renderCtx);

    expect(res.type).toBe("skill");
    expect(res.name).toBe("ops");
    expect(res.content).toBe("# Ops Skill\nDo ops stuff.");
  });
});

describe("command-md renderer", () => {
  test("buildShowResponse extracts description and template", () => {
    const stashDir = tmpDir();
    const cmdPath = path.join(stashDir, "commands", "deploy.md");
    writeFile(
      cmdPath,
      ["---", "description: Deploy to production", "---", "Run the deploy script with {{env}}."].join("\n"),
    );

    const renderer = getRenderer("command-md")!;
    const ctx = buildFileContext(stashDir, cmdPath);
    const match = { type: "command", specificity: 10, renderer: "command-md", meta: { name: "deploy.md" } };
    const renderCtx = buildRenderContext(ctx, match, [stashDir]);
    const res = renderer.buildShowResponse(renderCtx);

    expect(res.type).toBe("command");
    expect(res.description).toBe("Deploy to production");
    expect(res.template).toBe("Run the deploy script with {{env}}.");
  });
});

describe("agent-md renderer", () => {
  test("buildShowResponse extracts prompt with prefix", () => {
    const stashDir = tmpDir();
    const agentPath = path.join(stashDir, "agents", "reviewer.md");
    writeFile(
      agentPath,
      ["---", "description: Code reviewer", "model: gpt-4", "---", "You are a code reviewer."].join("\n"),
    );

    const renderer = getRenderer("agent-md")!;
    const ctx = buildFileContext(stashDir, agentPath);
    const match = { type: "agent", specificity: 20, renderer: "agent-md", meta: { name: "reviewer.md" } };
    const renderCtx = buildRenderContext(ctx, match, [stashDir]);
    const res = renderer.buildShowResponse(renderCtx);

    expect(res.type).toBe("agent");
    expect(res.prompt).toContain("Dispatching prompt");
    expect(res.prompt).toContain("You are a code reviewer.");
    expect(res.description).toBe("Code reviewer");
    expect(res.modelHint).toBe("gpt-4");
  });

  test("buildShowResponse extracts toolPolicy", () => {
    const stashDir = tmpDir();
    const agentPath = path.join(stashDir, "agents", "assistant.md");
    writeFile(
      agentPath,
      ["---", "tools:", "  read: allow", "  write: deny", "---", "You are an assistant."].join("\n"),
    );

    const renderer = getRenderer("agent-md")!;
    const ctx = buildFileContext(stashDir, agentPath);
    const match = { type: "agent", specificity: 20, renderer: "agent-md", meta: { name: "assistant.md" } };
    const renderCtx = buildRenderContext(ctx, match, [stashDir]);
    const res = renderer.buildShowResponse(renderCtx);

    expect(res.toolPolicy).toBeDefined();
    expect(res.toolPolicy).toEqual({ read: "allow", write: "deny" });
  });
});

describe("knowledge-md renderer", () => {
  const sampleMarkdown = [
    "---",
    "title: Guide",
    "---",
    "# Introduction",
    "Welcome to the guide.",
    "",
    "## Setup",
    "Install things.",
    "",
    "## Usage",
    "Use things.",
  ].join("\n");

  test("buildShowResponse with full mode returns entire content", () => {
    const stashDir = tmpDir();
    const kPath = path.join(stashDir, "knowledge", "guide.md");
    writeFile(kPath, sampleMarkdown);

    const renderer = getRenderer("knowledge-md")!;
    const ctx = buildFileContext(stashDir, kPath);
    const match = {
      type: "knowledge",
      specificity: 10,
      renderer: "knowledge-md",
      meta: { name: "guide.md", view: { mode: "full" as const } },
    };
    const renderCtx = buildRenderContext(ctx, match, [stashDir]);
    const res = renderer.buildShowResponse(renderCtx);

    expect(res.type).toBe("knowledge");
    expect(res.content).toBe(sampleMarkdown);
  });

  test("buildShowResponse with toc mode returns formatted TOC", () => {
    const stashDir = tmpDir();
    const kPath = path.join(stashDir, "knowledge", "guide.md");
    writeFile(kPath, sampleMarkdown);

    const renderer = getRenderer("knowledge-md")!;
    const ctx = buildFileContext(stashDir, kPath);
    const match = {
      type: "knowledge",
      specificity: 10,
      renderer: "knowledge-md",
      meta: { name: "guide.md", view: { mode: "toc" as const } },
    };
    const renderCtx = buildRenderContext(ctx, match, [stashDir]);
    const res = renderer.buildShowResponse(renderCtx);

    expect(res.content).toContain("Introduction");
    expect(res.content).toContain("Setup");
    expect(res.content).toContain("Usage");
  });
});

describe("script-source renderer", () => {
  test("buildShowResponse returns run for .sh file", () => {
    const stashDir = tmpDir();
    const scriptPath = path.join(stashDir, "scripts", "run.sh");
    writeFile(scriptPath, "echo hello\n");

    const renderer = getRenderer("script-source")!;
    const ctx = buildFileContext(stashDir, scriptPath);
    const match = { type: "script", specificity: 10, renderer: "script-source", meta: { name: "run.sh" } };
    const renderCtx = buildRenderContext(ctx, match, [stashDir]);
    const res = renderer.buildShowResponse(renderCtx);

    expect(res.run).toBeDefined();
    expect(res.type).toBe("script");
  });

  test("buildShowResponse returns run for .py files (auto-detected interpreter)", () => {
    const stashDir = tmpDir();
    const scriptPath = path.join(stashDir, "scripts", "run.py");
    writeFile(scriptPath, "print('hi')\n");

    const renderer = getRenderer("script-source")!;
    const ctx = buildFileContext(stashDir, scriptPath);
    const match = { type: "script", specificity: 10, renderer: "script-source", meta: { name: "run.py" } };
    const renderCtx = buildRenderContext(ctx, match, [stashDir]);
    const res = renderer.buildShowResponse(renderCtx);

    expect(res.run).toBeDefined();
    expect(res.run).toContain("python");
    expect(res.type).toBe("script");
  });

  test("buildShowResponse returns content for unknown extensions", () => {
    const stashDir = tmpDir();
    const scriptPath = path.join(stashDir, "scripts", "run.xyz");
    writeFile(scriptPath, "some content\n");

    const renderer = getRenderer("script-source")!;
    const ctx = buildFileContext(stashDir, scriptPath);
    const match = { type: "script", specificity: 10, renderer: "script-source", meta: { name: "run.xyz" } };
    const renderCtx = buildRenderContext(ctx, match, [stashDir]);
    const res = renderer.buildShowResponse(renderCtx);

    expect(res.content).toBe("some content\n");
    expect(res.run).toBeUndefined();
    expect(res.type).toBe("script");
  });
});

// ── ExecHints: interpreter auto-detection ────────────────────────────────────

describe("INTERPRETER_MAP", () => {
  test("maps all expected extensions", () => {
    expect(INTERPRETER_MAP[".sh"]).toBe("bash");
    expect(INTERPRETER_MAP[".ts"]).toBe("bun");
    expect(INTERPRETER_MAP[".js"]).toBe("bun");
    expect(INTERPRETER_MAP[".py"]).toBe("python");
    expect(INTERPRETER_MAP[".rb"]).toBe("ruby");
    expect(INTERPRETER_MAP[".go"]).toBe("go run");
    expect(INTERPRETER_MAP[".ps1"]).toBe("powershell -File");
    expect(INTERPRETER_MAP[".cmd"]).toBe("cmd /c");
    expect(INTERPRETER_MAP[".bat"]).toBe("cmd /c");
    expect(INTERPRETER_MAP[".pl"]).toBe("perl");
    expect(INTERPRETER_MAP[".php"]).toBe("php");
    expect(INTERPRETER_MAP[".lua"]).toBe("lua");
    expect(INTERPRETER_MAP[".r"]).toBe("Rscript");
    expect(INTERPRETER_MAP[".swift"]).toBe("swift");
    expect(INTERPRETER_MAP[".kt"]).toBe("kotlin");
    expect(INTERPRETER_MAP[".kts"]).toBe("kotlin");
  });

  test("does not map unknown extensions", () => {
    expect(INTERPRETER_MAP[".xyz"]).toBeUndefined();
    expect(INTERPRETER_MAP[".md"]).toBeUndefined();
    expect(INTERPRETER_MAP[".json"]).toBeUndefined();
  });
});

// ── ExecHints: detectExecHints ───────────────────────────────────────────────

describe("detectExecHints", () => {
  test("detects interpreter from file extension", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "run.py");
    writeFile(filePath, "print('hi')\n");

    const hints = detectExecHints(filePath);
    expect(hints.run).toBe(`python ${filePath}`);
  });

  test("detects setup from package.json", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "run.ts");
    writeFile(filePath, "console.log('hi')\n");
    writeFile(path.join(dir, "package.json"), '{"name":"test"}');

    const hints = detectExecHints(filePath);
    expect(hints.run).toBe(`bun ${filePath}`);
    expect(hints.setup).toBe("bun install");
    expect(hints.cwd).toBe(dir);
  });

  test("detects setup from requirements.txt", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "run.py");
    writeFile(filePath, "print('hi')\n");
    writeFile(path.join(dir, "requirements.txt"), "requests\n");

    const hints = detectExecHints(filePath);
    expect(hints.setup).toBe("pip install -r requirements.txt");
    expect(hints.cwd).toBe(dir);
  });

  test("detects setup from Gemfile", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "run.rb");
    writeFile(filePath, "puts 'hi'\n");
    writeFile(path.join(dir, "Gemfile"), "source 'https://rubygems.org'\n");

    const hints = detectExecHints(filePath);
    expect(hints.setup).toBe("bundle install");
  });

  test("detects setup from go.mod", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "main.go");
    writeFile(filePath, "package main\n");
    writeFile(path.join(dir, "go.mod"), "module test\n");

    const hints = detectExecHints(filePath);
    expect(hints.setup).toBe("go mod download");
  });

  test("returns empty for unknown extensions", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "run.xyz");
    writeFile(filePath, "something\n");

    const hints = detectExecHints(filePath);
    expect(hints.run).toBeUndefined();
  });
});

// ── ExecHints: extractCommentTags ────────────────────────────────────────────

describe("extractCommentTags", () => {
  test("extracts @run from JS-style comments", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "run.ts");
    writeFile(filePath, "// @run bun run --hot run.ts\nconsole.log('hi')\n");

    const hints = extractCommentTags(filePath);
    expect(hints.run).toBe("bun run --hot run.ts");
  });

  test("extracts @setup from hash comments", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "run.sh");
    writeFile(filePath, "#!/bin/bash\n# @setup apt-get install -y curl\necho hi\n");

    const hints = extractCommentTags(filePath);
    expect(hints.setup).toBe("apt-get install -y curl");
  });

  test("extracts @cwd from block comments", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "run.ts");
    writeFile(filePath, "/**\n * @cwd /opt/app\n */\nconsole.log('hi')\n");

    const hints = extractCommentTags(filePath);
    expect(hints.cwd).toBe("/opt/app");
  });

  test("extracts all three tags from same file", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "run.py");
    writeFile(filePath, "# @run python3 run.py --fast\n# @setup pip install -r reqs.txt\n# @cwd /tmp\nprint('hi')\n");

    const hints = extractCommentTags(filePath);
    expect(hints.run).toBe("python3 run.py --fast");
    expect(hints.setup).toBe("pip install -r reqs.txt");
    expect(hints.cwd).toBe("/tmp");
  });

  test("returns empty for files without tags", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "run.sh");
    writeFile(filePath, "#!/bin/bash\necho hello\n");

    const hints = extractCommentTags(filePath);
    expect(hints.run).toBeUndefined();
    expect(hints.setup).toBeUndefined();
    expect(hints.cwd).toBeUndefined();
  });

  test("returns empty for missing files", () => {
    const hints = extractCommentTags("/nonexistent/path/run.sh");
    expect(hints.run).toBeUndefined();
  });
});

// ── ExecHints: resolveExecHints resolution order ─────────────────────────────

describe("resolveExecHints", () => {
  test("stash entry fields take priority", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "run.sh");
    writeFile(filePath, "# @run custom-from-comment\necho hi\n");

    const stashEntry: StashEntry = {
      name: "run",
      type: "tool",
      run: "custom-stash-run",
      setup: "custom-stash-setup",
      cwd: "/custom/stash/cwd",
    };

    const hints = resolveExecHints(stashEntry, filePath);
    expect(hints.run).toBe("custom-stash-run");
    expect(hints.setup).toBe("custom-stash-setup");
    expect(hints.cwd).toBe("/custom/stash/cwd");
  });

  test("comment tags take priority over auto-detection", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "run.sh");
    writeFile(filePath, "# @run custom-comment-run\necho hi\n");

    const hints = resolveExecHints(undefined, filePath);
    expect(hints.run).toBe("custom-comment-run");
  });

  test("auto-detection is used when no stash entry or comment tags", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "run.py");
    writeFile(filePath, "print('hi')\n");

    const hints = resolveExecHints(undefined, filePath);
    expect(hints.run).toBe(`python ${filePath}`);
  });

  test("stash entry partially overrides: stash.run wins, auto-detect fills setup", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "run.ts");
    writeFile(filePath, "console.log('hi')\n");
    writeFile(path.join(dir, "package.json"), '{"name":"test"}');

    const stashEntry: StashEntry = {
      name: "run",
      type: "tool",
      run: "bun run --hot run.ts",
      // setup and cwd not specified -- should fall through to auto-detection
    };

    const hints = resolveExecHints(stashEntry, filePath);
    expect(hints.run).toBe("bun run --hot run.ts");
    expect(hints.setup).toBe("bun install");
    expect(hints.cwd).toBe(dir);
  });

  test("handles undefined stash entry gracefully", () => {
    const dir = tmpDir();
    const filePath = path.join(dir, "run.sh");
    writeFile(filePath, "echo hi\n");

    const hints = resolveExecHints(undefined, filePath);
    expect(hints.run).toContain("bash");
  });
});
