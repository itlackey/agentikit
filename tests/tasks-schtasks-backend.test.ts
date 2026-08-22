import { describe, expect, test } from "bun:test";
import { decodeCommandOutput, escapeXml } from "../src/tasks/backends/exec-utils";
import type { SchtasksExec, SchtasksFs } from "../src/tasks/backends/schtasks";
import { buildSchtasksXml, extractSchtasksTarget, SCHTASKS_BACKEND } from "../src/tasks/backends/schtasks";
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
  AKM_BUNDLE_DIR: "C:\\Users\\Akm User\\O'Brien & notes",
  AKM_CONFIG_DIR: "C:\\Users\\Akm User\\config",
  AKM_DATA_DIR: "C:\\Users\\Akm User\\data",
  AKM_CACHE_DIR: "C:\\Users\\Akm User\\cache",
  AKM_STATE_DIR: "C:\\Users\\Akm User\\state",
};
const USER_SID = "S-1-5-21-1000-2000-3000-1001";

const xmlOptions = <T extends Record<string, unknown>>(options?: T) => ({
  ...options,
  contextPath: schedulerContextPath(schedulerContextDescriptor(SCHEDULED_CONTEXT, process.env.PATH ?? "")),
  userSid: USER_SID,
});

function makeTask(schedule: string, id = "ping", enabled = true): SchedulerBinding {
  return {
    id,
    logicalSource: { kind: "task", ref: `stash//tasks/${id}` },
    cron: schedule,
    source: "akm.schedule",
    ordinal: 0,
    enabled,
    invocation: ["task", "run", id, "--scheduled"],
  };
}

function qualifiedTask(schedule: string, id = "ping", enabled = true): SchedulerBinding {
  return {
    ...makeTask(schedule, id, enabled),
    nativeId: schedulerNativeBindingId(id),
    logicalSource: { kind: "task", ref: `stash//tasks/${id}` },
    invocation: ["task", "run", id, "--bundle", "stash", "--scheduled"],
  };
}

function mutationExpectation(binding: SchedulerBinding, state: "absent" | "present", fingerprint?: string) {
  return {
    state,
    bindingId: binding.id,
    nativeId: binding.nativeId ?? schedulerNativeBindingId(binding.id),
    logicalSource: binding.logicalSource,
    ordinal: binding.ordinal,
    invocation: binding.invocation,
    ...(fingerprint !== undefined ? { fingerprint } : {}),
  };
}

function localDate(year: number, month: number, day: number, hour: number, minute: number, second: number): Date {
  return new Date(year, month - 1, day, hour, minute, second);
}

function startBoundary(xml: string): string {
  const match = xml.match(/<StartBoundary>([^<]+)<\/StartBoundary>/);
  if (!match) throw new Error("missing StartBoundary");
  return match[1]!;
}

function startBoundaries(xml: string): string[] {
  return [...xml.matchAll(/<StartBoundary>([^<]+)<\/StartBoundary>/g)].map((match) => match[1]!);
}

function sourceSignature(xml: string): string {
  const match = xml.match(/<Source>([^<]+)<\/Source>/);
  if (!match) throw new Error("missing Source signature");
  return match[1]!;
}

function descriptorlessTargetXml(): string {
  const task = makeTask("0 9 * * *");
  const binding = "C:\\Program Files\\O'Brien & Sons\\akm.exe";
  const powershellEnv = "$" + "env:";
  const script = [
    `${powershellEnv}AKM_DATA_DIR='C:\\Data & O''Brien'`,
    `${powershellEnv}PATH='C:\\Tools & More'`,
    `& '${binding.replaceAll("'", "''")}' 'tasks' 'run' 'ping' '--target' 'work' '--scheduled'`,
    "exit $LASTEXITCODE",
  ].join("; ");
  const argumentsValue = `-NoLogo -NoProfile -NonInteractive -Command "${script}"`;
  return buildSchtasksXml(task, [binding], "C:/log", xmlOptions()).replace(
    /<Arguments>[\s\S]*?<\/Arguments>/,
    `<Arguments>${escapeXml(argumentsValue)}</Arguments>`,
  );
}

