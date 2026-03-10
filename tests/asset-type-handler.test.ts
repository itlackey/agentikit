import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAllHandlers, getHandler, getRegisteredTypeNames, tryGetHandler } from "../src/asset-type-handler";
import { buildFileContext, getAllRenderers, getRenderer, runMatchers } from "../src/file-context";

// ── getHandler ──────────────────────────────────────────────────────────────

describe("getHandler", () => {
  test("returns registered handler for 'tool'", () => {
    const handler = getHandler("tool");
    expect(handler).toBeDefined();
    expect(handler.typeName).toBe("tool");
  });

  test("returns registered handler for 'skill'", () => {
    const handler = getHandler("skill");
    expect(handler).toBeDefined();
    expect(handler.typeName).toBe("skill");
  });

  test("returns registered handler for 'command'", () => {
    const handler = getHandler("command");
    expect(handler).toBeDefined();
    expect(handler.typeName).toBe("command");
  });

  test("returns registered handler for 'agent'", () => {
    const handler = getHandler("agent");
    expect(handler).toBeDefined();
    expect(handler.typeName).toBe("agent");
  });

  test("returns registered handler for 'knowledge'", () => {
    const handler = getHandler("knowledge");
    expect(handler).toBeDefined();
    expect(handler.typeName).toBe("knowledge");
  });

  test("returns registered handler for 'script'", () => {
    const handler = getHandler("script");
    expect(handler).toBeDefined();
    expect(handler.typeName).toBe("script");
  });

  test("throws for unknown type", () => {
    expect(() => getHandler("nonexistent")).toThrow("Unknown asset type");
  });
});

// ── tryGetHandler ───────────────────────────────────────────────────────────

describe("tryGetHandler", () => {
  test("returns handler for known type", () => {
    const handler = tryGetHandler("tool");
    expect(handler).toBeDefined();
    expect(handler!.typeName).toBe("tool");
  });

  test("returns undefined for unknown type", () => {
    const handler = tryGetHandler("nonexistent");
    expect(handler).toBeUndefined();
  });
});

// ── getAllHandlers ───────────────────────────────────────────────────────────

describe("getAllHandlers", () => {
  test("returns all 6 handlers", () => {
    const handlers = getAllHandlers();
    expect(handlers).toHaveLength(6);
  });

  test("each handler has a typeName property", () => {
    const handlers = getAllHandlers();
    for (const handler of handlers) {
      expect(typeof handler.typeName).toBe("string");
      expect(handler.typeName.length).toBeGreaterThan(0);
    }
  });
});

// ── getRegisteredTypeNames ──────────────────────────────────────────────────

describe("getRegisteredTypeNames", () => {
  test("returns all type names", () => {
    const names = getRegisteredTypeNames();
    expect(names).toContain("tool");
    expect(names).toContain("skill");
    expect(names).toContain("command");
    expect(names).toContain("agent");
    expect(names).toContain("knowledge");
    expect(names).toContain("script");
  });

  test("returns exactly 6 type names", () => {
    const names = getRegisteredTypeNames();
    expect(names).toHaveLength(6);
  });
});

// ── lazy initialization ─────────────────────────────────────────────────────

describe("lazy initialization", () => {
  test("loads handlers on first access without explicit import of handlers/index", () => {
    // This test verifies that getHandler triggers lazy registration.
    // We have not imported ../src/handlers/index directly in this file,
    // yet getHandler should still resolve "tool" via ensureHandlersRegistered.
    const handler = getHandler("tool");
    expect(handler).toBeDefined();
    expect(handler.typeName).toBe("tool");
  });
});

// ── Helpers for new renderer/matcher tests ─────────────────────────────────

const createdTmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentikit-ath-"));
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

// ── New renderer registry ──────────────────────────────────────────────────

describe("getAllRenderers", () => {
  test("returns all 6 renderers", () => {
    const renderers = getAllRenderers();
    expect(renderers).toHaveLength(6);
  });

  test("renderer names match expected set", () => {
    const names = getAllRenderers()
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(["agent-md", "command-md", "knowledge-md", "script-source", "skill-md", "tool-script"]);
  });
});

describe("getRenderer", () => {
  test("returns renderer for each known name", () => {
    for (const name of ["tool-script", "skill-md", "command-md", "agent-md", "knowledge-md", "script-source"]) {
      const renderer = getRenderer(name);
      expect(renderer).toBeDefined();
      expect(renderer!.name).toBe(name);
    }
  });

  test("returns undefined for unknown renderer name", () => {
    expect(getRenderer("nonexistent")).toBeUndefined();
  });
});

// ── Matcher integration ─────────────────────────────────────────────────────

describe("runMatchers integration", () => {
  test("classifies tool file under tools/ directory", () => {
    const root = tmpDir();
    const filePath = path.join(root, "tools", "deploy.sh");
    writeFile(filePath, "#!/bin/bash\necho deploy\n");

    const ctx = buildFileContext(root, filePath);
    const result = runMatchers(ctx);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("script");
  });

  test("classifies .md with model frontmatter as agent regardless of directory", () => {
    const root = tmpDir();
    const filePath = path.join(root, "misc", "assistant.md");
    writeFile(filePath, ["---", "model: gpt-4", "---", "You are an assistant."].join("\n"));

    const ctx = buildFileContext(root, filePath);
    const result = runMatchers(ctx);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("agent");
  });

  test("classifies plain .md as knowledge at low specificity", () => {
    const root = tmpDir();
    const filePath = path.join(root, "docs", "readme.md");
    writeFile(filePath, "# README\nJust a doc.");

    const ctx = buildFileContext(root, filePath);
    const result = runMatchers(ctx);

    expect(result).not.toBeNull();
    expect(result!.type).toBe("knowledge");
    expect(result!.specificity).toBeLessThanOrEqual(10);
  });
});
