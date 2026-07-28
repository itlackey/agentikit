// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Unit tests for the F1 ref-resolution layer (ref-grammar decision D-R1/D-R4/
 * D-R5): `resolveRef` and the transient dual-grammar input dispatch/translation.
 *
 * These exercise NEW-grammar behavior only — the old suite never speaks it, so
 * every branch here is net-new coverage per the additive-stage contract.
 */

import { describe, expect, test } from "bun:test";
// The legacy grammar + dual-grammar shims now live in the Chunk-8 migrate home.
import {
  classifyRefGrammar,
  legacyConceptId,
  legacyRefToBundleRef,
  parseAssetRef,
} from "../scripts/akm-migrate/migrate/legacy-ref-grammar";
import {
  conceptIdFromTypeName,
  displayRef,
  isFullRefInput,
  parseRefInput,
  type RefContext,
  type RefResolutionBundle,
  resolveRef,
  typeNameFromConceptId,
} from "../src/core/asset/resolve-ref";
import { NotFoundError, UsageError } from "../src/core/errors";

/** Build a bundle whose membership set is a fixed list of conceptIds. */
function bundle(id: string, concepts: string[]): RefResolutionBundle {
  const set = new Set(concepts);
  return { id, hasConcept: (conceptId) => set.has(conceptId) };
}

// ── resolveRef (D-R4) ───────────────────────────────────────────────────────

describe("resolveRef", () => {
  test("default-bundle hit — short ref resolves to defaultBundle when present there", () => {
    const ctx: RefContext = {
      bundles: [bundle("team", ["skills/review"]), bundle("personal", ["skills/review"])],
      defaultBundle: "personal",
    };
    const resolved = resolveRef("skills/review", ctx);
    expect(resolved.bundle).toBe("personal");
    expect(resolved.conceptId).toBe("skills/review");
  });

  test("default-bundle miss → first bundle in priority order that has the concept", () => {
    const ctx: RefContext = {
      // defaultBundle lacks the concept, so priority order (team first) wins.
      bundles: [bundle("team", ["skills/review"]), bundle("personal", ["skills/other"])],
      defaultBundle: "personal",
    };
    expect(resolveRef("skills/review", ctx).bundle).toBe("team");
  });

  test("priority-order fallback with no defaultBundle — first containing bundle wins", () => {
    const ctx: RefContext = {
      bundles: [bundle("a", ["knowledge/x"]), bundle("b", ["knowledge/y"]), bundle("c", ["knowledge/y"])],
    };
    // Both b and c contain knowledge/y; b is earlier in priority order.
    expect(resolveRef("knowledge/y", ctx).bundle).toBe("b");
  });

  test("only scoping — resolves to the named bundle, ignoring higher-priority ones", () => {
    const ctx: RefContext = {
      bundles: [bundle("first", ["knowledge/x"]), bundle("second", ["knowledge/x"])],
      defaultBundle: "first",
      only: "second",
    };
    expect(resolveRef("knowledge/x", ctx).bundle).toBe("second");
  });

  test("only scoping — no match inside the scoped bundle throws", () => {
    const ctx: RefContext = {
      bundles: [bundle("first", ["knowledge/x"]), bundle("second", ["knowledge/y"])],
      only: "second",
    };
    expect(() => resolveRef("knowledge/x", ctx)).toThrow(NotFoundError);
  });

  test("qualified passthrough — an explicit bundle prefix wins without membership probing", () => {
    const ctx: RefContext = { bundles: [bundle("other", ["skills/review"])] };
    const resolved = resolveRef("explicit//skills/review", ctx);
    expect(resolved.bundle).toBe("explicit");
    expect(resolved.conceptId).toBe("skills/review");
  });

  test("qualified input conflicting with only-scope is a not-found", () => {
    const ctx: RefContext = { bundles: [bundle("a", ["skills/review"])], only: "a" };
    expect(() => resolveRef("b//skills/review", ctx)).toThrow(NotFoundError);
  });

  test("fragment carry — the #fragment survives resolution", () => {
    const ctx: RefContext = { bundles: [bundle("core", ["skills/review"])], defaultBundle: "core" };
    const resolved = resolveRef("skills/review#usage", ctx);
    expect(resolved.bundle).toBe("core");
    expect(resolved.fragment).toBe("usage");
  });

  test("no-match error names the concept and forms tried", () => {
    const ctx: RefContext = { bundles: [bundle("core", ["skills/other"])] };
    let err: unknown;
    try {
      resolveRef("skills/missing", ctx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as Error).message).toContain("skills/missing");
  });

  test("accepts a pre-parsed BundleRef object as input", () => {
    const ctx: RefContext = { bundles: [bundle("core", ["knowledge/x"])], defaultBundle: "core" };
    const resolved = resolveRef({ conceptId: "knowledge/x" }, ctx);
    expect(resolved.bundle).toBe("core");
  });
});

