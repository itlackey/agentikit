import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  type GlobalModelAliasTable,
  type PlatformModelMap,
  resolveLlmModel,
  resolveModel,
} from "../../src/integrations/agent/model-aliases";
import { EXECUTION_CONTRACT_FIXTURES } from "../_helpers/execution-contracts";

interface AgentAliasCase {
  id: string;
  model: string;
  platform: string;
  profileAliases?: PlatformModelMap;
  globalAliases?: GlobalModelAliasTable;
  expected: string;
  gap?: string;
}

interface LlmAliasCase {
  id: string;
  model: string;
  engine: string;
  globalAliases?: GlobalModelAliasTable;
  expected: string;
}

interface AliasFixture {
  schemaVersion: 1;
  status: "non-normative-current-observation";
  agentCases: AgentAliasCase[];
  llmCases: LlmAliasCase[];
}

const fixture = JSON.parse(
  fs.readFileSync(path.join(EXECUTION_CONTRACT_FIXTURES, "model-aliases/current-cases.json"), "utf8"),
) as AliasFixture;

describe("model alias characterization", () => {
  test("pins current agent resolution tiers without declaring the vendor table normative", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.status).toBe("non-normative-current-observation");
    for (const example of fixture.agentCases) {
      expect(
        resolveModel(example.model, example.platform, example.profileAliases, example.globalAliases),
        example.id,
      ).toBe(example.expected);
    }
  });

  test("pins current direct-LLM engine, llm, and wildcard tier order", () => {
    for (const example of fixture.llmCases) {
      expect(resolveLlmModel(example.model, example.engine, example.globalAliases), example.id).toBe(example.expected);
    }
  });

  test("labels the known-alias pass-through as a gap that WP2 may intentionally change", () => {
    const gaps = fixture.agentCases.filter(({ gap }) => gap);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.id).toBe("known-alias-without-platform-passes-through-currently");
    expect(gaps[0]?.gap).toContain("must reject");
  });
});
