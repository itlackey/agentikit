import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getConfigValue, listConfig } from "../../src/commands/config-cli";
import { collectEgressAdvisory } from "../../src/commands/health/surfaces";
import { resolveRegistries, searchRegistry } from "../../src/commands/read/registry-search";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../../src/core/config/config";
import { formatRegistryError, formatRegistryUrl, redactCredentialBearingUrls } from "../../src/core/registry-url";
import { clearLogFile, setLogFile, warn } from "../../src/core/warn";
import {
  formatInfoPlain,
  formatRegistryListPlain,
  formatRegistryRemovePlain,
} from "../../src/output/text/command-format";
import { resolveRegistryProviderFactory } from "../../src/registry/factory";
import { loadSetupStashes } from "../../src/setup/registry-stash-loader";
import { runCliCapture } from "../_helpers/cli";
import {
  type IsolatedAkmStorage,
  withEnvSync,
  withIsolatedAkmStorage,
  withMockedFetch,
  writeSandboxConfig,
} from "../_helpers/sandbox";

const USERNAME = "registry-alice";
const PASSWORD = "registry-swordfish";
const CREDENTIAL_URL = `https://${USERNAME}:${PASSWORD}@registry.example.test/index.json`;
const ADVERSARIAL_CREDENTIAL_URLS = [
  `https://safe.example.test/?next=https://${USERNAME}:${PASSWORD}@errors.example.test/private`,
  `https://safe.example.test/redirect/https://${USERNAME}:${PASSWORD}@errors.example.test/private`,
  `https://${USERNAME}:\t${PASSWORD}@errors.example.test/private`,
  `https://${USERNAME}:\r${PASSWORD}@errors.example.test/private`,
  `https://${USERNAME}:\n${PASSWORD}@errors.example.test/private`,
  `https://${USERNAME}: ${PASSWORD}@errors.example.test/private`,
  `https://${USERNAME}:${PASSWORD}"@errors.example.test/private`,
  `https://${USERNAME}:${PASSWORD}'@errors.example.test/private`,
  `https://${USERNAME}:${PASSWORD}\`@errors.example.test/private`,
  `https://${USERNAME}:${PASSWORD}<@errors.example.test/private`,
  `https://${USERNAME}:${PASSWORD}>@errors.example.test/private`,
] as const;

function expectCredentialsAbsent(value: unknown): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  expect(serialized).not.toContain(USERNAME);
  expect(serialized).not.toContain(PASSWORD);
  expect(serialized).not.toContain(CREDENTIAL_URL);
}

let storage: IsolatedAkmStorage;

beforeEach(() => {
  storage = withIsolatedAkmStorage({ AKM_REGISTRY_URL: undefined });
});

afterEach(() => {
  clearLogFile();
  storage.cleanup();
});

describe("registry credential-bearing URL mutation boundaries", () => {
  test("registry add rejects userinfo before creating or changing config", async () => {
    const configPath = path.join(storage.configDir, "akm", "config.json");
    const result = await runCliCapture(["registry", "add", CREDENTIAL_URL, "--verbose", "--format=json"]);

    expect(result.code).not.toBe(0);
    expectCredentialsAbsent(result.stdout);
    expectCredentialsAbsent(result.stderr);
    expect(fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "").not.toContain(PASSWORD);
  });

  test("generic config set rejects userinfo before persistence", async () => {
    const configPath = path.join(storage.configDir, "akm", "config.json");
    const value = JSON.stringify([{ url: CREDENTIAL_URL, name: "private" }]);
    const result = await runCliCapture(["config", "set", "registries", value, "--format=json"]);

    expect(result.code).not.toBe(0);
    expectCredentialsAbsent(result.stdout);
    expectCredentialsAbsent(result.stderr);
    expect(fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "").not.toContain(PASSWORD);
  });

  test("registry remove does not echo a credential-bearing target in its JSON error", async () => {
    const result = await runCliCapture(["registry", "remove", CREDENTIAL_URL, "--yes", "--format=json"]);

    expect(result.code).toBe(1);
    expectCredentialsAbsent(result.stdout);
    expectCredentialsAbsent(result.stderr);
  });

  test("the shared config save boundary rejects userinfo for setup and other writers", () => {
    const credentialForms = [
      CREDENTIAL_URL,
      `https://${USERNAME}@registry.example.test/index.json`,
      `https://:${PASSWORD}@registry.example.test/index.json`,
      ADVERSARIAL_CREDENTIAL_URLS[0],
      ADVERSARIAL_CREDENTIAL_URLS[1],
    ];
    for (const url of credentialForms) {
      expect(() =>
        saveConfig({
          ...DEFAULT_CONFIG,
          registries: [{ url, name: "private" }],
        }),
      ).toThrow("credential");
    }

    const configPath = path.join(storage.configDir, "akm", "config.json");
    expect(fs.existsSync(configPath)).toBe(false);
  });
});

