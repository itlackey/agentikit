import { describe, expect, test } from "bun:test";
import {
  buildCronLine,
  CRON_BACKEND,
  type CronExec,
  type CronExecResult,
  cronBlockBody,
  extractInstalledTarget,
  listBlocks,
  removeBlock,
  renderBlock,
  toggleBlock,
  upsertBlock,
} from "../src/tasks/backends/cron";
import type { InstalledTaskRef } from "../src/tasks/backends/types";
import {
  compileTaskSchedulerBindings,
  type SchedulerBinding,
  schedulerNativeBindingId,
} from "../src/tasks/scheduler-binding";
import {
  type ScheduledTaskContext,
  schedulerContextDescriptor,
  schedulerContextPath,
} from "../src/tasks/scheduler-invocation";

const SCHEDULED_CONTEXT: ScheduledTaskContext = {
  AKM_BUNDLE_DIR: "/srv/akm stash/100%'s",
  AKM_CONFIG_DIR: "/srv/akm config",
  AKM_DATA_DIR: "/srv/akm data",
  AKM_CACHE_DIR: "/srv/akm cache",
  AKM_STATE_DIR: "/srv/akm state",
};
const contextPath = (envPath = "") => schedulerContextPath(schedulerContextDescriptor(SCHEDULED_CONTEXT, envPath));

const TASK: SchedulerBinding = {
  id: "ping",
  logicalSource: { kind: "task", ref: "stash//tasks/ping" },
  cron: "*/15 * * * *",
  source: "akm.schedule",
  ordinal: 0,
  enabled: true,
  invocation: ["task", "run", "ping", "--scheduled"],
};

function targeted(binding: SchedulerBinding, target: string): SchedulerBinding {
  return {
    ...binding,
    logicalSource: { ...binding.logicalSource, ref: `${target}//tasks/${binding.id}` },
    invocation: ["task", "run", binding.id, "--bundle", target, "--scheduled"],
  };
}