describe("buildSchtasksXml", () => {
  test("common-divisor minute steps reset daily without losing wall-clock phase", () => {
    const xml = buildSchtasksXml(makeTask("*/5 * * * *"), ["C:/akm/akm.exe"], "C:/log", xmlOptions());
    expect(xml).toContain("<CalendarTrigger>");
    expect(xml).toContain("<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>");
    expect(xml).toContain("<Interval>PT5M</Interval>");
    expect(xml).toContain("<Duration>PT23H55M</Duration>");
    expect(xml).not.toContain("<Duration>P1D</Duration>");
    expect(xml).not.toContain("<TimeTrigger>");
    expect(xml).toContain("<URI>\\akm\\ping</URI>");
    expect(xml).toContain(`<UserId>${USER_SID}</UserId>`);
    expect(xml).toContain("<Command>powershell.exe</Command>");
    expect(xml).not.toContain("$env:AKM_BUNDLE_DIR=");
    expect(xml).toContain("&apos;--scheduler-context&apos;");
    expect(xml).toContain("&apos;task&apos; &apos;run&apos; &apos;ping&apos; &apos;--scheduled&apos;");
    expect(xml).not.toContain("AKM_LLM_API_KEY");
    expect(xml).toContain("<Enabled>true</Enabled>");
    expect(xml).not.toContain("<WorkingDirectory>");
  });

  test("renders a qualified workflow binding without task-only arguments", () => {
    const workflow: SchedulerBinding = {
      ...makeTask("0 9 * * *", "wf-1234"),
      logicalSource: { kind: "workflow", ref: "team//workflows/release" },
      source: "workflows/release.yml:on.schedule[0]",
      invocation: ["workflow", "run", "team//workflows/release"],
    };
    const xml = buildSchtasksXml(workflow, ["C:/akm.exe"], "C:/log", xmlOptions());
    expect(xml).toContain("&apos;workflow&apos;");
    expect(xml).toContain("&apos;team//workflows/release&apos;");
    expect(xml).not.toContain("&apos;--scheduled&apos;");
  });

  test("non-divisor minute steps reset on every hour indefinitely", () => {
    const xml = buildSchtasksXml(
      makeTask("*/7 * * * *"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({ now: () => localDate(2026, 7, 13, 10, 2, 37) }),
    );

    expect(xml.match(/<CalendarTrigger>/g)).toHaveLength(9);
    expect(xml.match(/<Interval>PT1H<\/Interval>/g)).toHaveLength(9);
    expect(xml.match(/<Duration>PT23H<\/Duration>/g)).toHaveLength(9);
    expect(startBoundaries(xml).map((boundary) => boundary.slice(11))).toEqual([
      "11:00:00",
      "10:07:00",
      "10:14:00",
      "10:21:00",
      "10:28:00",
      "10:35:00",
      "10:42:00",
      "10:49:00",
      "10:56:00",
    ]);
  });

  test("fixed-minute hourly schedules repeat at that minute and reset daily", () => {
    const xml = buildSchtasksXml(
      makeTask("17 * * * *"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({ now: () => localDate(2026, 7, 13, 10, 2, 37) }),
    );

    expect(startBoundary(xml)).toBe("2026-07-13T10:17:00");
    expect(xml).toContain("<Interval>PT1H</Interval>");
    expect(xml).toContain("<Duration>PT23H</Duration>");
    expect(xml).toContain("<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>");
  });

  test("non-divisor hour steps reset at midnight instead of drifting on later days", () => {
    const xml = buildSchtasksXml(
      makeTask("0 */5 * * *"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({ now: () => localDate(2026, 7, 13, 10, 2, 37) }),
    );

    expect(xml.match(/<CalendarTrigger>/g)).toHaveLength(5);
    expect(xml).not.toContain("<Repetition>");
    expect(startBoundaries(xml).map((boundary) => boundary.slice(11))).toEqual([
      "00:00:00",
      "05:00:00",
      "10:00:00",
      "15:00:00",
      "20:00:00",
    ]);
  });

  test("hour range-step renders every selected daily boundary", () => {
    const xml = buildSchtasksXml(
      makeTask("0 2-22/4 * * *"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({ now: () => localDate(2026, 7, 13, 10, 2, 37) }),
    );

    expect(xml.match(/<CalendarTrigger>/g)).toHaveLength(6);
    expect(startBoundaries(xml).map((boundary) => boundary.slice(11))).toEqual([
      "02:00:00",
      "06:00:00",
      "10:00:00",
      "14:00:00",
      "18:00:00",
      "22:00:00",
    ]);
  });

  test("daily at 09:30 -> CalendarTrigger ScheduleByDay", () => {
    const xml = buildSchtasksXml(makeTask("30 9 * * *"), ["C:/akm.exe"], "C:/log", xmlOptions());
    expect(xml).toContain("<CalendarTrigger>");
    expect(xml).toContain("<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>");
    expect(xml).toContain("T09:30:00");
  });

  test("weekly on Wed -> CalendarTrigger Wednesday", () => {
    const xml = buildSchtasksXml(makeTask("0 8 * * 3"), ["C:/akm.exe"], "C:/log", xmlOptions());
    expect(xml).toContain("<Wednesday />");
    expect(xml).toContain("T08:00:00");
  });

  test("disabled task encodes Enabled=false", () => {
    const t = makeTask("*/5 * * * *");
    const xml = buildSchtasksXml({ ...t, enabled: false }, ["C:/akm.exe"], "C:/log", xmlOptions());
    expect(xml).toContain("<Enabled>false</Enabled>");
  });

  test("valid double-hyphen IDs cannot create invalid XML comments", () => {
    const xml = buildSchtasksXml(
      makeTask("*/5 * * * *", "ping--nightly"),
      ["C:/Program Files/akm&tools/akm.exe", "C:\\bundle path\\cli.js"],
      "C:/logs&archive",
      xmlOptions(),
    );

    expect(xml).not.toContain("<!--");
    expect(xml).toContain("<Description>akm scheduled task: ping--nightly</Description>");
    expect(xml).toContain("<Command>powershell.exe</Command>");
    expect(xml).toContain("C:/Program Files/akm&amp;tools/akm.exe");
    expect(xml).toContain("C:\\bundle path\\cli.js");
    expect(xml).toContain("&apos;task&apos; &apos;run&apos; &apos;ping--nightly&apos; &apos;--scheduled&apos;");
    expect(xml).toContain("C:/logs&amp;archive/ping--nightly.log");
  });

  test("PowerShell quoting preserves a trailing backslash in an invocation argument", () => {
    const xml = buildSchtasksXml(makeTask("*/5 * * * *"), ["C:/akm.exe", "C:\\bundle path\\"], "C:/log", xmlOptions());

    expect(xml).toContain(String.raw`&apos;C:\bundle path\&apos;`);
  });

  test("minute repetition starts at the next matching cron minute", () => {
    const xml = buildSchtasksXml(
      makeTask("*/5 * * * *"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 10, 2, 37),
      }),
    );

    expect(startBoundary(xml)).toBe("2026-07-13T10:05:00");
  });

  test("hour repetition starts at the next matching cron hour", () => {
    const xml = buildSchtasksXml(
      makeTask("0 */3 * * *"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 10, 2, 37),
      }),
    );

    expect(startBoundary(xml)).toBe("2026-07-13T12:00:00");
    expect(xml).toContain("<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>");
    expect(xml).toContain("<Duration>PT21H</Duration>");
  });

  test("shipped hourly schedule starts at the next top of the hour", () => {
    const xml = buildSchtasksXml(
      makeTask("0 * * * *"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 10, 2, 37),
      }),
    );

    expect(startBoundary(xml)).toBe("2026-07-13T11:00:00");
  });

  test("daily trigger advances to tomorrow when today's boundary passed", () => {
    const xml = buildSchtasksXml(
      makeTask("30 9 * * *"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 10, 2, 37),
      }),
    );

    expect(startBoundary(xml)).toBe("2026-07-14T09:30:00");
  });

  test("weekly trigger starts on the next configured weekday", () => {
    const xml = buildSchtasksXml(
      makeTask("0 8 * * 3"),
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 10, 2, 37),
      }),
    );

    expect(startBoundary(xml)).toBe("2026-07-15T08:00:00");
  });

  test("definition signature is stable across installation times", () => {
    const task = makeTask("*/5 * * * *");
    const morning = buildSchtasksXml(
      task,
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 10, 2, 37),
      }),
    );
    const evening = buildSchtasksXml(
      task,
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 18, 44, 12),
      }),
    );

    expect(sourceSignature(morning)).toMatch(/^akm:v1:[0-9a-f]{64}$/);
    expect(sourceSignature(evening)).toBe(sourceSignature(morning));
  });

  test("UTF-16LE schtasks query output is decoded without retaining its BOM", () => {
    const xml = '<?xml version="1.0" encoding="UTF-16"?>\r\n<Task />\r\n';
    const output = Buffer.from(`\ufeff${xml}`, "utf16le");

    expect(decodeCommandOutput(output)).toBe(xml);
  });
});

