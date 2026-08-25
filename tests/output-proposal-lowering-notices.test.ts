// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { canonicalResolvedExecutionRequest, decodeResolvedExecutionRequest } from "../src/execution/resolved-request";
import { lowerResolvedExecutionRequestWithRunner } from "../src/integrations/agent/execution-lowering";
import { prepareInlineExecutionWithRunner } from "../src/integrations/agent/inline-execution";
import { shapeProposalProducerOutput } from "../src/output/shapes/helpers";
import { formatProposalDrainPlain, formatProposalProducerPlain } from "../src/output/text/proposal-format";

const SAFE_NOTICE = {
  code: "untranslated-field",
  severity: "warning",
  adapter: "fixture",
  field: "outputSchema",
  message: "The fixture lowerer will attempt dispatch without native schema translation.",
};

describe("proposal lowering notices reach structured and text output", () => {
  test("proposal-new shaping retains notices at ordinary detail", () => {
    const shaped = shapeProposalProducerOutput(
      {
        schemaVersion: 2,
        ok: false,
        reason: "spawn_failed",
        error: "provider rejected the optimistic request",
        type: "skill",
        name: "notice",
        engine: "fixture",
        exitCode: null,
        notices: [SAFE_NOTICE],
      },
      "normal",
    );

    expect(shaped.notices).toEqual([SAFE_NOTICE]);
  });

  test("proposal producer and drain text include stable notice identity", () => {
    const producer = formatProposalProducerPlain("proposal new", {
      ok: false,
      reason: "spawn_failed",
      error: "provider rejected the optimistic request",
      notices: [SAFE_NOTICE],
    });
    const drain = formatProposalDrainPlain({
      policy: "personal-stash",
      applyMode: "queue",
      promoted: [],
      rejected: [],
      deferred: [],
      skippedByCap: [],
      staged: [],
      notices: [SAFE_NOTICE],
    });

    for (const rendered of [producer, drain]) {
      expect(rendered).toContain("untranslated-field");
      expect(rendered).toContain("outputSchema");
      expect(rendered).not.toContain("provider-body-sentinel");
    }
  });

  test("hostile durable notice bytes are reconstructed before proposal JSON or text output", () => {
    const sentinel = "PROPOSAL-NOTICE-SECRET-DO-NOT-DISCLOSE";
    const runner = {
      kind: "llm" as const,
      engine: "proposal-notice-fixture",
      connection: {
        provider: "openai-compatible",
        endpoint: "https://proposal-notice.invalid/v1/chat/completions",
        model: "provider/exact-notice-model",
      },
      timeoutMs: null,
    };
    const prepared = prepareInlineExecutionWithRunner({
      content: "Author the proposal.",
      runner,
      invocationKind: "direct",
    });
    const durable = JSON.parse(canonicalResolvedExecutionRequest(prepared.request)) as {
      notices: Array<Record<string, unknown>>;
    };
    durable.notices = [
      {
        code: "hostile-provider-notice",
        severity: "warning",
        adapter: sentinel,
        field: sentinel,
        message: sentinel,
        details: { providerBody: sentinel, environment: sentinel },
      },
    ];
    const request = decodeResolvedExecutionRequest(durable);
    const lowered = lowerResolvedExecutionRequestWithRunner(request, prepared.runner);
    const producerInput = {
      schemaVersion: 2 as const,
      ok: false as const,
      reason: "spawn_failed" as const,
      error: "provider rejected the optimistic request",
      type: "skill",
      name: "notice",
      engine: "proposal-notice-fixture",
      exitCode: null,
      notices: lowered.notices,
    };
    const structured = shapeProposalProducerOutput(producerInput, "normal");
    const producerText = formatProposalProducerPlain("proposal new", producerInput);
    const drainText = formatProposalDrainPlain({
      policy: "personal-stash",
      applyMode: "queue",
      promoted: [],
      rejected: [],
      deferred: [],
      skippedByCap: [],
      staged: [],
      notices: lowered.notices,
    });

    for (const rendered of [JSON.stringify(structured), producerText, drainText]) {
      expect(rendered).not.toContain(sentinel);
      expect(rendered).toContain("unrecognized-request-notice");
      expect(rendered).toContain("An unrecognized durable execution notice was omitted");
    }
  });
});