// ── classifyRefGrammar (D-R5 charset dispatch) ──────────────────────────────

describe("classifyRefGrammar", () => {
  test("bare conceptId (no // no :) → bundle grammar", () => {
    expect(classifyRefGrammar("skills/code-review")).toBe("bundle");
    expect(classifyRefGrammar("knowledge/http-caching")).toBe("bundle");
  });

  test("legal-slug prefix + colon-free tail → bundle grammar", () => {
    expect(classifyRefGrammar("personal//skills/code-review")).toBe("bundle");
    expect(classifyRefGrammar("team-catalog//workflows/release")).toBe("bundle");
  });

  test("bare type:name → legacy grammar", () => {
    expect(classifyRefGrammar("skill:code-review")).toBe("legacy");
    expect(classifyRefGrammar("knowledge:guide.md")).toBe("legacy");
  });

  test("tricky both-// -and-: shapes classify as LEGACY", () => {
    // Illegal slug prefixes (contain / : .) → legacy.
    expect(classifyRefGrammar("owner/repo//skill:code-review")).toBe("legacy");
    expect(classifyRefGrammar("npm:@scope/pkg//skill:x")).toBe("legacy");
    expect(classifyRefGrammar("github:owner/repo#v1//script:lint.sh")).toBe("legacy");
    // Legal slug prefix but a colon in the tail → legacy.
    expect(classifyRefGrammar("local//skill:code-review")).toBe("legacy");
  });
});

// ── D-R2 static-table translation ───────────────────────────────────────────

describe("legacyConceptId / typeNameFromConceptId", () => {
  test("type:name → <stash-subdir>/name via the static placement table", () => {
    expect(legacyConceptId("skill", "code-review")).toBe("skills/code-review");
    expect(legacyConceptId("knowledge", "guide")).toBe("knowledge/guide");
    expect(legacyConceptId("script", "db/migrate/run.sh")).toBe("scripts/db/migrate/run.sh");
    expect(legacyConceptId("workflow", "release")).toBe("workflows/release");
  });

  test("foreign type with no placement subdir keeps the bare name", () => {
    expect(legacyConceptId("madeuptype", "thing")).toBe("thing");
  });

  test("typeNameFromConceptId is the inverse for known stash subdirs", () => {
    expect(typeNameFromConceptId("skills/code-review")).toEqual({ type: "skill", name: "code-review" });
    expect(typeNameFromConceptId("scripts/db/migrate/run.sh")).toEqual({ type: "script", name: "db/migrate/run.sh" });
    expect(typeNameFromConceptId("workflows/release")).toEqual({ type: "workflow", name: "release" });
  });

  test("typeNameFromConceptId → undefined for a bare/unknown leading segment", () => {
    expect(typeNameFromConceptId("no-slash-here")).toBeUndefined();
    expect(typeNameFromConceptId("notatype/thing")).toBeUndefined();
  });

  test("legacyRefToBundleRef maps a registryId origin to the bundle slug", () => {
    // A registry origin is a legal slug → becomes the bundle id (D-R5 rule 2).
    expect(legacyRefToBundleRef("mycatalog//skill:review")).toEqual({
      bundle: "mycatalog",
      conceptId: "skills/review",
    });
    // local/stash origins are not stored bundle ids → stays short.
    expect(legacyRefToBundleRef("local//skill:review")).toEqual({ bundle: undefined, conceptId: "skills/review" });
    expect(legacyRefToBundleRef("skill:review")).toEqual({ bundle: undefined, conceptId: "skills/review" });
  });
});

// ── parseRefInput (F1b input-boundary parser) ───────────────────────────────

