// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Which values a task log scrubs, and — just as load-bearing — which it does
 * not (issue #755).
 *
 * The failure this guards against in BOTH directions: a configured secret
 * echoed by a scheduled command was persisted verbatim, and the obvious fix
 * (treat every non-allowlisted env value as secret) would have turned ordinary
 * build output into `[REDACTED]` confetti. The over-redaction cases below are
 * not padding — they are the reason the collector is shaped the way it is.
 */

import { describe, expect, test } from "bun:test";
import { redactSensitiveText } from "../../src/core/redaction";
import {
  collectTaskLogSensitiveValues,
  isInferredSecretName,
  MIN_INFERRED_SECRET_LENGTH,
} from "../../src/tasks/log-redaction";

describe("secret-name inference (#755)", () => {
  test("matches credential-ish names without swallowing ordinary configuration", () => {
    for (const name of [
      "GH_TOKEN",
      "NPM_AUTH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "MY_API_KEY",
      "PGPASSWORD",
      "DB_PASS",
      "GOOGLE_CREDENTIALS",
      "api_key",
    ]) {
      expect(isInferredSecretName(name)).toBe(true);
    }
    // A heuristic that fires on these would redact the operator's own prose.
    // MONKEY and BYPASS are why the keyword must be a whole `_`-delimited word
    // rather than merely a suffix; KEYBOARD_LAYOUT is why it cannot be a prefix.
    for (const name of [
      "KEYBOARD_LAYOUT",
      "AUTHOR",
      "PASSAGE",
      "MONKEY",
      "BYPASS",
      "TOKENIZER",
      "PATH",
      "HOME",
      "SHLVL",
      "PWD",
    ]) {
      expect(isInferredSecretName(name)).toBe(false);
    }
  });

  test("glued credential names are enumerated, since no boundary rule can see them", () => {
    // Loosening the pattern enough to catch these would also catch MONKEY.
    expect(isInferredSecretName("PGPASSWORD")).toBe(true);
    expect(isInferredSecretName("MYSQL_PWD")).toBe(true);
  });
});

describe("collectTaskLogSensitiveValues (#755)", () => {
  test("collects a config-declared engine credential at any length", () => {
    const values = collectTaskLogSensitiveValues({
      env: { AKM_ENGINE_MAIN_API_KEY: "xy" },
      config: { engines: { main: { kind: "llm", endpoint: "https://api.example.com", model: "m" } } },
    });
    // Two characters — a DECLARED secret has no length floor, because the
    // operator told us what it is rather than akm guessing.
    expect(values).toContain("xy");
  });

  test("collects the embedding key the engine collector does not cover", () => {
    const declared = collectTaskLogSensitiveValues({
      env: { CUSTOM_EMBED: "embed-secret-value" },
      config: { embedding: { apiKey: "${CUSTOM_EMBED}" } },
    });
    expect(declared).toContain("embed-secret-value");

    const implicit = collectTaskLogSensitiveValues({
      env: { AKM_EMBED_API_KEY: "implicit-embed-secret" },
      config: {},
    });
    expect(implicit).toContain("implicit-embed-secret");
  });

  test("collects a task-declared name at any length, and ignores one that is unset", () => {
    const values = collectTaskLogSensitiveValues({
      env: { ACME_DEPLOY: "s3cret" },
      declaredNames: ["ACME_DEPLOY", "NEVER_EXPORTED"],
    });
    expect(values).toContain("s3cret"); // 6 chars, under the inferred floor
    expect(values).not.toContain(undefined as unknown as string);
  });

  test("infers an ambient credential from its name once it clears the floor", () => {
    const values = collectTaskLogSensitiveValues({ env: { ACME_TOKEN: "abcdefghij" } });
    expect(values).toContain("abcdefghij");
  });

  test("does NOT infer a short value — the floor applies to guesses only", () => {
    const values = collectTaskLogSensitiveValues({ env: { ACME_TOKEN: "short" } });
    expect(values).not.toContain("short");
    expect("short".length).toBeLessThan(MIN_INFERRED_SECRET_LENGTH);
  });

  test("leaves ordinary environment values alone, however long", () => {
    // The regression the naive fix would cause. Every one of these is longer
    // than the floor; none is a credential, and redacting any of them mangles
    // the log the operator is reading.
    const env = {
      PWD: "/home/user/akm",
      SHELL: "/bin/bash",
      LANG: "en_US.UTF-8",
      SHLVL: "1",
      TERM: "xterm-256color",
      NODE_VERSION: "24.3.0",
      CI: "true",
      npm_config_registry: "https://registry.npmjs.org/",
    };
    expect(collectTaskLogSensitiveValues({ env })).toEqual([]);
  });

  test("an allowlisted name is not treated as secret even when its shape matches", () => {
    // LLM_BASE_URL is policy-allowlisted; a plain URL there is configuration.
    const values = collectTaskLogSensitiveValues({ env: { LLM_BASE_URL: "https://api.example.com/v1" } });
    expect(values).not.toContain("https://api.example.com/v1");
  });

  test("end to end: the secret goes, the log survives", () => {
    const env = {
      ACME_DEPLOY_TOKEN: "quietly-ordinary-looking-value",
      PWD: "/home/user/akm",
      SHLVL: "1",
      TERM: "xterm-256color",
    };
    const values = collectTaskLogSensitiveValues({ env, declaredNames: ["ACME_DEPLOY_TOKEN"] });
    const output = redactSensitiveText(
      "Build finished in 12.4s\n3 tests passed, 0 failed\ndeploying with quietly-ordinary-looking-value\nwrote dist/index.js (48 KB)",
      values,
    );
    expect(output).not.toContain("quietly-ordinary-looking-value");
    expect(output).toContain("Build finished in 12.4s");
    expect(output).toContain("3 tests passed, 0 failed");
    expect(output).toContain("wrote dist/index.js (48 KB)");
  });
});
