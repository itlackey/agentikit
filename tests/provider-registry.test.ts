import { describe, expect, test } from "bun:test";
import { registerRegistryProvider, resolveRegistryProviderFactory } from "../src/registry/factory";
import type { RegistryProviderFactory } from "../src/registry/providers/types";
import { resolveSourceProviderFactory } from "../src/sources/provider-factory";

describe("provider-registry", () => {
  test("resolveRegistryProviderFactory returns null for unknown type", () => {
    expect(resolveRegistryProviderFactory("nonexistent-provider-xyz")).toBeNull();
  });

  test("registerRegistryProvider + resolveRegistryProviderFactory round-trips", () => {
    const factory: RegistryProviderFactory = () => ({
      type: "test-provider",
      search: async () => ({ hits: [] }),
    });
    // ISOLATION-04: createProviderRegistry (src/registry/create-provider-registry.ts)
    // is a module-level singleton Map exposing register/resolve/list only — no
    // unregister/delete — so a leaked registration here would outlive this test
    // for the rest of the process. Mirror the save-and-restore pattern used at
    // tests/integration/indexer/index-bundle-identity.test.ts:106,130,170,200,
    // adapted for a synthetic key with no prior registration: `resolve()`
    // applies `?? null` (src/registry/create-provider-registry.ts:20), so
    // re-registering `undefined` in `finally` restores "unregistered" exactly.
    expect(resolveRegistryProviderFactory("test-roundtrip")).toBeNull();
    registerRegistryProvider("test-roundtrip", factory);
    try {
      expect(resolveRegistryProviderFactory("test-roundtrip")).toBe(factory);
    } finally {
      registerRegistryProvider("test-roundtrip", undefined as unknown as RegistryProviderFactory);
    }
  });

  test("static-index is registered after import", async () => {
    // Importing triggers self-registration
    await import("../src/registry/providers/static-index");
    expect(resolveRegistryProviderFactory("static-index")).not.toBeNull();
  });

  test("skills-sh is registered after import", async () => {
    await import("../src/registry/providers/skills-sh");
    expect(resolveRegistryProviderFactory("skills-sh")).not.toBeNull();
  });

  test("filesystem stash provider is registered after import", async () => {
    await import("../src/sources/providers/filesystem");
    expect(resolveSourceProviderFactory("filesystem")).not.toBeNull();
  });
});