describe("parseRefInput", () => {
  test("new-grammar bare conceptId → same AssetRef an origin-less type:name yields", () => {
    // The whole point: a re-keyed literal resolves to the SAME value-object the
    // old spelling did, so every downstream consumer is unaffected.
    expect(parseRefInput("skills/code-review")).toEqual(parseAssetRef("skill:code-review"));
    expect(parseRefInput("knowledge/guide")).toEqual(parseAssetRef("knowledge:guide"));
    expect(parseRefInput("scripts/db/migrate/run.sh")).toEqual(parseAssetRef("script:db/migrate/run.sh"));
    expect(parseRefInput("workflows/release")).toEqual(parseAssetRef("workflow:release"));
  });

  test("new-grammar bundle-qualified → bundle becomes the AssetRef origin", () => {
    expect(parseRefInput("mycatalog//skills/review")).toEqual({
      type: "skill",
      name: "review",
      origin: "mycatalog",
    });
  });

  // Q-07/D11 — the ref-parser seam accepts opaque adapter conceptIds. Prior to
  // this, ANY conceptId whose leading segment was not an AKM placement stashDir
  // threw here — rejecting perfectly valid adapter-emitted conceptIds (OKF
  // items, website pages, wiki pageKinds, adapter `instruction` docs) in every
  // ref-consuming command except `show` (which bypasses this parser). This
  // test used to pin the OLD (defect) behavior — a NotFoundError for
  // "notatype/thing" — and is UPDATED here to pin the corrected D11 behavior:
  // a well-formed `<segment>/<rest>` conceptId is accepted as opaque data.
  test("new-grammar conceptId with an unknown-but-well-formed prefix → accepted as opaque data (D11)", () => {
    expect(parseRefInput("notatype/thing")).toEqual({ type: "notatype", name: "notatype/thing", origin: undefined });
    expect(parseRefInput("tables/customers")).toEqual({
      type: "tables",
      name: "tables/customers",
      origin: undefined,
    });
    expect(parseRefInput("adversarial//tables/customers")).toEqual({
      type: "tables",
      name: "tables/customers",
      origin: "adversarial",
    });
  });

  test("D11 opaque acceptance round-trips through the UNCHANGED conceptIdFromTypeName", () => {
    // This is the property the proposals-repository canonical-ref check and the
    // index-utility-repository event matcher both depend on: reconstructing
    // `type`/`name` via conceptIdFromTypeName must reproduce the exact input
    // conceptId, not just its tail.
    for (const conceptId of ["notatype/thing", "tables/customers", "sub/duplicate-b", "a/b/c/d"]) {
      const parsed = parseRefInput(conceptId);
      expect(conceptIdFromTypeName(parsed.type, parsed.name)).toBe(conceptId);
    }
  });

  test("D11 collision guard: a leading segment that coincidentally spells a real type KEY (not its stashDir) still round-trips", () => {
    // "skill" (singular) is a real PLACEMENT_SPECS type key, but ITS stashDir is
    // "skills" (plural) — so "skill/foo" is not a known placement dir and falls
    // into the opaque branch. Naively using "skill" as the opaque `type` would
    // make `conceptIdFromTypeName("skill", …)` resolve via the REAL placement
    // mapping (`stashDirFor("skill") === "skills"`) and corrupt the round-trip.
    for (const key of [
      "skill",
      "command",
      "agent",
      "workflow",
      "script",
      "memory",
      "secret",
      "lesson",
      "session",
      "fact",
    ]) {
      const conceptId = `${key}/foo`;
      const parsed = parseRefInput(conceptId);
      expect(conceptIdFromTypeName(parsed.type, parsed.name)).toBe(conceptId);
    }
  });

  test("D11 does NOT loosen acceptance of a bare (no-slash) name — still the caller's bare-name-to-qualify job", () => {
    expect(() => parseRefInput("notatype")).toThrow(NotFoundError);
    expect(() => parseRefInput("prod")).toThrow(NotFoundError);
  });

  test("a qualified root-level opaque conceptId is a complete parseable ref", () => {
    expect(parseRefInput("catalog//readme")).toEqual({ type: "readme", name: "readme", origin: "catalog" });
    expect(isFullRefInput("catalog//readme")).toBe(true);
  });

  test("D11 does NOT re-accept the retired colon `type:name` grammar (Q-02)", () => {
    // No slash at all after the colon — already rejected pre-D11 too.
    expect(() => parseRefInput("skill:code-review")).toThrow(NotFoundError);
    expect(() => parseRefInput("knowledge:guide.md")).toThrow(NotFoundError);
    // A slash appears in the NAME after the colon — this is exactly the shape
    // the naive "accept any well-formed <segment>/<rest>" fallback would have
    // wrongly re-admitted (the leading segment "script:db" / "workflow:release"
    // would fail the AKM-placement lookup and fall into the opaque branch).
    // The colon-in-leading-segment guard must still refuse these.
    expect(() => parseRefInput("script:db/migrate/run.sh")).toThrow(NotFoundError);
    expect(() => parseRefInput("workflow:release/train")).toThrow(NotFoundError);
  });

  test("an export #fragment is rejected at the input boundary", () => {
    expect(() => parseRefInput("skills/review#usage")).toThrow(UsageError);
  });
});