describe("already-persisted registry credentials fail closed", () => {
  test("CLI config, registry, search, info, and health JSON errors never echo userinfo", async () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      registries: [{ url: CREDENTIAL_URL, name: "private", provider: "static-index" }],
    });

    const invocations = [
      ["registry", "list", "--format=json"],
      ["config", "list", "--format=json"],
      ["info", "--format=json"],
      ["health", "--format=json"],
      ["search", "needle", "--from", "registry", "--verbose", "--format=json"],
      ["search", "needle", "--from", "all", "--verbose", "--format=json"],
    ];

    for (const argv of invocations) {
      const result = await runCliCapture(argv);
      expect(result.code).toBe(78);
      expectCredentialsAbsent(result.stdout);
      expectCredentialsAbsent(result.stderr);
      expect(result.stderr.toLowerCase()).toContain("credential");
    }
  });
});

describe("registry provider, search, warning, and log boundaries", () => {
  test("credential-free static-index and skills-sh requests preserve their existing behavior", async () => {
    const staticUrl = "https://registry.example.test/deep/index.json?channel=beta";
    const skillsUrl = "https://skills.example.test/catalog";
    const requested: string[] = [];
    const result = await withMockedFetch(
      () =>
        searchRegistry("needle", {
          registries: [
            { url: staticUrl, name: "static", provider: "static-index" },
            { url: skillsUrl, name: "skills", provider: "skills-sh" },
          ],
        }),
      (url) => {
        requested.push(url);
        if (url === staticUrl) {
          return new Response(
            JSON.stringify({
              version: 3,
              updatedAt: "2026-01-01T00:00:00Z",
              stashes: [{ id: "npm:needle", name: "needle", ref: "needle", source: "npm" }],
            }),
          );
        }
        return new Response(
          JSON.stringify({ skills: [{ id: "org/repo/needle", name: "needle", installs: 1, source: "org/repo" }] }),
        );
      },
    );

    expect(requested).toContain(staticUrl);
    expect(requested).toContain(`${skillsUrl}/api/search?q=needle&limit=20`);
    expect(result.hits).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  test("static-index and skills-sh refuse credential-bearing URLs without fetching", async () => {
    const requested: string[] = [];
    const result = await withMockedFetch(
      () =>
        searchRegistry("needle", {
          registries: [
            { url: CREDENTIAL_URL, name: "static-private", provider: "static-index" },
            { url: CREDENTIAL_URL.replace("index.json", "skills"), name: "skills-private", provider: "skills-sh" },
          ],
        }),
      (url) => {
        requested.push(url);
        return new Response(JSON.stringify({ version: 3, updatedAt: "2026-01-01T00:00:00Z", stashes: [] }));
      },
    );

    expect(requested).toEqual([]);
    expect(result.hits).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every((warning) => warning.toLowerCase().includes("credential"))).toBe(true);
    expectCredentialsAbsent(result);
  });

  test("each built-in provider independently refuses userinfo before cache or fetch", async () => {
    for (const providerType of ["static-index", "skills-sh"]) {
      const factory = resolveRegistryProviderFactory(providerType);
      if (!factory) throw new Error(`Built-in registry provider ${providerType} is not registered`);
      const requested: string[] = [];
      const result = await withMockedFetch(
        () => factory({ url: CREDENTIAL_URL, name: `${providerType}-private` }).search({ query: "needle", limit: 20 }),
        (url) => {
          requested.push(url);
          return new Response("{}");
        },
      );

      expect(requested).toEqual([]);
      expect(result.hits).toEqual([]);
      expect(result.warnings?.[0]?.toLowerCase()).toContain("credential");
      expectCredentialsAbsent(result);
    }
  });

  test("AKM_REGISTRY_URL ignores userinfo without returning or warning with secrets", () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      const resolved = withEnvSync(
        {
          AKM_REGISTRY_URL: `${CREDENTIAL_URL},::${CREDENTIAL_URL},static-index::ftp://${USERNAME}:${PASSWORD}@registry.example.test`,
        },
        () => resolveRegistries(),
      );
      expect(resolved).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
    expectCredentialsAbsent(warnings);
  });

  test("fetch error objects sanitize nested, control, and punctuation userinfo before response and log sinks", async () => {
    const logPath = path.join(storage.root, "registry.log");
    setLogFile(logPath);

    const result = await withMockedFetch(
      () =>
        searchRegistry("needle", {
          registries: [{ url: "https://skills.example.test", name: "skills", provider: "skills-sh" }],
        }),
      () => {
        throw new Error(`fetch failed:\n${ADVERSARIAL_CREDENTIAL_URLS.join("\n")}`);
      },
    );
    for (const warning of result.warnings) warn(warning);

    expectCredentialsAbsent(result);
    expectCredentialsAbsent(fs.readFileSync(logPath, "utf8"));
  });

  test("normal and registry-only CLI search JSON never echo URLs from fetch errors", async () => {
    writeSandboxConfig({
      semanticSearchMode: "off",
      registries: [{ url: "https://registry.example.test/index.json", name: "safe" }],
    });

    const results = await withMockedFetch(
      async () => [
        await runCliCapture(["search", "needle", "--from", "registry", "--verbose", "--format=json"]),
        await runCliCapture(["search", "needle", "--from", "all", "--verbose", "--format=json"]),
      ],
      () => {
        throw new Error(`fetch failed for ${CREDENTIAL_URL}`);
      },
    );

    for (const result of results) {
      expect(result.code).toBe(0);
      expectCredentialsAbsent(result.stdout);
      expectCredentialsAbsent(result.stderr);
    }
  });

  test("setup registry discovery refuses userinfo before its fetch boundary", async () => {
    const requested: string[] = [];
    const stashes = await withMockedFetch(
      () => loadSetupStashes(CREDENTIAL_URL),
      (url) => {
        requested.push(url);
        return new Response("{}");
      },
    );

    expect(requested).toEqual([]);
    expect(stashes.length).toBeGreaterThan(0);
    expectCredentialsAbsent(stashes);
  });
});

