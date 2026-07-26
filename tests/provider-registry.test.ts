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
    registerRegistryProvider("test-roundtrip", factory);
    expect(resolveRegistryProviderFactory("test-roundtrip")).toBe(factory);
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
