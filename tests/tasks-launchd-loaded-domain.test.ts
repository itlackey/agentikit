// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { parseLaunchdLoadedLabels } from "../src/tasks/backends/launchd";

describe("parseLaunchdLoadedLabels", () => {
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
  endpoints = {
    "com.akm.task.not-a-service" = {
      port = 0x123
    }
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

  test("rejects an AKM-looking token outside a recognized loaded-service shape", () => {
    expect(parseLaunchdLoadedLabels("gui/501 = {\n  note = com.akm.task.unproven\n}\n")).toBeUndefined();
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
});