describe("cron backend helpers", () => {
  test("buildCronLine emits absolute akm path", () => {
    const line = buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log/akm", contextPath());
    expect(line).toContain("/usr/local/bin/akm --scheduler-context");
    expect(line).toContain("task run ping --scheduled");
    expect(line).not.toContain("AKM_BUNDLE_DIR=");
    expect(line).not.toContain("AKM_LLM_API_KEY");
  });

  test("buildCronLine renders a qualified workflow binding without task-only arguments", () => {
    const workflow: SchedulerBinding = {
      ...TASK,
      id: "wf-1234",
      logicalSource: { kind: "workflow", ref: "team//workflows/release" },
      source: "workflows/release.yml:on.schedule[0]",
      invocation: ["workflow", "run", "team//workflows/release"],
    };
    const line = buildCronLine(workflow, ["/usr/local/bin/akm"], "/var/log", contextPath());
    expect(line).toContain("workflow run team//workflows/release");
    expect(line).not.toContain("--scheduled");
  });

  test("buildCronLine renders the binding invocation without hidden target state", () => {
    const withTarget = buildCronLine(targeted(TASK, "work"), ["/usr/local/bin/akm"], "/var/log", contextPath());
    expect(withTarget).toContain("task run ping --bundle work --scheduled");
    const withoutTarget = buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log", contextPath());
    expect(withoutTarget).toContain("task run ping --scheduled");
    expect(withoutTarget).not.toContain("--bundle");
  });

  test("extractInstalledTarget recovers the bundle from a cron body (and undefined for the primary form)", () => {
    const withTarget = buildCronLine(targeted(TASK, "team-stash"), ["/usr/local/bin/akm"], "/var/log", contextPath());
    expect(extractInstalledTarget(withTarget)).toBe("team-stash");
    expect(extractInstalledTarget(cronBlockBody(withTarget, false))).toBe("team-stash");
    const primary = buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log", contextPath());
    expect(extractInstalledTarget(primary)).toBeUndefined();
  });

  test("buildCronLine quotes paths containing spaces", () => {
    const line = buildCronLine(TASK, ["/Applications/My Stuff/akm"], "/var/log", contextPath());
    expect(line).toContain("'/Applications/My Stuff/akm'");
  });

  test("buildCronLine preserves the installer PATH for scheduled children", () => {
    const line = buildCronLine(
      TASK,
      ["/home/user/.bun/bin/bun", "/opt/akm/cli.js"],
      "/var/log",
      contextPath("/home/user/.bun/bin:/usr/bin"),
    );
    expect(line).not.toContain("PATH=");
    expect(line).toContain("/home/user/.bun/bin/bun /opt/akm/cli.js --scheduler-context");
  });

  test("buildCronLine escapes apostrophes for POSIX shell", () => {
    const line = buildCronLine(TASK, ["/opt/akm's/bin/akm"], "/var/log/akm's", contextPath());
    expect(line).toContain("'/opt/akm'\\''s/bin/akm'");
    expect(line).toContain("'/var/log/akm'\\''s/ping.log'");
  });

  test("buildCronLine escapes cron percent syntax even inside POSIX shell quotes", () => {
    const line = buildCronLine(
      TASK,
      ["/opt/100% ready/akm's bin"],
      "/var/log/100% ready",
      contextPath("/opt/100% tools/bin:/usr/bin"),
    );
    expect(line).not.toContain("PATH=");
    expect(line).toContain("'/opt/100'\\%' ready/akm'\\''s bin'");
    expect(line).toContain("task run ping");
    expect(line).toContain("'/var/log/100'\\%' ready/ping.log'");
  });

  test("buildCronLine rejects newline injection from every interpolated input", () => {
    const cases: Array<() => string> = [
      () => buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log/akm", "/context\n* * * * * injected"),
      () => buildCronLine(TASK, ["/usr/local/bin/akm\n* * * * * injected"], "/var/log/akm", contextPath()),
      () =>
        buildCronLine(
          { ...TASK, id: "ping\n* * * * * injected" },
          ["/usr/local/bin/akm"],
          "/var/log/akm",
          contextPath(),
        ),
      () => buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log/akm\n* * * * * injected", contextPath()),
    ];
    for (const build of cases) expect(build).toThrow();
  });

  test("buildCronLine rejects C0, DEL, and C1 controls", () => {
    for (const control of ["\0", "\t", "\n", "\r", "\u001f", "\u007f", "\u0085", "\u009f"]) {
      expect(() =>
        buildCronLine(TASK, ["/usr/local/bin/akm"], "/var/log/akm", `/context${control}/file.json`),
      ).toThrow();
    }
  });

  test("renderBlock rejects control characters in marker ids", () => {
    expect(() => renderBlock("ping\n# injected", "* * * * * X", true)).toThrow("control characters");
  });

  test("renderBlock wraps the cron line in begin/end markers", () => {
    const block = renderBlock("ping", "* * * * * /bin/akm tasks run ping", true);
    expect(block.split("\n")).toEqual([
      "# akm:task ping BEGIN",
      "* * * * * /bin/akm tasks run ping",
      "# akm:task ping END",
    ]);
  });

  test("renderBlock with enabled=false comments the cron line", () => {
    const block = renderBlock("ping", "* * * * * /bin/akm tasks run ping", false);
    const middle = block.split("\n")[1];
    expect(middle!.startsWith("# akm:disabled ")).toBe(true);
  });

  test("upsertBlock inserts when absent", () => {
    const next = upsertBlock("# user line\n0 * * * * other-job\n", "ping", renderBlock("ping", "X", true));
    expect(next).toContain("# user line");
    expect(next).toContain("0 * * * * other-job");
    expect(next).toContain("# akm:task ping BEGIN");
    expect(next).toContain("# akm:task ping END");
  });

  test("upsertBlock replaces when present, leaves other lines untouched", () => {
    const initial = [
      "# user line",
      "0 * * * * other-job",
      "# akm:task ping BEGIN",
      "* * * * * old-cmd",
      "# akm:task ping END",
      "# trailing user line",
    ].join("\n");
    const next = upsertBlock(initial, "ping", renderBlock("ping", "* * * * * NEW", true));
    expect(next).toContain("0 * * * * other-job");
    expect(next).toContain("# trailing user line");
    expect(next).toContain("* * * * * NEW");
    expect(next).not.toContain("old-cmd");
  });

  test("removeBlock leaves untouched when block absent", () => {
    const initial = "0 * * * * other-job";
    expect(removeBlock(initial, "ping")).toBe(initial);
  });

  test("removeBlock removes only the named block", () => {
    const initial = [
      "0 * * * * other-job",
      "# akm:task other BEGIN",
      "0 0 * * * /bin/akm tasks run other",
      "# akm:task other END",
      "# akm:task ping BEGIN",
      "* * * * * /bin/akm tasks run ping",
      "# akm:task ping END",
    ].join("\n");
    const next = removeBlock(initial, "ping");
    expect(next).toContain("# akm:task other BEGIN");
    expect(next).not.toContain("# akm:task ping BEGIN");
    expect(next).toContain("0 * * * * other-job");
  });

  test("toggleBlock comments and uncomments the body", () => {
    const enabled = renderBlock("ping", "* * * * * X", true);
    const disabled = toggleBlock(enabled, "ping", false);
    expect(disabled).toContain("# akm:disabled * * * * * X");
    const reenabled = toggleBlock(disabled, "ping", true);
    expect(reenabled).toContain("* * * * * X");
    expect(reenabled).not.toContain("akm:disabled");
  });

  test("cronBlockBody comments only when disabled", () => {
    expect(cronBlockBody("* * * * * X", true)).toBe("* * * * * X");
    expect(cronBlockBody("* * * * * X", false)).toBe("# akm:disabled * * * * * X");
  });

  test("listBlocks parses id and body between markers", () => {
    const crontab = [
      "# user line",
      "# akm:task ping BEGIN",
      "*/15 * * * * /bin/akm tasks run ping",
      "# akm:task ping END",
      "# akm:task other BEGIN",
      "# akm:disabled 0 2 * * * /bin/akm tasks run other",
      "# akm:task other END",
    ].join("\n");
    expect(listBlocks(crontab)).toEqual([
      { id: "ping", body: "*/15 * * * * /bin/akm tasks run ping" },
      { id: "other", body: "# akm:disabled 0 2 * * * /bin/akm tasks run other" },
    ]);
  });

  test("malformed marker blocks fail instead of consuming following crontab entries", () => {
    const malformed = ["# akm:task ping BEGIN", "*/15 * * * * /bin/akm tasks run ping", "0 1 * * * user-job"].join(
      "\n",
    );

    expect(() => listBlocks(malformed)).toThrow("malformed akm task block");
    expect(() => removeBlock(malformed, "ping")).toThrow("malformed akm task block");
    expect(() => toggleBlock(malformed, "ping", false)).toThrow("malformed akm task block");
    expect(() => upsertBlock(malformed, "ping", renderBlock("ping", "X", true))).toThrow("malformed akm task block");
    expect(malformed).toContain("0 1 * * * user-job");
  });
});

