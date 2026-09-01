// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * `plugin-version` advisory for `akm health` (itlackey/akm#832). Real
 * filesystem fixtures (plugin cache manifests + `akm-version.ts`), an
 * injected `listRemoteTags` seam so no subprocess/network call is ever made.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectPluginStalenessAdvisories, type ListRemoteTagsFn } from "../../../src/commands/health/plugin-staleness";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write a fake cached plugin under `<pluginsRoot>/cache/<marketplace>/akm/<version>/`. */
function installPlugin(
  pluginsRoot: string,
  opts: {
    marketplace?: string;
    version?: string;
    manifestVersion?: string;
    versionRange?: string | null;
  } = {},
): void {
  const marketplace = opts.marketplace ?? "akm-plugins";
  const version = opts.version ?? "0.9.1";
  const pluginDir = path.join(pluginsRoot, "cache", marketplace, "akm", version);
  fs.mkdirSync(path.join(pluginDir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "akm", version: opts.manifestVersion ?? version }),
  );
  if (opts.versionRange !== null) {
    fs.mkdirSync(path.join(pluginDir, "shared"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "shared", "akm-version.ts"),
      `export const AKM_VERSION_RANGE = "${opts.versionRange ?? "^0.9.0"}"\n`,
    );
  }
}

function makeMarketplaceDir(pluginsRoot: string, marketplace = "akm-plugins"): void {
  fs.mkdirSync(path.join(pluginsRoot, "marketplaces", marketplace), { recursive: true });
}

function fakeTags(tags: string[] | undefined): ListRemoteTagsFn {
  return () => tags;
}

describe("collectPluginStalenessAdvisories (itlackey/akm#832)", () => {
  test("stale plugin detected: installed 0.9.1, newest tag 0.9.1202608250804", () => {
    const pluginsRoot = makeTempDir("akm-plugin-stale-");
    installPlugin(pluginsRoot, { version: "0.9.1" });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2",
      listRemoteTags: fakeTags(["0.9.1", "0.9.1202608250804"]),
    });

    expect(adv?.name).toBe("plugin-version");
    expect(adv?.status).toBe("warn");
    expect(adv?.evidence?.stale).toBe(true);
    expect(adv?.evidence?.availableVersion).toBe("0.9.1202608250804");
    expect(adv?.message).toContain("STALE");
    expect(adv?.message).toContain("claude plugin update akm@akm-plugins");
  });

  test("up-to-date plugin is not flagged", () => {
    const pluginsRoot = makeTempDir("akm-plugin-uptodate-");
    installPlugin(pluginsRoot, { version: "0.9.1202608250804" });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2",
      listRemoteTags: fakeTags(["0.9.1", "0.9.1202608250804"]),
    });

    expect(adv?.status).toBe("pass");
    expect(adv?.evidence?.stale).toBe(false);
    expect(adv?.message).not.toContain("STALE");
  });

  test("range-rejects-CLI detected: ^0.9.0 does not admit 0.9.2-alpha.3", () => {
    const pluginsRoot = makeTempDir("akm-plugin-range-");
    installPlugin(pluginsRoot, { version: "0.9.1", versionRange: "^0.9.0" });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2-alpha.3",
      listRemoteTags: fakeTags(["0.9.1"]),
    });

    expect(adv?.status).toBe("warn");
    expect(adv?.evidence?.admitted).toBe(false);
    expect(adv?.message).toContain("NOT ADMITTED");
    expect(adv?.message).toContain("^0.9.0");
  });

  test("running CLI admitted by the range is not flagged on that basis", () => {
    const pluginsRoot = makeTempDir("akm-plugin-admitted-");
    installPlugin(pluginsRoot, { version: "0.9.1", versionRange: "^0.9.0" });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2",
      listRemoteTags: fakeTags(["0.9.1"]),
    });

    expect(adv?.status).toBe("pass");
    expect(adv?.evidence?.admitted).toBe(true);
  });

  test("nothing installed degrades benignly (empty plugins root)", () => {
    const pluginsRoot = makeTempDir("akm-plugin-empty-");
    const result = collectPluginStalenessAdvisories({ pluginsRoot, cliVersion: "0.9.2" });
    expect(result).toEqual([]);
  });

  test("no Claude plugins directory at all degrades benignly", () => {
    const pluginsRoot = path.join(os.tmpdir(), `akm-plugin-missing-${Date.now()}-${Math.random()}`);
    const result = collectPluginStalenessAdvisories({ pluginsRoot, cliVersion: "0.9.2" });
    expect(result).toEqual([]);
  });

  test("no marketplace clone: reports installed version, no stale claim, no crash", () => {
    const pluginsRoot = makeTempDir("akm-plugin-no-marketplace-");
    installPlugin(pluginsRoot, { version: "0.9.1" });
    // Deliberately no marketplaces/ dir at all.

    let calls = 0;
    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2",
      listRemoteTags: () => {
        calls += 1;
        return ["9.9.9"]; // if this were ever consulted, it would (wrongly) look newer
      },
    });

    expect(calls).toBe(0);
    expect(adv?.status).toBe("pass");
    expect(adv?.evidence?.availableVersion).toBeNull();
    expect(adv?.evidence?.stale).toBe(false);
  });

  test("remote lookup failure (offline/timeout) degrades benignly, no false STALE", () => {
    const pluginsRoot = makeTempDir("akm-plugin-offline-");
    installPlugin(pluginsRoot, { version: "0.9.1" });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2",
      listRemoteTags: fakeTags(undefined),
    });

    expect(adv?.status).toBe("pass");
    expect(adv?.evidence?.availableVersion).toBeNull();
    expect(adv?.evidence?.stale).toBe(false);
  });

  test("unreadable/malformed plugin.json is skipped, not a crash", () => {
    const pluginsRoot = makeTempDir("akm-plugin-badmanifest-");
    const pluginDir = path.join(pluginsRoot, "cache", "akm-plugins", "akm", "0.9.1", ".claude-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "plugin.json"), "{not valid json");

    const result = collectPluginStalenessAdvisories({ pluginsRoot, cliVersion: "0.9.2" });
    expect(result).toEqual([]);
  });

  test("malformed AKM_VERSION_RANGE degrades to 'unknown compatibility', never a false NOT ADMITTED", () => {
    const pluginsRoot = makeTempDir("akm-plugin-badrange-");
    installPlugin(pluginsRoot, { version: "0.9.1", versionRange: "not-a-real-range!!" });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2-alpha.3",
      listRemoteTags: fakeTags(["0.9.1"]),
    });

    expect(adv?.status).toBe("pass");
    expect(adv?.evidence?.admitted).toBeNull();
    expect(adv?.message).not.toContain("NOT ADMITTED");
  });

  test("missing shared/akm-version.ts degrades to 'unknown compatibility'", () => {
    const pluginsRoot = makeTempDir("akm-plugin-norange-");
    installPlugin(pluginsRoot, { version: "0.9.1", versionRange: null });
    makeMarketplaceDir(pluginsRoot);

    const [adv] = collectPluginStalenessAdvisories({
      pluginsRoot,
      cliVersion: "0.9.2-alpha.3",
      listRemoteTags: fakeTags(["0.9.1"]),
    });

    expect(adv?.status).toBe("pass");
    expect(adv?.evidence?.admitted).toBeNull();
    expect(adv?.evidence?.versionRange).toBeNull();
  });
});
