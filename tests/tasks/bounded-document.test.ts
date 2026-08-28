// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `src/tasks/source/bounded-document.ts` — the version-agnostic bounded YAML
 * front end shared by task source v4's own parser and (frozen, vendored)
 * task v3's — renders every source label its callers supply through the
 * SAME shared funnel (D2-N4, spec docs/plans/specs/p2a-task-source-v4.md
 * §3.1).
 *
 * P4 (docs/plans/specs/p4-deletions-closeout.md §3.2.2/§3.2.3, row B-17,
 * F-A2.11) retires task source v3 acceptance from `src/tasks/source-v3.ts`
 * entirely — the "task v3 source" label this file used to pin died with it.
 * Two DISTINCT labels remain in real production use today, and this file
 * pins both:
 *
 *   1. `"task source"` — `src/tasks/source/parse-task-source.ts`'s own
 *      version-agnostic front end, for a failure that happens BEFORE the
 *      document's `version:` is even known (row B-17).
 *   2. `"task source v4"` — `src/tasks/source/task-source-v4.ts`'s own
 *      internal label, for a field-level failure once routing has confirmed
 *      `version: 4`.
 *
 * The first describe block below calls `assertBoundedTaskYamlDocument`
 * directly with `sourceLabel: "task source"`, and cross-checks it against
 * real production `parseTaskSource` output on the identical hostile YAML —
 * so "the front end's rendering is unchanged by using this label" is proven
 * by equality against production rather than a hand-copied string that could
 * drift. The second half of that same describe block, and the `sourceError`
 * describe block below it, prove the two labels are a PURE substitution —
 * same wording, ordering, and file/line suffix — by running the identical
 * input through the identical assertion with only the label swapped.
 *
 * The former THIRD describe block here — an AST scan proving
 * `src/tasks/source-v3.ts` imported the D2-N4 helper set from
 * `./source/bounded-document` rather than keeping a local copy — is DELETED,
 * not flipped: `source-v3.ts`'s shrink (P4 §3.2.3) removed the field-parsing
 * logic that check was guarding entirely; the module's surviving purpose is
 * the prepare seam's document vocabulary (types only), which imports no
 * D2-N4 helper at all. `task-source-v4.ts` is the extraction's real home
 * now, but it is a deliberately NOT byte-identical sibling for two of the
 * eleven original helpers (`parseTimeout`/`parseTools` became
 * `parseTimeoutTopLevel`/`parseToolsTopLevel` there — the file's own header
 * records why), so re-pointing the same helper list at it would assert
 * something the design never promised.
 */

import { describe, expect, test } from "bun:test";
import { LineCounter, parseDocument } from "yaml";
import { UsageError } from "../../src/core/errors";
import { assertBoundedTaskYamlDocument, sourceError } from "../../src/tasks/source/bounded-document";
import { parseTaskSource } from "../../src/tasks/source/parse-task-source";

/** Reused verbatim from the deleted tests/tasks/source-v3.test.ts's hostile-YAML `test.each` list (an aliased mapping) — converted to task source v4. */
const ALIASED_YAML = "version: 4\nuses: commands/a\ninputs: &a {}\ncopy: *a\n";
const FILE_PATH = "/bundle/tasks/hostile.yml";

