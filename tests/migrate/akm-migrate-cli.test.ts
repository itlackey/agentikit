// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, spyOn, test } from "bun:test";
import { main } from "../../scripts/akm-migrate";

describe("akm-migrate CLI", () => {
  test.each(["--help", "-h", "help"])("%s prints standalone usage", async (flag) => {
    const log = spyOn(console, "log").mockImplementation(() => {});

    await main([flag]);

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("Usage: akm-migrate <command> [options]");
  });
});