describe("schtasks bundle attribution", () => {
  test("parses --bundle from the current descriptor-bearing invocation", () => {
    const task = makeTask("0 9 * * *");
    const targeted: SchedulerBinding = {
      ...task,
      logicalSource: { kind: "task", ref: "work//tasks/ping" },
      invocation: ["task", "run", "ping", "--bundle", "work", "--scheduled"],
    };
    const xml = buildSchtasksXml(targeted, ["C:\\Program Files\\O'Brien & Sons\\akm.exe"], "C:/log", xmlOptions());
    expect(extractSchtasksTarget(xml)).toBe("work");
  });

  // 0.9 scheduler ABI respelling (S6): an installed entry whose invocation no
  // longer parses is an orphan of its marker id, not a hard failure —
  // `list()` omits it so `akmTasksSync` treats the id as "not present" and
  // reinstalls it from the task file.
  test("omits a descriptor-less installed entry", () => {
    const xml = descriptorlessTargetXml();
    const backend = SCHTASKS_BACKEND({
      exec: {
        run(args) {
          if (args.includes("/FO")) return { status: 0, stdout: '"\\akm\\ping","N/A","Ready"\r\n', stderr: "" };
          if (args.includes("/XML")) return { status: 0, stdout: xml, stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        },
      },
      akmArgv: ["C:/current/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(extractSchtasksTarget(xml)).toBeUndefined();
    expect(backend.list()).toEqual([]);
    expect(backend.listNativeArtifacts?.()).toEqual([{ nativeId: "ping" }]);
  });
});

describe("schtasks backend signatures", () => {
  function queryExec(installedXml: string): SchtasksExec & { calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      run(args: string[]) {
        calls.push(args);
        if (args.join("\0") === ["schtasks", "/Query", "/FO", "CSV", "/NH"].join("\0")) {
          return { status: 0, stdout: '"\\akm\\ping","7/13/2026 10:05:00 AM","Ready"\r\n', stderr: "" };
        }
        if (args.join("\0") === ["schtasks", "/Query", "/TN", "\\akm\\ping", "/XML"].join("\0")) {
          return { status: 0, stdout: installedXml, stderr: "" };
        }
        throw new Error(`unexpected command: ${JSON.stringify(args)}`);
      },
    };
  }

  const listSync = (backend: ReturnType<typeof SCHTASKS_BACKEND>): InstalledTaskRef[] =>
    backend.list() as InstalledTaskRef[];

  test("list returns the installed signature expected for an unchanged task", () => {
    const task = makeTask("*/5 * * * *");
    const installedXml = buildSchtasksXml(
      task,
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 10, 2, 37),
      }),
    );
    const exec = queryExec(installedXml);
    const backend = SCHTASKS_BACKEND({
      exec,
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(listSync(backend)).toEqual([
      {
        id: "ping",
        signature: backend.expectedSignature?.(task),
        binding: ["C:/akm.exe"],
        contextPath: expect.any(String),
      },
    ]);
    expect(exec.calls).toEqual([
      ["schtasks", "/Query", "/FO", "CSV", "/NH"],
      ["schtasks", "/Query", "/TN", "\\akm\\ping", "/XML"],
    ]);
  });

  test("installed and expected signatures include enabled state", () => {
    const disabled = makeTask("*/5 * * * *", "ping", false);
    const installedXml = buildSchtasksXml(
      disabled,
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({
        now: () => localDate(2026, 7, 13, 10, 2, 37),
      }),
    );
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(installedXml),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    const installed = listSync(backend)[0]!.signature;
    expect(installed).toBe(backend.expectedSignature?.(disabled));
    expect(installed).not.toBe(backend.expectedSignature?.({ ...disabled, enabled: true }));
  });

  test("installed signatures do not trust a forged Source claim", () => {
    const task = makeTask("*/5 * * * *");
    const installedXml = buildSchtasksXml(task, ["C:/akm.exe"], "C:/log", xmlOptions()).replace(
      /<Source>[^<]+<\/Source>/,
      `<Source>akm:v1:${"0".repeat(64)}</Source>`,
    );
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(installedXml),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(listSync(backend)[0]!.signature).toBe(backend.expectedSignature?.(task));
  });

  test("installed signatures are available without a Source claim", () => {
    const task = makeTask("*/5 * * * *");
    const installedXml = buildSchtasksXml(task, ["C:/akm.exe"], "C:/log", xmlOptions()).replace(
      /\s*<Source>[^<]+<\/Source>/,
      "",
    );
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(installedXml),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(listSync(backend)[0]!.signature).toBe(backend.expectedSignature?.(task));
  });

  test("queried XML namespace prefixes and formatting do not change the signature", () => {
    const task = makeTask("*/5 * * * *");
    const installedXml = buildSchtasksXml(task, ["C:/akm.exe"], "C:/log", xmlOptions())
      .replace(/<(\/?)([A-Z][A-Za-z]*)(?=[\s/>])/g, "<$1ts:$2")
      .replace("<ts:Task ", '<ts:Task xmlns:ts="http://schemas.microsoft.com/windows/2004/02/mit/task" ')
      .replaceAll("\n", "\r\n\r\n");
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(installedXml),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(listSync(backend)[0]!.signature).toBe(backend.expectedSignature?.(task));
  });

  test("native materialized schema defaults do not create false drift", () => {
    const task = makeTask("*/5 * * * *");
    const installedXml = buildSchtasksXml(task, ["C:/akm.exe"], "C:/log", xmlOptions())
      .replace("      <RunLevel>LeastPrivilege</RunLevel>\n", "")
      .replace("      <Enabled>true</Enabled>\n      <ScheduleByDay>", "      <ScheduleByDay>")
      .replace(
        "  <Settings>",
        `  <Settings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>true</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <Hidden>false</Hidden>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT72H</ExecutionTimeLimit>
    <Priority>7</Priority>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>`,
      );
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(installedXml),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(listSync(backend)[0]!.signature).toBe(backend.expectedSignature?.(task));
  });

  test("installed signatures detect principal UserId drift", () => {
    const task = makeTask("*/5 * * * *");
    const installedXml = buildSchtasksXml(task, ["C:/akm.exe"], "C:/log", xmlOptions()).replace(
      `<UserId>${USER_SID}</UserId>`,
      "<UserId>S-1-5-21-9999-8888-7777-1002</UserId>",
    );
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(installedXml),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(listSync(backend)[0]!.signature).not.toBe(backend.expectedSignature?.(task));
  });

  test("installed signatures detect action, trigger, settings, and principal drift despite an unchanged Source", () => {
    const task = makeTask("*/5 * * * *");
    const installedXml = buildSchtasksXml(task, ["C:/akm.exe"], "C:/log", xmlOptions());
    const backendFor = (xml: string) =>
      SCHTASKS_BACKEND({
        exec: queryExec(xml),
        akmArgv: ["C:/akm.exe"],
        logDir: "C:/log",
        scheduledContext: SCHEDULED_CONTEXT,
        userSid: USER_SID,
      });
    const expected = backendFor(installedXml).expectedSignature?.(task);

    expect(listSync(backendFor(installedXml.replace("&apos;ping&apos;", "&apos;other&apos;")))[0]!.signature).not.toBe(
      expected,
    );
    expect(
      listSync(backendFor(installedXml.replace("<Interval>PT5M</Interval>", "<Interval>PT10M</Interval>")))[0]!
        .signature,
    ).not.toBe(expected);
    expect(
      listSync(
        backendFor(
          installedXml.replace(
            "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
            "<MultipleInstancesPolicy>Queue</MultipleInstancesPolicy>",
          ),
        ),
      )[0]!.signature,
    ).not.toBe(expected);
    expect(
      listSync(
        backendFor(
          installedXml.replace("<RunLevel>LeastPrivilege</RunLevel>", "<RunLevel>HighestAvailable</RunLevel>"),
        ),
      )[0]!.signature,
    ).not.toBe(expected);
  });

  test("changing a materialized settings default remains detectable drift", () => {
    const task = makeTask("*/5 * * * *");
    const installedXml = buildSchtasksXml(task, ["C:/akm.exe"], "C:/log", xmlOptions()).replace(
      "  <Settings>",
      "  <Settings>\n    <AllowStartOnDemand>false</AllowStartOnDemand>",
    );
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(installedXml),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(listSync(backend)[0]!.signature).not.toBe(backend.expectedSignature?.(task));
  });

  test("signature canonicalization ignores only the dynamic boundary cycle", () => {
    const task = makeTask("17 * * * *");
    const installedXml = buildSchtasksXml(
      task,
      ["C:/akm.exe"],
      "C:/log",
      xmlOptions({ now: () => localDate(2026, 7, 13, 10, 2, 37) }),
    )
      .replace(/\s*<Source>[^<]+<\/Source>/, "")
      .replace("2026-07-13T10:17:00", "2031-11-04T22:17:00");
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(installedXml),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(listSync(backend)[0]!.signature).toBe(backend.expectedSignature?.(task));

    const wrongPhase = installedXml.replace("2031-11-04T22:17:00", "2031-11-04T22:18:00");
    const wrongBackend = SCHTASKS_BACKEND({
      exec: queryExec(wrongPhase),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });
    expect(listSync(wrongBackend)[0]!.signature).not.toBe(wrongBackend.expectedSignature?.(task));
  });

  test("expected signature changes when the schedule changes", () => {
    const task = makeTask("*/5 * * * *");
    const backend = SCHTASKS_BACKEND({
      exec: queryExec(""),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(backend.expectedSignature?.(task)).not.toBe(backend.expectedSignature?.({ ...task, cron: "0 */3 * * *" }));
  });

  test("expected signature changes when the resolved AKM context changes", () => {
    const original = SCHTASKS_BACKEND({
      exec: queryExec(""),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });
    const moved = SCHTASKS_BACKEND({
      exec: queryExec(""),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: { ...SCHEDULED_CONTEXT, AKM_DATA_DIR: "D:\\akm moved data" },
      userSid: USER_SID,
    });
    const task = makeTask("*/5 * * * *");

    expect(original.expectedSignature?.(task)).not.toBe(moved.expectedSignature?.(task));
  });

  test("a failed bulk query is surfaced instead of being treated as an empty scheduler", () => {
    const backend = SCHTASKS_BACKEND({
      exec: {
        run: () => ({ status: 5, stdout: "", stderr: "ERROR: Access is denied." }),
      },
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(() => backend.list()).toThrow("schtasks /Query failed (exit 5): ERROR: Access is denied");
  });

  test("a failed per-task XML query is surfaced instead of being treated as drift", () => {
    const backend = SCHTASKS_BACKEND({
      exec: {
        run(args) {
          if (args.includes("/XML")) return { status: 5, stdout: "", stderr: "ERROR: Access is denied." };
          return { status: 0, stdout: '"\\akm\\ping","N/A","Ready"\r\n', stderr: "" };
        },
      },
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(() => backend.list()).toThrow('schtasks /Query /XML for "\\akm\\ping" failed (exit 5)');
  });

  test("resolves the current user SID through the exec seam when one is not injected", () => {
    const calls: string[][] = [];
    const resolved = SCHTASKS_BACKEND({
      exec: {
        run(args) {
          calls.push(args);
          if (args.join("\0") === ["whoami", "/user", "/fo", "csv", "/nh"].join("\0")) {
            return { status: 0, stdout: `"DESKTOP\\user","${USER_SID}"\r\n`, stderr: "" };
          }
          throw new Error(`unexpected command: ${JSON.stringify(args)}`);
        },
      },
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
    });
    const injected = SCHTASKS_BACKEND({
      exec: queryExec(""),
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(resolved.expectedSignature?.(makeTask("0 9 * * *"))).toBe(
      injected.expectedSignature?.(makeTask("0 9 * * *")),
    );
    expect(calls).toEqual([["whoami", "/user", "/fo", "csv", "/nh"]]);
  });
});

describe("schtasks backend install validation", () => {
  test("rejects excessive trigger expansion before filesystem or schtasks work", () => {
    const execCalls: string[][] = [];
    const fsCalls: string[] = [];
    const exec: SchtasksExec = {
      run(args) {
        execCalls.push(args);
        return { status: 0, stdout: "", stderr: "" };
      },
    };
    const fs: SchtasksFs = {
      writeFile(file) {
        fsCalls.push(`write:${file}`);
      },
      removeFile(file) {
        fsCalls.push(`remove:${file}`);
      },
      tmpdir() {
        fsCalls.push("tmpdir");
        return "C:/tmp";
      },
      ensureDir(dir) {
        fsCalls.push(`ensure:${dir}`);
      },
    };
    const backend = SCHTASKS_BACKEND({
      exec,
      fs,
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(() => backend.install(makeTask("1-59/1 * * * *"))).toThrow(
      "requires 59 native triggers; Windows Task Scheduler allows at most 48",
    );
    expect(execCalls).toEqual([]);
    expect(fsCalls).toEqual([]);
  });

  test("log-directory creation failure aborts before XML or scheduler mutation", () => {
    const execCalls: string[][] = [];
    const fsCalls: string[] = [];
    const backend = SCHTASKS_BACKEND({
      exec: {
        run(args) {
          execCalls.push(args);
          return { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." };
        },
      },
      fs: {
        ensureDir() {
          throw new Error("injected log directory failure");
        },
        writeFile(file) {
          fsCalls.push(`write:${file}`);
        },
        removeFile(file) {
          fsCalls.push(`remove:${file}`);
        },
        tmpdir() {
          fsCalls.push("tmpdir");
          return "C:/tmp";
        },
      },
      akmArgv: ["C:/akm.exe"],
      logDir: "C:/log",
      scheduledContext: SCHEDULED_CONTEXT,
      userSid: USER_SID,
    });

    expect(() => backend.install(makeTask("0 9 * * *"))).toThrow("injected log directory failure");
    expect(execCalls).toEqual([["schtasks", "/Query", "/TN", "\\akm\\ping", "/XML"]]);
    expect(fsCalls).toEqual([]);
  });
});

describe("schtasks backend transactional install", () => {
  function transactionBackend() {
    const files = new Map<string, string>();
    let installedXml: string | undefined;
    let installedTaskName: string | undefined;
    let queriedXml: string | undefined;
    let enabled = true;
    let failNextOperation: "create" | "disable" | undefined;
    let swapAfterTempWrite: string | undefined;
    const calls: string[][] = [];
    const fs: SchtasksFs = {
      writeFile(file, content) {
        files.set(file, content);
        if (swapAfterTempWrite !== undefined) {
          installedXml = swapAfterTempWrite;
          swapAfterTempWrite = undefined;
        }
      },
      removeFile(file) {
        files.delete(file);
      },
      tmpdir: () => "C:/tmp",
      ensureDir() {},
    };
    const exec: SchtasksExec = {
      run(args) {
        calls.push(args);
        const operation = args[1]?.toLowerCase();
        if (operation === "/query" && args.includes("/XML")) {
          return installedXml === undefined
            ? { status: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." }
            : { status: 0, stdout: queriedXml ?? installedXml, stderr: "" };
        }
        if (operation === "/query") {
          return {
            status: 0,
            stdout: installedTaskName ? `"${installedTaskName}","N/A","Ready"\r\n` : "",
            stderr: "",
          };
        }
        if (operation === "/create") {
          const xmlPath = args[args.indexOf("/XML") + 1];
          installedXml = files.get(xmlPath!);
          installedTaskName = args[args.indexOf("/TN") + 1];
          enabled = installedXml?.match(/<Settings>[\s\S]*?<Enabled>(true|false)<\/Enabled>/)?.[1] !== "false";
          if (failNextOperation === "create") {
            failNextOperation = undefined;
            return { status: 1, stdout: "", stderr: "injected create failure" };
          }
          return { status: 0, stdout: "", stderr: "" };
        }
        if (operation === "/change") {
          enabled = args.includes("/ENABLE");
          if (installedXml !== undefined) {
            installedXml = installedXml.replace(
              /(<Settings>[\s\S]*?<Enabled>)(?:true|false)(<\/Enabled>)/,
              `$1${enabled}$2`,
            );
          }
          if (args.includes("/DISABLE") && failNextOperation === "disable") {
            failNextOperation = undefined;
            return { status: 1, stdout: "", stderr: "injected disable failure" };
          }
          return { status: 0, stdout: "", stderr: "" };
        }
        if (operation === "/delete") {
          installedXml = undefined;
          installedTaskName = undefined;
          return { status: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected command: ${JSON.stringify(args)}`);
      },
    };
    return {
      backend: SCHTASKS_BACKEND({
        exec,
        fs,
        akmArgv: ["C:/akm.exe"],
        logDir: "C:/log",
        scheduledContext: SCHEDULED_CONTEXT,
        userSid: USER_SID,
      }),
      calls,
      installedXml: () => installedXml,
      replaceInstalledXml(xml: string) {
        installedXml = xml;
        queriedXml = undefined;
      },
      enabled: () => enabled,
      setQueriedXml(xml: string) {
        queriedXml = xml;
      },
      swapOwnerAfterNextTempWrite(xml: string) {
        swapAfterTempWrite = xml;
      },
      failNext(operation: "create" | "disable") {
        failNextOperation = operation;
      },
    };
  }

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

  test("direct create CAS rejects a Task Scheduler artifact that appeared after frozen absence", () => {
    const transaction = transactionBackend();
    const owned = qualifiedTask("0 9 * * *");
    transaction.backend.install(owned);
    const prior = transaction.installedXml();

    expect(() =>
      (transaction.backend.install as (...args: unknown[]) => void)(
        { ...owned, cron: "30 10 * * *" },
        undefined,
        mutationExpectation(owned, "absent"),
      ),
    ).toThrow(/changed|absence|exists|compare|owner/i);
    expect(transaction.installedXml()).toBe(prior);
  });

  test("direct update CAS rejects same-owner XML drift after planning", () => {
    const transaction = transactionBackend();
    const owned = qualifiedTask("0 9 * * *");
    transaction.backend.install(owned);
    const artifact = (transaction.backend.listNativeArtifacts?.() as Array<{ fingerprint?: string }>)[0];
    const installed = transaction.installedXml();
    if (!installed) throw new Error("missing installed XML");
    transaction.replaceInstalledXml(installed.replace("T09:00:00", "T08:00:00"));
    const drifted = transaction.installedXml();

    expect(() =>
      (transaction.backend.install as (...args: unknown[]) => void)(
        { ...owned, cron: "30 10 * * *" },
        undefined,
        mutationExpectation(owned, "present", artifact?.fingerprint),
      ),
    ).toThrow(/changed|fingerprint|compare/i);
    expect(transaction.installedXml()).toBe(drifted);
  });

  test("rejects a forged expected Task Scheduler source before scheduler access", () => {
    const transaction = transactionBackend();
    const owned = qualifiedTask("0 9 * * *");
    const forged = {
      ...mutationExpectation(owned, "absent"),
      logicalSource: { kind: "task", ref: "other//tasks/ping" },
      invocation: ["task", "run", "ping", "--bundle", "other", "--scheduled"],
    };

    expect(() => (transaction.backend.install as (...args: unknown[]) => void)(owned, undefined, forged)).toThrow(
      /expectation|identity|binding|source/i,
    );
    expect(transaction.calls).toEqual([]);
    expect(transaction.installedXml()).toBeUndefined();
  });

  test("round-trips and updates a higher-ordinal binding whose public owner is the base task", () => {
    const transaction = transactionBackend();
    const binding = higherOrdinal();

    transaction.backend.install(binding);
    expect(transaction.backend.list()).toEqual([
      expect.objectContaining({
        id: binding.id,
        nativeId: schedulerNativeBindingId(binding.id),
        invocation: binding.invocation,
      }),
    ]);
    expect(transaction.backend.listNativeArtifacts?.()).toEqual([
      {
        nativeId: schedulerNativeBindingId(binding.id),
        bindingId: binding.id,
        invocation: binding.invocation,
      },
    ]);

    expect(() => transaction.backend.install(binding)).not.toThrow();
    const drifted = { ...binding, cron: "30 2 * * *" };
    expect(() => transaction.backend.install(drifted)).not.toThrow();
    expect((transaction.backend.list() as Array<{ signature?: string }>)[0]!.signature).toBe(
      transaction.backend.expectedSignature?.(drifted),
    );
  });

  test.each([
    "foreign",
    "malformed",
    "fingerprint",
  ] as const)("rechecks a higher-ordinal %s owner and fingerprint immediately before uninstall", (replacement) => {
    const transaction = transactionBackend();
    const binding = higherOrdinal();
    transaction.backend.install(binding);
    const nativeId = schedulerNativeBindingId(binding.id);
    const expected = {
      bindingId: binding.id,
      nativeId,
      logicalSource: binding.logicalSource,
      ordinal: binding.ordinal,
      invocation: binding.invocation,
      fingerprint: transaction.backend.expectedSignature?.(binding),
    };
    const prior = transaction.installedXml();
    if (!prior) throw new Error("missing installed XML");
    const swapped =
      replacement === "foreign"
        ? prior.replaceAll("&apos;ping&apos;", "&apos;foreign&apos;")
        : replacement === "malformed"
          ? prior.replaceAll("&apos;--scheduled&apos;", "&apos;--broken&apos;")
          : prior.replace("<DaysInterval>1</DaysInterval>", "<DaysInterval>2</DaysInterval>");
    expect(swapped).not.toBe(prior);
    transaction.replaceInstalledXml(swapped);
    const priorCallCount = transaction.calls.length;

    const uninstall = transaction.backend.uninstall as unknown as (id: string, expectation: typeof expected) => void;
    expect(() => uninstall(nativeId, expected)).toThrow(/changed|owner|malformed|refusing/i);
    expect(transaction.installedXml()).toBe(swapped);
    expect(transaction.calls.slice(priorCallCount).some((call) => call[1]?.toLowerCase() === "/delete")).toBe(false);
  });

  test("restores prior queried XML and disabled state when /Create /F fails after replacing it", () => {
    const transaction = transactionBackend();
    transaction.backend.install(makeTask("0 9 * * *", "ping", false));
    const priorXml = transaction.installedXml();
    transaction.failNext("create");

    expect(() => transaction.backend.install(makeTask("30 10 * * *", "ping", true))).toThrow("injected create failure");

    expect(transaction.installedXml()).toBe(priorXml);
    expect(transaction.enabled()).toBe(false);
  });

  test("restores prior queried XML and enabled state when post-create disable fails", () => {
    const transaction = transactionBackend();
    transaction.backend.install(makeTask("0 9 * * *", "ping", true));
    const priorXml = transaction.installedXml();
    transaction.failNext("disable");

    expect(() => transaction.backend.install(makeTask("30 10 * * *", "ping", false))).toThrow(
      "injected disable failure",
    );

    expect(transaction.installedXml()).toBe(priorXml);
    expect(transaction.enabled()).toBe(true);
  });

  test("rollback rewrites a queried UTF-8 declaration to match the UTF-16 temp file", () => {
    const transaction = transactionBackend();
    transaction.backend.install(makeTask("0 9 * * *", "ping", true));
    const priorXml = transaction.installedXml();
    if (!priorXml) throw new Error("missing installed XML");
    transaction.setQueriedXml(priorXml.replace('encoding="UTF-16"', 'encoding="UTF-8"'));
    transaction.failNext("create");

    expect(() => transaction.backend.install(makeTask("30 10 * * *", "ping", true))).toThrow("injected create failure");

    expect(transaction.installedXml()).toBe(priorXml);
    expect(transaction.installedXml()).toContain('encoding="UTF-16"');
    expect(transaction.installedXml()).not.toContain('encoding="UTF-8"');
  });

  test("binding snapshots restore the queried XML and enabled state exactly", () => {
    const transaction = transactionBackend();
    transaction.backend.install(makeTask("0 9 * * *", "ping", false));
    const priorXml = transaction.installedXml();
    const snapshot = transaction.backend.snapshotBindings?.(["ping"]);

    transaction.backend.install(makeTask("30 10 * * *", "ping", true));
    transaction.backend.restoreBindings?.(snapshot);

    expect(transaction.installedXml()).toBe(priorXml);
    expect(transaction.enabled()).toBe(false);
  });

  test("snapshot rollback CAS never clobbers a concurrent same-name XML edit", () => {
    const transaction = transactionBackend();
    const owned = qualifiedTask("0 9 * * *");
    const snapshot = transaction.backend.snapshotBindings?.(["ping"]);
    transaction.backend.install(owned);
    const installed = transaction.installedXml();
    if (!installed) throw new Error("missing installed XML");
    const concurrent = installed.replace("T09:00:00", "T07:00:00");
    transaction.replaceInstalledXml(concurrent);
    transaction.calls.length = 0;
    const restore = transaction.backend.restoreBindings as unknown as (
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
              fingerprint: transaction.backend.expectedSignature?.(owned),
            },
          ],
        },
      ]),
    ).toThrow(/restore|rollback|changed|concurrent|fingerprint/i);
    expect(transaction.installedXml()).toBe(concurrent);
    expect(transaction.calls.some((call) => call[1]?.toLowerCase() === "/delete")).toBe(false);
  });

  test("uses a portable native name while preserving a nested logical invocation", () => {
    const transaction = transactionBackend();
    const nested = {
      ...makeTask("0 9 * * *", "sub/deep/nightly"),
      logicalSource: { kind: "task" as const, ref: "team//sub/deep/nightly" },
      invocation: ["task", "run", "sub/deep/nightly", "--bundle", "team", "--scheduled"],
    };

    transaction.backend.install(nested);

    const create = transaction.calls.find((call) => call[1]?.toLowerCase() === "/create");
    const taskName = create?.[create.indexOf("/TN") + 1] ?? "";
    expect(taskName.slice("\\akm\\".length)).not.toContain("/");
    expect(transaction.installedXml()).toContain("&apos;sub/deep/nightly&apos;");
    expect(transaction.installedXml()).not.toContain("<URI>\\akm\\sub/deep/nightly</URI>");

    const colliding = {
      ...makeTask("0 9 * * *", "task-b0117b892c35999ceb4d5386f8609932"),
      logicalSource: { kind: "task" as const, ref: "team//task-b0117b892c35999ceb4d5386f8609932" },
      invocation: ["task", "run", "task-b0117b892c35999ceb4d5386f8609932", "--bundle", "team", "--scheduled"],
    };
    expect(() => transaction.backend.install(colliding)).toThrow(/native scheduler artifact|different logical owner/i);
    expect(transaction.installedXml()).toContain("&apos;sub/deep/nightly&apos;");
  });

  test("rechecks the exact task owner after the temp XML write and before /Create /F", () => {
    const transaction = transactionBackend();
    const nested = {
      ...makeTask("0 9 * * *", "sub/deep/nightly"),
      logicalSource: { kind: "task" as const, ref: "team//sub/deep/nightly" },
      invocation: ["task", "run", "sub/deep/nightly", "--bundle", "team", "--scheduled"],
    };
    transaction.backend.install(nested);
    const prior = transaction.installedXml();
    if (!prior) throw new Error("missing installed XML");
    transaction.swapOwnerAfterNextTempWrite(prior.replaceAll("sub/deep/nightly", "other-owner"));
    const priorCallCount = transaction.calls.length;

    expect(() => transaction.backend.install({ ...nested, cron: "30 10 * * *" })).toThrow(/changed.*refusing/i);
    expect(transaction.calls.slice(priorCallCount).some((call) => call[1]?.toLowerCase() === "/create")).toBe(false);
  });
});