/** Catch a synchronous throw once and return it (never a `.toThrow()` substring match — every pin below is byte-exact). */
function caught(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("assertBoundedTaskYamlDocument — the sourceLabel seam renders 'task source' identically to real production parseTaskSource", () => {
  test("the front-end-labeled call is byte-identical to real production parseTaskSource on the identical hostile YAML", () => {
    const productionError = caught(() => parseTaskSource({ yaml: ALIASED_YAML, filePath: FILE_PATH }));
    expect(productionError).toBeInstanceOf(UsageError);

    const lineCounter = new LineCounter();
    const document = parseDocument(ALIASED_YAML, { lineCounter, uniqueKeys: true });
    const directError = caught(() =>
      assertBoundedTaskYamlDocument(document, { filePath: FILE_PATH, sourceLabel: "task source", lineCounter }),
    );
    expect(directError).toBeInstanceOf(UsageError);

    expect((directError as UsageError).message).toBe((productionError as UsageError).message);
    expect((directError as UsageError).message).toStartWith("Invalid task source at");
  });

  test("the SAME hostile YAML, run through the SAME assertion with sourceLabel: 'task source v4', renders only the label swapped — byte-exact otherwise", () => {
    const frontEndLineCounter = new LineCounter();
    const frontEndDocument = parseDocument(ALIASED_YAML, { lineCounter: frontEndLineCounter, uniqueKeys: true });
    const frontEndError = caught(() =>
      assertBoundedTaskYamlDocument(frontEndDocument, {
        filePath: FILE_PATH,
        sourceLabel: "task source",
        lineCounter: frontEndLineCounter,
      }),
    ) as UsageError;

    // A FRESH parse + LineCounter: assertBoundedTaskYamlDocument mutates
    // nothing about the yaml package's own document/counter, but a second
    // traversal of the SAME document instance is not part of its contract —
    // parse again so this call is unambiguously independent of the first.
    const v4LineCounter = new LineCounter();
    const v4Document = parseDocument(ALIASED_YAML, { lineCounter: v4LineCounter, uniqueKeys: true });
    const v4Error = caught(() =>
      assertBoundedTaskYamlDocument(v4Document, {
        filePath: FILE_PATH,
        sourceLabel: "task source v4",
        lineCounter: v4LineCounter,
      }),
    ) as UsageError;

    expect(v4Error.message).toStartWith("Invalid task source v4 at");
    expect(v4Error.message).not.toBe(frontEndError.message);
    // The ONLY difference between the two renderings is the label text
    // itself — proves sourceLabel is a pure substitution, not a hint that
    // also happens to change wording, ordering, or the file/line suffix.
    expect(v4Error.message).toBe(frontEndError.message.replace("Invalid task source", "Invalid task source v4"));
    expect(v4Error.code).toBe(frontEndError.code);
  });
});

describe("sourceError — the per-field funnel renders both source labels via its sourceLabel context field (D2-N4)", () => {
  test("sourceLabel: 'task source' renders the 'Invalid task source at …' shape", () => {
    const error = caught(() => sourceError({ filePath: "/x.yml", sourceLabel: "task source" }, ["foo"], "bar."));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("TASK_SOURCE_INVALID");
    expect((error as UsageError).message).toBe("Invalid task source at /x.yml: foo bar.");
  });

  test("sourceLabel: 'task source v4' renders the 'Invalid task source v4 at …' shape — same field path, same detail, only the label differs", () => {
    const error = caught(() => sourceError({ filePath: "/x.yml", sourceLabel: "task source v4" }, ["foo"], "bar."));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).code).toBe("TASK_SOURCE_INVALID");
    expect((error as UsageError).message).toBe("Invalid task source v4 at /x.yml: foo bar.");
  });

  test("a line number, when the context supplies lineAt, is rendered identically regardless of label", () => {
    const lineAt = () => 3;
    const frontEndError = caught(() =>
      sourceError({ filePath: "/x.yml", sourceLabel: "task source", lineAt }, ["foo"], "bar."),
    ) as UsageError;
    const v4Error = caught(() =>
      sourceError({ filePath: "/x.yml", sourceLabel: "task source v4", lineAt }, ["foo"], "bar."),
    ) as UsageError;
    expect(frontEndError.message).toBe("Invalid task source at /x.yml:3: foo bar.");
    expect(v4Error.message).toBe("Invalid task source v4 at /x.yml:3: foo bar.");
  });

  test("an empty field path renders the '$' root selector for both labels (B-16's shape)", () => {
    const error = caught(() =>
      sourceError({ filePath: "/x.yml", sourceLabel: "task source v4" }, [], "top-level detail."),
    );
    expect((error as UsageError).message).toBe("Invalid task source v4 at /x.yml: $ top-level detail.");
  });
});