// ── drift detection (the `tasks sync` schedule-change fix) ───────────────────

/** In-memory crontab so the backend never touches the real one. */
function memoryExec(initial = ""): CronExec & { current: () => string } {
  let store = initial;
  return {
    read(): CronExecResult {
      return { status: 0, stdout: store, stderr: "" };
    },
    write(content: string): CronExecResult {
      store = content;
      return { status: 0, stdout: "", stderr: "" };
    },
    current: () => store,
  };
}

const SYNC_TASK: SchedulerBinding = {
  id: "ping",
  logicalSource: { kind: "task", ref: "stash//tasks/ping" },
  cron: "*/15 * * * *",
  source: "akm.schedule",
  ordinal: 0,
  enabled: true,
  invocation: ["task", "run", "ping", "--scheduled"],
};

describe("cron backend drift detection", () => {
  const opts = (exec: CronExec) => ({
    exec,
    fs: { ensureDir() {} },
    logDir: "/var/log/akm",
    akmArgv: ["/usr/local/bin/akm"],
    envPath: false as const,
    scheduledContext: SCHEDULED_CONTEXT,
  });
  // The cron backend's list() is synchronous, but the TaskBackend interface
  // types it as `… | Promise<…>`; resolve through the concrete array shape so
  // indexing stays type-safe.
  const listSync = (b: ReturnType<typeof CRON_BACKEND>): InstalledTaskRef[] => b.list() as InstalledTaskRef[];

  const higherOrdinal = () =>
    compileTaskSchedulerBindings({
      id: "ping",
      qualifiedRef: "stash//tasks/ping",
      enabled: true,
      schedules: [
        { cron: "0 1 * * *", source: "akm.schedule[0]", ordinal: 0 },
        { cron: "0 2 * * *", source: "akm.schedule[1]", ordinal: 1 },
      ],
    })[1]!;

  const removalExpectation = (backend: ReturnType<typeof CRON_BACKEND>, binding: SchedulerBinding) => ({
    bindingId: binding.id,
    nativeId: schedulerNativeBindingId(binding.id),
    logicalSource: binding.logicalSource,
    ordinal: binding.ordinal,
    invocation: binding.invocation,
    fingerprint: backend.expectedSignature?.(binding),
  });

  const mutationExpectation = (binding: SchedulerBinding, state: "absent" | "present", fingerprint?: string) => ({
    state,
    bindingId: binding.id,
    nativeId: schedulerNativeBindingId(binding.id),
    logicalSource: binding.logicalSource,
    ordinal: binding.ordinal,
    invocation: binding.invocation,
    ...(fingerprint !== undefined ? { fingerprint } : {}),
  });

  test("direct create CAS rejects an artifact that appeared after absence was frozen", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    const owned = targeted(SYNC_TASK, "stash");
    backend.install(owned);
    const prior = exec.current();

    expect(() =>
      (backend.install as (...args: unknown[]) => void)(
        { ...owned, cron: "45 */6 * * *" },
        undefined,
        mutationExpectation(owned, "absent"),
      ),
    ).toThrow(/changed|absence|exists|compare|owner/i);
    expect(exec.current()).toBe(prior);
  });

  test("direct update CAS rejects same-owner byte drift after planning", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    const owned = targeted(SYNC_TASK, "stash");
    backend.install(owned);
    const fingerprint = backend.expectedSignature?.(owned);
    exec.write(exec.current().replace("*/15 * * * *", "7 * * * *"));
    const drifted = exec.current();

    expect(() =>
      (backend.install as (...args: unknown[]) => void)(
        { ...owned, cron: "45 */6 * * *" },
        undefined,
        mutationExpectation(owned, "present", fingerprint),
      ),
    ).toThrow(/changed|fingerprint|compare/i);
    expect(exec.current()).toBe(drifted);
  });

  test("rejects a forged expected source before any cron backend access", () => {
    let reads = 0;
    let writes = 0;
    const backend = CRON_BACKEND({
      ...opts({
        read() {
          reads += 1;
          return { status: 0, stdout: "", stderr: "" };
        },
        write() {
          writes += 1;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
      fs: { ensureDir() {} },
    });
    const owned = targeted(SYNC_TASK, "stash");
    const forged = {
      ...mutationExpectation(owned, "absent"),
      logicalSource: { kind: "task", ref: "other//tasks/ping" },
      invocation: ["task", "run", "ping", "--bundle", "other", "--scheduled"],
    };

    expect(() => (backend.install as (...args: unknown[]) => void)(owned, undefined, forged)).toThrow(
      /expectation|identity|binding|source/i,
    );
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });

  test("round-trips and updates a higher-ordinal binding whose public owner is the base task", () => {
    const backend = CRON_BACKEND(opts(memoryExec()));
    const binding = higherOrdinal();

    backend.install(binding);
    expect(listSync(backend)).toEqual([
      expect.objectContaining({
        id: binding.id,
        nativeId: schedulerNativeBindingId(binding.id),
        invocation: binding.invocation,
      }),
    ]);
    expect(backend.listNativeArtifacts?.()).toEqual([
      {
        nativeId: schedulerNativeBindingId(binding.id),
        bindingId: binding.id,
        invocation: binding.invocation,
      },
    ]);

    expect(() => backend.install(binding)).not.toThrow();
    const drifted = { ...binding, cron: "30 2 * * *" };
    expect(() => backend.install(drifted)).not.toThrow();
    expect(listSync(backend)[0]!.signature).toBe(backend.expectedSignature?.(drifted));
  });

  test.each([
    "foreign",
    "malformed",
    "fingerprint",
  ] as const)("rechecks a higher-ordinal %s owner and fingerprint immediately before uninstall", (replacement) => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    const binding = higherOrdinal();
    backend.install(binding);
    const expectation = removalExpectation(backend, binding);
    const swapped =
      replacement === "foreign"
        ? exec
            .current()
            .replaceAll(" task run ping --bundle stash --scheduled ", " task run foreign --bundle stash --scheduled ")
        : replacement === "malformed"
          ? exec.current().replaceAll(" --scheduled ", " --broken ")
          : exec.current().replace("0 2 * * *", "5 2 * * *");
    expect(swapped).not.toBe(exec.current());
    exec.write(swapped);

    const uninstall = backend.uninstall as unknown as (nativeId: string, expectedOwner: typeof expectation) => void;
    expect(() => uninstall(expectation.nativeId, expectation)).toThrow(/changed|owner|malformed|refusing/i);
    expect(exec.current()).toBe(swapped);
  });

  test("list() returns a signature equal to expectedSignature for an installed task", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    backend.install(SYNC_TASK);
    const listed = listSync(backend);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe("ping");
    expect(listed[0]!.signature).toBe(backend.expectedSignature?.(SYNC_TASK));
    // No --bundle token → primary attribution (target omitted).
    expect(listed[0]!.target).toBeUndefined();
  });

  test("list() attributes a target-installed entry, and its signature matches the target-aware expectation", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    const targetBinding = targeted(SYNC_TASK, "work");
    backend.install(targetBinding);
    const listed = listSync(backend);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.target).toBe("work");
    expect(listed[0]!.signature).toBe(backend.expectedSignature?.(targetBinding));
    // The target-aware signature differs from the primary (no-target) one.
    expect(backend.expectedSignature?.(targetBinding)).not.toBe(backend.expectedSignature?.(SYNC_TASK));
  });

  test("round-trips a nested logical id through a portable native marker", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    const nested = {
      ...SYNC_TASK,
      id: "sub/deep/nightly",
      logicalSource: { kind: "task" as const, ref: "team//sub/deep/nightly" },
      invocation: ["task", "run", "sub/deep/nightly", "--bundle", "team", "--scheduled"],
    };

    backend.install(nested);

    expect(exec.current()).not.toContain("# akm:task sub/deep/nightly BEGIN");
    expect(listSync(backend)).toEqual([expect.objectContaining({ id: "sub/deep/nightly", target: "team" })]);

    const colliding = {
      ...SYNC_TASK,
      id: "task-b0117b892c35999ceb4d5386f8609932",
      logicalSource: { kind: "task" as const, ref: "team//task-b0117b892c35999ceb4d5386f8609932" },
      invocation: ["task", "run", "task-b0117b892c35999ceb4d5386f8609932", "--bundle", "team", "--scheduled"],
    };
    expect(() => backend.install(colliding)).toThrow(/native scheduler artifact|different logical owner/i);
    expect(listSync(backend)).toEqual([expect.objectContaining({ id: "sub/deep/nightly", target: "team" })]);
  });

  // 0.9 scheduler ABI respelling (S6): an entry whose invocation no longer
  // parses (missing context descriptor, pre-rename `tasks run` spelling, or
  // any other foreign content between the markers) is an orphan of its
  // marker id, not a hard failure — `list()` omits it so `akmTasksSync`
  // treats the id as "not present" and reinstalls it from the task file.
  test("list() omits an entry without the current context descriptor", () => {
    const exec = memoryExec(
      [
        "# akm:task ping BEGIN",
        "*/15 * * * * /usr/local/bin/akm tasks run ping --scheduled >> /var/log/akm/ping.log 2>&1",
        "# akm:task ping END",
        "",
      ].join("\n"),
    );

    const backend = CRON_BACKEND(opts(exec));
    expect(backend.list()).toEqual([]);
    expect(backend.listNativeArtifacts?.()).toEqual([{ nativeId: "ping" }]);
  });

  test("expectedSignature changes when the schedule changes (drift is detectable)", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    backend.install(SYNC_TASK);
    const installedSig = listSync(backend)[0]!.signature;
    const rescheduled: SchedulerBinding = { ...SYNC_TASK, cron: "45 */6 * * *" };
    expect(backend.expectedSignature?.(rescheduled)).not.toBe(installedSig);
  });

  test("expectedSignature changes when enabled flips", () => {
    const backend = CRON_BACKEND(opts(memoryExec()));
    const enabledSig = backend.expectedSignature?.({ ...SYNC_TASK, enabled: true });
    const disabledSig = backend.expectedSignature?.({ ...SYNC_TASK, enabled: false });
    expect(enabledSig).not.toBe(disabledSig);
  });

  test("signature is stable across reinstall when nothing changed", () => {
    const backend = CRON_BACKEND(opts(memoryExec()));
    backend.install(SYNC_TASK);
    const sig1 = listSync(backend)[0]!.signature;
    backend.install(SYNC_TASK);
    const sig2 = listSync(backend)[0]!.signature;
    expect(sig1).toBe(sig2);
    expect(sig1).toBe(backend.expectedSignature?.(SYNC_TASK));
  });

  test("signature remains stable with escaped percent, spaces, and apostrophes", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND({
      exec,
      fs: { ensureDir() {} },
      logDir: "/var/log/100% ready/akm's",
      akmArgv: ["/opt/100% ready/akm's bin"],
      envPath: "/opt/100% tools/bin:/usr/bin",
      scheduledContext: SCHEDULED_CONTEXT,
    });
    backend.install(SYNC_TASK);
    const sig1 = listSync(backend)[0]!.signature;
    backend.install(SYNC_TASK);
    const sig2 = listSync(backend)[0]!.signature;
    expect(sig1).toBe(sig2);
    expect(sig1).toBe(backend.expectedSignature?.(SYNC_TASK));
  });

  test("expected signature changes when the resolved AKM context changes", () => {
    const original = CRON_BACKEND(opts(memoryExec()));
    const moved = CRON_BACKEND({
      ...opts(memoryExec()),
      scheduledContext: { ...SCHEDULED_CONTEXT, AKM_DATA_DIR: "/srv/moved data" },
    });

    expect(original.expectedSignature?.(SYNC_TASK)).not.toBe(moved.expectedSignature?.(SYNC_TASK));
  });

  test("a failed crontab replacement restores the complete prior crontab", () => {
    let store = "0 1 * * * user-job\n";
    let failNextWrite = false;
    const writes: string[] = [];
    const exec: CronExec = {
      read: () => ({ status: 0, stdout: store, stderr: "" }),
      write(content) {
        writes.push(content);
        store = content;
        if (failNextWrite) {
          failNextWrite = false;
          return { status: 1, stdout: "", stderr: "injected write failure" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const backend = CRON_BACKEND(opts(exec));
    backend.install(SYNC_TASK);
    const prior = store;
    failNextWrite = true;

    expect(() => backend.install({ ...SYNC_TASK, cron: "45 */6 * * *" })).toThrow("injected write failure");

    expect(writes).toHaveLength(3);
    expect(store).toBe(prior);
    expect(store).toContain("*/15 * * * *");
    expect(store).not.toContain("45 */6 * * *");
  });

  test("binding snapshots restore the exact whole crontab after multi-binding mutation", () => {
    const exec = memoryExec("0 1 * * * user-job\n");
    const backend = CRON_BACKEND(opts(exec));
    const second = { ...SYNC_TASK, id: "second", invocation: ["task", "run", "second", "--scheduled"] };
    backend.install(SYNC_TASK);
    backend.install(second);
    const prior = exec.current();
    const snapshot = backend.snapshotBindings?.([SYNC_TASK.id, second.id, "absent"]);

    backend.uninstall(SYNC_TASK.id);
    backend.install({ ...second, cron: "45 */6 * * *" });
    backend.restoreBindings?.(snapshot);

    expect(exec.current()).toBe(prior);
    expect(exec.current()).toStartWith("0 1 * * * user-job\n");
  });

  test("snapshot rollback CAS never clobbers a concurrent same-native cron edit", () => {
    const exec = memoryExec();
    const backend = CRON_BACKEND(opts(exec));
    const owned = targeted(SYNC_TASK, "stash");
    const snapshot = backend.snapshotBindings?.(["ping"]);
    backend.install(owned);
    const concurrent = exec.current().replace("*/15 * * * *", "7 * * * *");
    exec.write(concurrent);
    const restore = backend.restoreBindings as unknown as (
      snapshot: unknown,
      guards: readonly Record<string, unknown>[],
    ) => void;

    expect(() =>
      restore(snapshot, [
        {
          nativeId: "ping",
          allowed: [
            { state: "absent" },
            {
              state: "present",
              bindingId: owned.id,
              invocation: owned.invocation,
              fingerprint: backend.expectedSignature?.(owned),
            },
          ],
        },
      ]),
    ).toThrow(/rollback|changed|concurrent|fingerprint/i);
    expect(exec.current()).toBe(concurrent);
  });

  test("an unterminated block aborts uninstall without writing the crontab", () => {
    const malformed = "# akm:task ping BEGIN\n*/15 * * * * old-command\n0 1 * * * user-job\n";
    let writes = 0;
    const exec: CronExec = {
      read: () => ({ status: 0, stdout: malformed, stderr: "" }),
      write: () => {
        writes += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    };

    expect(() => CRON_BACKEND(opts(exec)).uninstall("ping")).toThrow("malformed akm task block");
    expect(writes).toBe(0);
  });

  test("log-directory creation failure aborts install before reading or writing crontab", () => {
    let reads = 0;
    let writes = 0;
    const exec: CronExec = {
      read: () => {
        reads += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
      write: () => {
        writes += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const backend = CRON_BACKEND({
      ...opts(exec),
      fs: {
        ensureDir() {
          throw new Error("injected log directory failure");
        },
      },
    });

    expect(() => backend.install(SYNC_TASK)).toThrow("injected log directory failure");
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });

  test("rejects a cron command over the portable 1000-byte ceiling before scheduler I/O", () => {
    let reads = 0;
    let writes = 0;
    const exec: CronExec = {
      read: () => {
        reads += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
      write: () => {
        writes += 1;
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const backend = CRON_BACKEND({
      ...opts(exec),
      akmArgv: [`/${"x".repeat(1100)}`],
    });

    expect(() => backend.install(SYNC_TASK)).toThrow("limited to 1000 bytes");
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });
});
