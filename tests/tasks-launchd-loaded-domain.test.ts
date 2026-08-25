// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { parseLaunchdLoadedLabels } from "../src/tasks/backends/launchd";

describe("parseLaunchdLoadedLabels", () => {
  test("reads a real launchctl domain services table row with an idle status", () => {
    const output = `gui/501 = {
  services = {
    799  -  com.akm.task.ping
  }
}`;

    expect([...parseLaunchdLoadedLabels(output)!]).toEqual(["com.akm.task.ping"]);
  });

  test("accepts every valid PID and status spelling in a domain services table", () => {
    const output = `gui/501 = {
  services = {
    0  0  com.akm.task.zero
    -  0  com.akm.task.idle
    799  -  com.akm.task.running
    -  -  com.akm.task.dormant
    42  -9  com.akm.task.failed
  }
}`;

    expect([...parseLaunchdLoadedLabels(output)!]).toEqual([
      "com.akm.task.zero",
      "com.akm.task.idle",
      "com.akm.task.running",
      "com.akm.task.dormant",
      "com.akm.task.failed",
    ]);
  });

  test("reads only direct AKM services from a launchctl domain print envelope", () => {
    const output = `gui/501 = {
  type = login
  services = {
    123 = com.akm.task.ping
    "com.akm.task.second" = {
      active count = 1
    }
    99 = com.apple.WindowServer
  }
}`;

    expect([...parseLaunchdLoadedLabels(output)!]).toEqual(["com.akm.task.ping", "com.akm.task.second"]);
  });

  test("reads launchctl list rows while filtering unrelated jobs", () => {
    const output = `PID\tStatus\tLabel
123\t0\tcom.akm.task.ping
-\t0\tcom.akm.task.ping.
999\t0\tcom.apple.WindowServer
`;

    expect([...parseLaunchdLoadedLabels(output)!]).toEqual(["com.akm.task.ping", "com.akm.task.ping."]);
  });

  test("rejects a duplicate AKM label occurrence in launchctl list output", () => {
    const output = `PID Status Label
123 0 com.akm.task.ping
- 0 com.akm.task.ping
`;

    expect(parseLaunchdLoadedLabels(output)).toBeUndefined();
  });

  test.each([
    ["domain table", "gui/501 = {\n  services = {\n    123 0 com.akm.task.ping\n    - 0 com.akm.task.ping\n  }\n}\n"],
    [
      "domain dictionary",
      'gui/501 = {\n  services = {\n    "com.akm.task.ping" = {\n    }\n    "com.akm.task.ping" = {\n    }\n  }\n}\n',
    ],
  ])("rejects a duplicate AKM label occurrence in %s output", (_shape, output) => {
    expect(parseLaunchdLoadedLabels(output)).toBeUndefined();
  });

  test("does not apply domain-table status grammar to launchctl list output", () => {
    expect(parseLaunchdLoadedLabels("PID Status Label\n799 - com.akm.task.ping\n")).toBeUndefined();
    expect([...parseLaunchdLoadedLabels("PID Status Label\n- -9 com.akm.task.failed\n")!]).toEqual([
      "com.akm.task.failed",
    ]);
  });

  test("rejects an AKM-looking token outside a recognized loaded-service shape", () => {
    expect(parseLaunchdLoadedLabels("gui/501 = {\n  note = com.akm.task.unproven\n}\n")).toBeUndefined();
  });

  test("rejects a dictionary-shaped AKM label outside the single services block", () => {
    const output = `gui/501 = {
  services = {
    799 - com.akm.task.ping
  }
  endpoints = {
    "com.akm.task.not-a-service" = {
    }
  }
}`;

    expect(parseLaunchdLoadedLabels(output)).toBeUndefined();
  });

  test("rejects extra domain table columns and malformed services braces", () => {
    expect(
      parseLaunchdLoadedLabels("gui/501 = {\n  services = {\n    799 - com.akm.task.ping extra\n  }\n}\n"),
    ).toBeUndefined();
    expect(
      parseLaunchdLoadedLabels(
        'gui/501 = {\n  services = {\n    "com.akm.task.ping" = {\n      active count = 1\n  }\n',
      ),
    ).toBeUndefined();
  });

  test("rejects duplicate services blocks even when both use dictionary-shaped AKM labels", () => {
    const output = `gui/501 = {
  services = {
    "com.akm.task.ping" = {
    }
  }
  services = {
    "com.akm.task.PING" = {
    }
  }
}`;

    expect(parseLaunchdLoadedLabels(output)).toBeUndefined();
  });

  test("rejects nested services blocks and extra outer braces", () => {
    expect(parseLaunchdLoadedLabels("gui/501 = {\n  wrapper = {\n    services = {\n    }\n  }\n}\n")).toBeUndefined();
    expect(parseLaunchdLoadedLabels("gui/501 = {\n  services = {\n  }\n}\n}\n")).toBeUndefined();
    expect(parseLaunchdLoadedLabels("gui/501 = {\n  services = {\n  }\n}\ntrailing\n")).toBeUndefined();
  });

  test("rejects control characters anywhere in launchctl inventory output", () => {
    expect(
      parseLaunchdLoadedLabels("gui/501 = {\n  services = {\n    799 - com.akm.task.ping\n    note = \u0001\n  }\n}\n"),
    ).toBeUndefined();
  });

  test("fails closed when domain bytes or AKM namespace cardinality exceed their bounds", () => {
    expect(
      parseLaunchdLoadedLabels(`PID Status Label\n- 0 com.apple.${"x".repeat(4 * 1024 * 1024)}\n`),
    ).toBeUndefined();
    const excessive = Array.from({ length: 4097 }, (_, index) => `${index + 1} 0 com.akm.task.task-${index}`).join(
      "\n",
    );
    expect(parseLaunchdLoadedLabels(`PID Status Label\n${excessive}\n`)).toBeUndefined();
  });

  test("accepts exactly 4096 raw unique AKM entries and rejects a 4097th repeated entry", () => {
    const maximum = Array.from({ length: 4096 }, (_, index) => `${index + 1} 0 com.akm.task.task-${index}`).join("\n");
    expect(parseLaunchdLoadedLabels(`PID Status Label\n${maximum}\n`)?.size).toBe(4096);

    const repeatedOverflow = `${maximum}\n4097 0 com.akm.task.task-0`;
    expect(parseLaunchdLoadedLabels(`PID Status Label\n${repeatedOverflow}\n`)).toBeUndefined();
  });
});