// ── isFullRefInput (bare-name-vs-typed-ref disambiguation) ──────────────────

describe("isFullRefInput", () => {
  test("new-grammar typed conceptId → full ref", () => {
    expect(isFullRefInput("env/prod")).toBe(true);
    expect(isFullRefInput("mycatalog//env/prod")).toBe(true);
    expect(isFullRefInput("secrets/api-token")).toBe(true);
  });

  test("bare names (no type prefix) → not a full ref", () => {
    expect(isFullRefInput("prod")).toBe(false);
    expect(isFullRefInput("projectA/new-note")).toBe(false); // leading segment maps to no type
    expect(isFullRefInput("")).toBe(false);
  });

  test("qualified opaque conceptIds are syntactically complete", () => {
    expect(isFullRefInput("catalog//tables/customers")).toBe(true);
    expect(isFullRefInput("tables/customers")).toBe(false);
  });
});

describe("displayRef (F4b output-spelling rule)", () => {
  test("default/primary bundle (no bundleId) → SHORT conceptId, derived from type/name", () => {
    expect(displayRef({ type: "knowledge", name: "http-caching" })).toBe("knowledge/http-caching");
    expect(displayRef({ type: "skill", name: "code-review" })).toBe("skills/code-review");
    expect(displayRef({ type: "memory", name: "claude-prefs" })).toBe("memories/claude-prefs");
    expect(displayRef({ type: "memory", name: "claude-prefs.derived" })).toBe("memories/claude-prefs.derived");
  });

  test("bundleId equal to defaultBundleId → SHORT conceptId", () => {
    expect(displayRef({ type: "knowledge", name: "guide", bundleId: "core" }, "core")).toBe("knowledge/guide");
  });

  test("non-default bundles named local or stash remain qualified", () => {
    expect(displayRef({ type: "knowledge", name: "guide", bundleId: "local" }, "primary")).toBe(
      "local//knowledge/guide",
    );
    expect(displayRef({ type: "knowledge", name: "guide", bundleId: "stash" }, "primary")).toBe(
      "stash//knowledge/guide",
    );
  });

  test("explicit conceptId wins over type/name derivation for the short form", () => {
    expect(displayRef({ type: "knowledge", name: "guide.md", conceptId: "knowledge/guide" })).toBe("knowledge/guide");
  });

  test("slug-clean non-default bundle → fully-qualified bundle//conceptId", () => {
    expect(displayRef({ type: "knowledge", name: "guide", bundleId: "team-catalog" })).toBe(
      "team-catalog//knowledge/guide",
    );
    expect(
      displayRef({ type: "workflow", name: "release", conceptId: "workflows/release", bundleId: "team-catalog" }),
    ).toBe("team-catalog//workflows/release");
  });

  test("non-default bundle → bundle//conceptId (WI-8.5c: always the new grammar)", () => {
    // Post-Chunk-8 the config migration assigned every source a legal slug bundle
    // id, so a non-default bundle always displays as the new `bundle//conceptId`
    // grammar — the legacy `origin//type:name` arm is retired. A raw non-slug
    // registryId reaching here (edge case) is emitted verbatim as the bundle.
    expect(displayRef({ type: "agent", name: "helper", bundleId: "github:evil/pack" })).toBe(
      "github:evil/pack//agents/helper",
    );
    expect(displayRef({ type: "script", name: "deploy.sh", bundleId: "npm:@scope/pkg" })).toBe(
      "npm:@scope/pkg//scripts/deploy.sh",
    );
  });
});