describe("registry URLs are safe in plain, structured, and health projections", () => {
  const unsafeConfig = {
    ...DEFAULT_CONFIG,
    registries: [{ url: CREDENTIAL_URL, name: "private", provider: "static-index" }],
  };

  test("config get/list projections redact registry userinfo", () => {
    expectCredentialsAbsent(getConfigValue(unsafeConfig, "registries"));
    expectCredentialsAbsent(listConfig(unsafeConfig));
  });

  test("the formatter preserves credential-free paths/queries and only removes userinfo", () => {
    const ordinary = "https://registry.example.test/deep/index.json?channel=beta#latest";
    expect(formatRegistryUrl(ordinary)).toBe(ordinary);
    expect(
      formatRegistryUrl(`https://${USERNAME}:${PASSWORD}@registry.example.test/deep/index.json?channel=beta#latest`),
    ).toBe("https://registry.example.test/deep/index.json?channel=beta#latest");
    expectCredentialsAbsent(formatRegistryError(new Error(`request failed: ${CREDENTIAL_URL}?retry=1`)));
  });

  test("the error sanitizer scans nested URL starts and delimiter-heavy userinfo", () => {
    for (const unsafe of ADVERSARIAL_CREDENTIAL_URLS) {
      expectCredentialsAbsent(redactCredentialBearingUrls(`request failed for ${unsafe}`));
      expectCredentialsAbsent(formatRegistryUrl(unsafe));
    }

    expect(
      redactCredentialBearingUrls(
        `outer https://safe.example.test/?next=https://${USERNAME}:${PASSWORD}@errors.example.test/private`,
      ),
    ).toBe("outer https://safe.example.test/?next=https://errors.example.test/private");
    expect(
      redactCredentialBearingUrls(
        `outer https://safe.example.test/redirect/https://${USERNAME}:${PASSWORD}@errors.example.test/private`,
      ),
    ).toBe("outer https://safe.example.test/redirect/https://errors.example.test/private");
  });

  test("credential-free user:pass@ data in a path, query, or fragment remains unchanged", () => {
    const ordinary =
      "request https://safe.example.test/path/user:pass@notes?next=user:pass@data#fragment-user:pass@value";
    expect(redactCredentialBearingUrls(ordinary)).toBe(ordinary);
  });

  test("registry and info text renderers redact registry userinfo", () => {
    expectCredentialsAbsent(formatRegistryListPlain({ registries: unsafeConfig.registries }));
    expectCredentialsAbsent(formatRegistryRemovePlain({ removed: true, entry: unsafeConfig.registries[0] }));
    expectCredentialsAbsent(formatInfoPlain({ version: "test", registries: unsafeConfig.registries }));
  });

  test("health egress evidence redacts registry userinfo", () => {
    expectCredentialsAbsent(collectEgressAdvisory({ registries: unsafeConfig.registries }));
  });

  test("ordinary validated config remains unchanged", () => {
    expect(loadConfig().registries).toEqual(DEFAULT_CONFIG.registries);
  });

  test("serialized CLI/result/warning/error corpus contains no registry userinfo", async () => {
    const cli = await runCliCapture(["registry", "add", CREDENTIAL_URL, "--format=json"]);
    const requested: string[] = [];
    const result = await withMockedFetch(
      () => searchRegistry("needle", { registries: [{ url: CREDENTIAL_URL, name: "private" }] }),
      (url) => {
        requested.push(url);
        return new Response("{}");
      },
    );
    let configError: unknown;
    try {
      saveConfig({ ...DEFAULT_CONFIG, registries: [{ url: CREDENTIAL_URL }] });
    } catch (error) {
      configError = error;
    }
    const errorProjection =
      configError instanceof Error
        ? { name: configError.name, message: configError.message, stack: configError.stack, cause: configError.cause }
        : configError;

    expectCredentialsAbsent({ cli, result, requested, error: errorProjection });
  });
});
