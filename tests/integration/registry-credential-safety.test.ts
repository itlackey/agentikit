import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { getConfigValue, listConfig } from "../../src/commands/config-cli";
import { collectEgressAdvisory } from "../../src/commands/health/surfaces";
import { resolveRegistries, searchRegistry } from "../../src/commands/read/registry-search";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../../src/core/config/config";
import {
  formatRegistryError,
  formatRegistryUrl,
  hasRegistryUrlCredentials,
  redactCredentialBearingUrls,
} from "../../src/core/registry-url";
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
const EXACT_SCHEME_CONTROL_URL = "https:\t//audit-user:audit-pass@host.test/index.json";
const EXACT_NESTED_SCHEME_CONTROL_URL = "https://safe.test/?next=h\tttps://nested-user:nested-pass@evil.test/x";
const CONTROL_CHARACTERS = ["\t", "\r", "\n"] as const;
const CANONICAL_SCHEMES = ["http://", "https://"] as const;
const CONTROL_SCHEME_CREDENTIAL_URLS = [
  EXACT_SCHEME_CONTROL_URL,
  ...CONTROL_CHARACTERS.flatMap((control) =>
    CANONICAL_SCHEMES.flatMap((canonicalScheme) =>
      Array.from({ length: canonicalScheme.length - 1 }, (_, offset) => {
        const insertion = offset + 1;
        const scheme = `${canonicalScheme.slice(0, insertion)}${control}${canonicalScheme.slice(insertion)}`;
        return `${scheme}${USERNAME}:${PASSWORD}@controls.example.test/index.json`;
      }),
    ),
  ),
] as const;
const NESTED_CONTROL_SCHEME_CREDENTIAL_URLS = [
  EXACT_NESTED_SCHEME_CONTROL_URL,
  ...CONTROL_SCHEME_CREDENTIAL_URLS.map((url) => `https://safe.test/?next=${url}`),
] as const;
const SOFT_DELIMITER_USERNAME_URLS = [" ", '"', "'", "`", "<", ">"].map(
  (delimiter) => `https://audit${delimiter}soft-user-secret@userinfo.example.test/index.json`,
);
const PASSWORD_DELIMITER_URLS = ["&", ";", ",", ")"].map(
  (delimiter) => `https://delimiter-user:delimiter-pass${delimiter}tail@userinfo.example.test/index.json`,
);
const STRICT_NESTED_USERINFO_URLS = [
  "https://registry.test/?next=https://john.doe outer-secret@evil.test/x",
  "https://registry.test/?next=https://localhost localhost-secret@evil.test/x",
  "https://registry.test/?next=https://xn--audit-user idn-secret@evil.test/x",
  "https://registry.test/?next=https://[::1] ipv6-secret@evil.test/x",
] as const;
const TOP_LEVEL_STRUCTURAL_URLS = [
  ["https://decoy@R3SECRET@host.test/x", "https://host.test/x"],
  ["https://first@second:R3PASS@host.test/x", "https://host.test/x"],
  [
    "https://outer-user:outer-pass@host.test/?next=https://nested-user:nested-pass@evil.test/x",
    "https://host.test/?next=https://evil.test/x",
  ],
  [
    "https://outer-r3:R3OUT@host.test/?next=https://decoy@nested:R3NEST@evil.test/x",
    "https://host.test/?next=https://evil.test/x",
  ],
  ["https://r3 soft-user@host.test/x", "https://host.test/x"],
  ...["&", ";", ",", ")"].map(
    (delimiter) => [`https://r3-user:r3-pass${delimiter}tail@host.test/x`, "https://host.test/x"] as const,
  ),
] as const;
const BACKSLASH = "\\";
const SPECIAL_DIAGNOSTIC_CREDENTIAL_URLS = [
  `https:${BACKSLASH}${BACKSLASH}special-user:special-pass@host.test/x`,
  `https:${BACKSLASH}special-user:special-pass@host.test/x`,
  `https:/${BACKSLASH}special-user:special-pass@host.test/x`,
  `https:${BACKSLASH}/special-user:special-pass@host.test/x`,
  "https:///special-user:special-pass@host.test/x",
  "https:special-user:special-pass@host.test/x",
];
const SAFE_SPECIAL_DIAGNOSTIC_URLS = [
  `fetch https:${BACKSLASH}${BACKSLASH}safe.test${BACKSLASH}path failed`,
  `fetch https:${BACKSLASH}${BACKSLASH}safe.test user@example.com`,
  `fetch https:${BACKSLASH}safe.test/path failed`,
  `fetch https:${BACKSLASH}safe.test user@example.com`,
  `fetch https:/${BACKSLASH}safe.test/path failed`,
  `fetch https:/${BACKSLASH}safe.test user@example.com`,
  `fetch https:${BACKSLASH}/safe.test/path failed`,
  `fetch https:${BACKSLASH}/safe.test user@example.com`,
  "fetch https:///safe.test/path failed",
  "fetch https:///safe.test user@example.com",
  "fetch https:safe.test/path failed",
  "fetch https:safe.test user@example.com",
  "fetch https: safe.test user@example.com",
];
const CONFIG_LOAD_CONTROL_URLS = CONTROL_CHARACTERS.flatMap((control) => {
  const whole = `https:${control}//${USERNAME}:${PASSWORD}@load.example.test/index.json`;
  return [whole, `https://safe.test/?next=${whole}`];
});
const SAFE_REDACTION_NEGATIVE_CONTROLS = [
  "visit https://safe.test then email user@example.com",
  "https://registry.test/?redirect=https://safe.test&email=user@example.com",
  "https://registry.test/redirect/https://safe.test/path/user@example.com",
  "https://registry.test/#redirect=https://safe.test&email=user@example.com",
  "visit https://safe.test, then email user@example.com",
  "https://registry.test/https://safe.test;owner=user@example.com",
  "visit (https://safe.test) then email user@example.com",
  "https://registry.test/?redirect=https://safe.test,email=user@example.com",
  "https://registry.test/?redirect=https://safe.test;owner=user@example.com",
  "https://registry.test/?redirect=(https://safe.test)&email=user@example.com",
  "visit https://safe.test:bad then email user@example.com",
  "visit https://safe.test:bad user@example.com",
] as const;
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
  for (const marker of [
    USERNAME,
    PASSWORD,
    "audit-user",
    "audit-pass",
    "nested-user",
    "nested-pass",
    "soft-user-secret",
    "delimiter-user",
    "delimiter-pass",
    "outer-secret",
    "localhost-secret",
    "idn-secret",
    "ipv6-secret",
    "R3SECRET",
    "R3PASS",
    "R3OUT",
    "R3NEST",
    "outer-user",
    "outer-pass",
    "r3 soft-user",
    "r3-user",
    "r3-pass",
    "special-user",
    "special-pass",
  ]) {
    expect(serialized).not.toContain(marker);
  }
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

  test("registry add and config set reject control-obfuscated schemes before persistence", async () => {
    const configPath = path.join(storage.configDir, "akm", "config.json");
    const add = await runCliCapture(["registry", "add", EXACT_SCHEME_CONTROL_URL, "--verbose", "--format=json"]);
    const set = await runCliCapture([
      "config",
      "set",
      "registries",
      JSON.stringify([{ url: EXACT_NESTED_SCHEME_CONTROL_URL, name: "private" }]),
      "--format=json",
    ]);

    for (const result of [add, set]) {
      expect(result.code).not.toBe(0);
      expectCredentialsAbsent(result.stdout);
      expectCredentialsAbsent(result.stderr);
    }
    expectCredentialsAbsent(fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "");
  });

  test("registry add rejects strict nested userinfo with a host-shaped username", async () => {
    const configPath = path.join(storage.configDir, "akm", "config.json");
    const result = await runCliCapture([
      "registry",
      "add",
      STRICT_NESTED_USERINFO_URLS[0],
      "--verbose",
      "--format=json",
    ]);

    expect(result.code).not.toBe(0);
    expectCredentialsAbsent(result.stdout);
    expectCredentialsAbsent(result.stderr);
    expectCredentialsAbsent(fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "");
  });

  test("config set rejects strict nested userinfo with a host-shaped username", async () => {
    const configPath = path.join(storage.configDir, "akm", "config.json");
    const result = await runCliCapture([
      "config",
      "set",
      "registries",
      JSON.stringify([{ url: STRICT_NESTED_USERINFO_URLS[1], name: "private" }]),
      "--format=json",
    ]);

    expect(result.code).not.toBe(0);
    expectCredentialsAbsent(result.stdout);
    expectCredentialsAbsent(result.stderr);
    expectCredentialsAbsent(fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "");
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

  test("the shared save boundary rejects controls in every scheme/separator gap, including nested URLs", () => {
    for (const url of [...CONTROL_SCHEME_CREDENTIAL_URLS, ...NESTED_CONTROL_SCHEME_CREDENTIAL_URLS]) {
      expect(() => saveConfig({ ...DEFAULT_CONFIG, registries: [{ url, name: "control-private" }] })).toThrow(
        "credential",
      );
    }

    const configPath = path.join(storage.configDir, "akm", "config.json");
    expect(fs.existsSync(configPath)).toBe(false);
  });

  test("the shared save boundary rejects every strict nested host-shaped username", () => {
    for (const url of STRICT_NESTED_USERINFO_URLS) {
      expect(() => saveConfig({ ...DEFAULT_CONFIG, registries: [{ url, name: "strict-private" }] })).toThrow(
        "credential",
      );
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

  test("control-obfuscated whole and nested URLs fail config load without leaking", async () => {
    for (const url of [EXACT_SCHEME_CONTROL_URL, EXACT_NESTED_SCHEME_CONTROL_URL, ...CONFIG_LOAD_CONTROL_URLS]) {
      writeSandboxConfig({ registries: [{ url, name: "control-private", provider: "static-index" }] });
      const result = await runCliCapture(["registry", "list", "--verbose", "--format=json"]);

      expect(result.code).toBe(78);
      expectCredentialsAbsent(result.stdout);
      expectCredentialsAbsent(result.stderr);
      expect(result.stderr.toLowerCase()).toContain("credential");
    }
  });

  test("persisted strict nested host-shaped usernames fail config load without leaking", async () => {
    for (const url of STRICT_NESTED_USERINFO_URLS) {
      writeSandboxConfig({ registries: [{ url, name: "strict-private", provider: "static-index" }] });
      const result = await runCliCapture(["registry", "list", "--verbose", "--format=json"]);

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

  test("static-index and skills-sh never fetch control-obfuscated whole or nested URLs", async () => {
    const requested: string[] = [];
    const results = await withMockedFetch(
      async () => {
        const captured = [];
        for (const providerType of ["static-index", "skills-sh"]) {
          const factory = resolveRegistryProviderFactory(providerType);
          if (!factory) throw new Error(`Built-in registry provider ${providerType} is not registered`);
          for (const url of [...CONTROL_SCHEME_CREDENTIAL_URLS, EXACT_NESTED_SCHEME_CONTROL_URL]) {
            captured.push(
              await factory({ url, name: `${providerType}-control-private` }).search({ query: "needle", limit: 20 }),
            );
          }
        }
        return captured;
      },
      (url) => {
        requested.push(url);
        return new Response("{}");
      },
    );

    expect(requested).toEqual([]);
    for (const result of results) {
      expect(result.hits).toEqual([]);
      expect(result.warnings?.[0]?.toLowerCase()).toContain("credential");
      expectCredentialsAbsent(result);
    }
  });

  test("static-index and skills-sh never fetch strict nested host-shaped userinfo", async () => {
    const requested: string[] = [];
    const results = await withMockedFetch(
      async () => {
        const captured = [];
        for (const providerType of ["static-index", "skills-sh"]) {
          const factory = resolveRegistryProviderFactory(providerType);
          if (!factory) throw new Error(`Built-in registry provider ${providerType} is not registered`);
          for (const url of STRICT_NESTED_USERINFO_URLS) {
            captured.push(
              await factory({ url, name: `${providerType}-strict-private` }).search({ query: "needle", limit: 20 }),
            );
          }
        }
        return captured;
      },
      (url) => {
        requested.push(url);
        return new Response("{}");
      },
    );

    expect(requested).toEqual([]);
    for (const result of results) {
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

  test("control-obfuscated schemes are removed from response warnings and file logs", async () => {
    const logPath = path.join(storage.root, "registry-controls.log");
    setLogFile(logPath);
    const corpus = [
      ...CONTROL_SCHEME_CREDENTIAL_URLS,
      ...NESTED_CONTROL_SCHEME_CREDENTIAL_URLS,
      ...SOFT_DELIMITER_USERNAME_URLS,
      ...PASSWORD_DELIMITER_URLS,
      ...TOP_LEVEL_STRUCTURAL_URLS.map(([url]) => url),
      ...SPECIAL_DIAGNOSTIC_CREDENTIAL_URLS,
    ].join("\n");

    const result = await withMockedFetch(
      () =>
        searchRegistry("needle", {
          registries: [{ url: "https://skills.example.test", name: "skills", provider: "skills-sh" }],
        }),
      () => {
        throw new Error(`control-obfuscated fetch failures:\n${corpus}`);
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
    const stashSets = await withMockedFetch(
      () =>
        Promise.all(
          [CREDENTIAL_URL, EXACT_SCHEME_CONTROL_URL, EXACT_NESTED_SCHEME_CONTROL_URL].map((url) =>
            loadSetupStashes(url),
          ),
        ),
      (url) => {
        requested.push(url);
        return new Response("{}");
      },
    );

    expect(requested).toEqual([]);
    for (const stashes of stashSets) {
      expect(stashes.length).toBeGreaterThan(0);
      expectCredentialsAbsent(stashes);
    }
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

  test("configured and nested URLs with controls anywhere in the scheme fail closed", () => {
    for (const unsafe of [...CONTROL_SCHEME_CREDENTIAL_URLS, ...NESTED_CONTROL_SCHEME_CREDENTIAL_URLS]) {
      expect(hasRegistryUrlCredentials(unsafe)).toBe(true);
      expectCredentialsAbsent(formatRegistryUrl(unsafe));
      expectCredentialsAbsent(redactCredentialBearingUrls(`diagnostic: ${unsafe}`));
    }
  });

  test("strict configured detection rejects nested host-shaped usernames while formatting every projection safely", () => {
    for (const url of STRICT_NESTED_USERINFO_URLS) {
      const registries = [{ url, name: "strict-private", provider: "static-index" }];
      const config = { ...DEFAULT_CONFIG, registries };

      expect(hasRegistryUrlCredentials(url)).toBe(true);
      expectCredentialsAbsent(formatRegistryUrl(url));
      expectCredentialsAbsent(getConfigValue(config, "registries"));
      expectCredentialsAbsent(listConfig(config));
      expectCredentialsAbsent(formatRegistryListPlain({ registries }));
      expectCredentialsAbsent(formatRegistryRemovePlain({ removed: true, entry: registries[0] }));
      expectCredentialsAbsent(formatInfoPlain({ version: "test", registries }));
      expectCredentialsAbsent(collectEgressAdvisory({ registries }));
    }
  });

  test("whole formatter structurally clears all top-level userinfo before sanitizing nested URLs", () => {
    for (const [unsafe, expected] of TOP_LEVEL_STRUCTURAL_URLS) {
      expect(formatRegistryUrl(unsafe)).toBe(expected);
      expectCredentialsAbsent(formatRegistryUrl(unsafe));
    }
  });

  test.each(
    TOP_LEVEL_STRUCTURAL_URLS.map(([url]) => url),
  )("diagnostic redaction removes authority userinfo through the last @: %s", (unsafe) => {
    const diagnostic = `fetch failed for ${unsafe}`;
    expectCredentialsAbsent(redactCredentialBearingUrls(diagnostic));
    expectCredentialsAbsent(formatRegistryError(new Error(diagnostic)));
  });

  test.each(
    SPECIAL_DIAGNOSTIC_CREDENTIAL_URLS,
  )("diagnostic redaction recognizes WHATWG special-scheme spelling: %s", (unsafe) => {
    const diagnostic = `fetch failed for ${unsafe}`;
    expectCredentialsAbsent(redactCredentialBearingUrls(diagnostic));
    expectCredentialsAbsent(formatRegistryError(new Error(diagnostic)));
  });

  test.each(
    SAFE_SPECIAL_DIAGNOSTIC_URLS,
  )("diagnostic redaction preserves credential-free special-scheme spelling: %s", (ordinary) => {
    expect(redactCredentialBearingUrls(ordinary)).toBe(ordinary);
    expect(formatRegistryError(new Error(ordinary))).toContain(ordinary);
  });

  test.each(
    SOFT_DELIMITER_USERNAME_URLS,
  )("diagnostic redaction removes delimiter-heavy username-only userinfo: %s", (unsafe) => {
    const diagnostic = `fetch failed for ${unsafe}`;
    expect(hasRegistryUrlCredentials(diagnostic)).toBe(true);
    expectCredentialsAbsent(redactCredentialBearingUrls(diagnostic));
    expectCredentialsAbsent(formatRegistryError(new Error(diagnostic)));
  });

  test.each(PASSWORD_DELIMITER_URLS)("diagnostic redaction removes delimiter-heavy password userinfo: %s", (unsafe) => {
    const diagnostic = `fetch failed for ${unsafe}`;
    expect(hasRegistryUrlCredentials(diagnostic)).toBe(true);
    expectCredentialsAbsent(redactCredentialBearingUrls(diagnostic));
    expectCredentialsAbsent(formatRegistryError(new Error(diagnostic)));
  });

  test("control-obfuscated configured URLs stay secret across config, text, info, and health projections", () => {
    for (const url of [EXACT_SCHEME_CONTROL_URL, EXACT_NESTED_SCHEME_CONTROL_URL]) {
      const registries = [{ url, name: "control-private", provider: "static-index" }];
      const config = { ...DEFAULT_CONFIG, registries };

      expectCredentialsAbsent(getConfigValue(config, "registries"));
      expectCredentialsAbsent(listConfig(config));
      expectCredentialsAbsent(formatRegistryListPlain({ registries }));
      expectCredentialsAbsent(formatRegistryRemovePlain({ removed: true, entry: registries[0] }));
      expectCredentialsAbsent(formatInfoPlain({ version: "test", registries }));
      expectCredentialsAbsent(collectEgressAdvisory({ registries }));
    }
  });

  test("repeated and nested top-level userinfo stays secret across every configured output and log sink", async () => {
    const logPath = path.join(storage.root, "registry-r3.log");
    setLogFile(logPath);
    const requested: string[] = [];

    for (const [url] of TOP_LEVEL_STRUCTURAL_URLS) {
      const registries = [{ url, name: "r3-private", provider: "static-index" }];
      const config = { ...DEFAULT_CONFIG, registries };
      expectCredentialsAbsent(getConfigValue(config, "registries"));
      expectCredentialsAbsent(listConfig(config));
      expectCredentialsAbsent(formatRegistryListPlain({ registries }));
      expectCredentialsAbsent(formatRegistryRemovePlain({ removed: true, entry: registries[0] }));
      expectCredentialsAbsent(formatInfoPlain({ version: "test", registries }));
      expectCredentialsAbsent(collectEgressAdvisory({ registries }));

      const result = await withMockedFetch(
        () => searchRegistry("needle", { registries }),
        (requestedUrl) => {
          requested.push(requestedUrl);
          return new Response("{}");
        },
      );
      for (const warning of result.warnings) warn(warning);
      expectCredentialsAbsent(result);

      const remove = await runCliCapture(["registry", "remove", url, "--yes", "--format=json"]);
      expect(remove.code).toBe(1);
      expectCredentialsAbsent(remove.stdout);
      expectCredentialsAbsent(remove.stderr);
    }

    writeSandboxConfig({
      registries: [{ url: TOP_LEVEL_STRUCTURAL_URLS[0][0], name: "persisted-r3", provider: "static-index" }],
    });
    const persisted = await runCliCapture(["registry", "list", "--verbose", "--format=json"]);
    expect(persisted.code).toBe(78);
    expectCredentialsAbsent(persisted.stdout);
    expectCredentialsAbsent(persisted.stderr);
    expect(requested).toEqual([]);
    expectCredentialsAbsent(fs.readFileSync(logPath, "utf8"));
  });

  test("credential-free user:pass@ data in a path, query, or fragment remains unchanged", () => {
    const ordinary =
      "request https://safe.example.test/path/user:pass@notes?next=user:pass@data#fragment-user:pass@value";
    expect(redactCredentialBearingUrls(ordinary)).toBe(ordinary);
  });

  test("safe URLs followed by email and delimiter text are preserved exactly", () => {
    for (const ordinary of SAFE_REDACTION_NEGATIVE_CONTROLS) {
      expect(redactCredentialBearingUrls(ordinary)).toBe(ordinary);
    }

    const configured = SAFE_REDACTION_NEGATIVE_CONTROLS.filter((value) => value.startsWith("https://registry.test"));
    for (const ordinary of configured) {
      expect(hasRegistryUrlCredentials(ordinary)).toBe(false);
      expect(formatRegistryUrl(ordinary)).toBe(ordinary);
    }
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
