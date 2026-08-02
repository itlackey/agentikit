// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Sources / registries / installed entries + the 0.9.0 `bundles` shape.
 * Extracted verbatim from the former `config-schema.ts` monolith — no behavior
 * change.
 */
import { z } from "zod";
import { isBundleSlug } from "../../asset/asset-ref";
import { httpUrl, nonEmptyString, positiveInt } from "./primitives";

// ── Sources / registries / installed ────────────────────────────────────────

const SourceConfigEntryOptionsSchema = z.record(z.unknown());

export const SourceConfigEntrySchema = z
  .object({
    type: nonEmptyString,
    path: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    writable: z.boolean().optional(),
    primary: z.boolean().optional(),
    options: SourceConfigEntryOptionsSchema.optional(),
  })
  .passthrough()
  .superRefine((entry, ctx) => {
    if (entry.options && "pushOnCommit" in entry.options) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options", "pushOnCommit"],
        message: "options.pushOnCommit is not supported",
      });
    }
    if (!["filesystem", "git", "website", "npm"].includes(entry.type)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["type"],
        message: `unsupported source type "${entry.type}"; expected filesystem, git, website, or npm`,
      });
    }
    if (entry.writable === true && (entry.type === "website" || entry.type === "npm")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `writable: true is only supported on filesystem and git sources (got "${entry.type}"` +
          (entry.name ? ` on source "${entry.name}"` : "") +
          ").",
      });
    }
  });

export const RegistryConfigEntrySchema = z
  .object({
    url: httpUrl,
    name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    provider: z.string().min(1).optional(),
    options: z.record(z.unknown()).optional(),
  })
  .passthrough();

// ── Bundles (0.9.0 config-shape cutover, spec §10.1 / D-R5) ─────────────────
//
// `bundles` + `defaultBundle` are the 0.9.0 desired-configuration shape that
// supersedes the pre-cutover `stashDir` / `sources[]` / `installed[]` trio. Each
// bundle entry carries ONE source descriptor (`path` | `git` | `website` | `npm`
// — mirroring today's source types), an optional `writable`, an optional
// `registryId` locator (the original registry install id, preserved verbatim so
// a non-slug-legal id like `github:owner/repo` is not lost when its slug-legal
// bundle KEY is derived), and an optional single-entry `components` map (spec
// §10.1; the transitional one-component-per-bundle coupling — NOT multi-component
// machinery). The map KEY is the workspace bundle slug (spec §11.1 charset: no
// `/`, `:`, `.`, `#`, whitespace), validated with {@link isBundleSlug}.
//
// The config migrator ({@link migrateConfigSourcesToBundles}) emits these keyed
// by exactly what `deriveInstallations` derives today (D-R5). `bindings` (spec
// §10.1) is Tier B and is NEVER accepted here (the top-level superRefine rejects
// it) — it is not part of the 0.9.0 config-shape cutover.

/** Website source descriptor for a bundle entry (spec §10.1). */
const BundleWebsiteDescriptorSchema = z
  .object({
    url: httpUrl,
    refresh: z.string().min(1).optional(),
    maxPages: positiveInt.optional(),
    maxDepth: positiveInt.optional(),
    // Default true: crawl-scoped robots.txt compliance (Disallow/Crawl-delay
    // for the akm/akm-cli product tokens or "*"). See
    // src/sources/snapshot-fetchers/robots.ts. Opt out with `false` to
    // restore pre-P1 behavior exactly (no /robots.txt request at all).
    respectRobots: z.boolean().optional(),
    // Hard wall-clock cap on the whole crawl, in milliseconds. Defaults to
    // 10 minutes. Unlike a between-page check, this aborts work already in
    // flight — including a `Retry-After` sleep, which a server can otherwise
    // make arbitrarily long. Set to 0 to disable the cap entirely for a
    // deliberately long-running crawl.
    crawlTimeoutMs: z.number().int().min(0).optional(),
  })
  .passthrough();

/** One component of a bundle (spec §10.1). Single-entry, transitional. */
const BundleComponentConfigSchema = z
  .object({
    root: z.string().min(1).optional(),
    adapter: nonEmptyString.optional(),
    writable: z.boolean().optional(),
  })
  .passthrough();

export const BundleConfigEntrySchema = z
  .object({
    // Exactly one source descriptor (enforced in superRefine below):
    path: z.string().min(1).optional(),
    git: z.string().min(1).optional(),
    website: BundleWebsiteDescriptorSchema.optional(),
    npm: z.string().min(1).optional(),
    writable: z.boolean().optional(),
    // Opt a bundle out of indexing, search, refresh, and write targeting
    // without deleting it. Carried over from the pre-cutover `sources[].enabled`
    // flag, which the runtime still honors on the derived source entry
    // (`write-source.ts`, `search-source.ts`); without it here, migrating a
    // disabled source would silently reactivate it.
    enabled: z.boolean().optional(),
    // The original registry install id when the bundle KEY was slug-derived from
    // it (e.g. registryId `github:owner/repo` → key `repo`). Preserved so the
    // source locator survives the config-shape migration (D-R5). Absent when the
    // bundle key already equals the source's stable id.
    registryId: z.string().min(1).optional(),
    components: z.record(z.string().min(1), BundleComponentConfigSchema).optional(),
  })
  .passthrough()
  .superRefine((entry, ctx) => {
    const options = (entry as Record<string, unknown>).options;
    if (options && typeof options === "object" && "pushOnCommit" in options) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options", "pushOnCommit"],
        message: "options.pushOnCommit is not supported",
      });
    }
    const descriptors = (["path", "git", "website", "npm"] as const).filter((k) => entry[k] !== undefined);
    if (descriptors.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a bundle entry must carry exactly one source descriptor (path, git, website, or npm)",
      });
    } else if (descriptors.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a bundle entry must carry exactly one source descriptor; got ${descriptors.join(", ")}`,
      });
    }
    if (entry.writable === true && (entry.website !== undefined || entry.npm !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["writable"],
        message: "writable: true is only supported on path and git bundle sources",
      });
    }
    const componentEntries = entry.components ? Object.entries(entry.components) : [];
    if (entry.components !== undefined && componentEntries.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["components"],
        message: "a bundle components map must contain exactly one component",
      });
    }
    const componentEntry = componentEntries[0];
    if (componentEntry?.[1].writable === true && (entry.website !== undefined || entry.npm !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["components", componentEntry[0], "writable"],
        message: "writable: true is only supported on path and git bundle sources",
      });
    }
  });

/**
 * `bundles` map. Keys are workspace bundle slugs (spec §11.1 / D-R5 charset).
 * The key charset is validated with {@link isBundleSlug} so a key can never carry
 * `/`, `:`, `.`, `#`, or whitespace (which would break the `bundle//conceptId`
 * ref grammar).
 */
export const BundlesConfigSchema = z.record(
  z.string().min(1).refine(isBundleSlug, {
    message: "bundle key must be a legal slug (no '/', ':', '.', '#', or whitespace)",
  }),
  BundleConfigEntrySchema,
);
