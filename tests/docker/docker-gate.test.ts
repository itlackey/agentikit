// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, test } from "bun:test";
import { requireDockerGateCapabilities } from "./docker-gate";

describe("Docker gate capability preflight", () => {
  test("does nothing when the heavyweight gate was not requested", () => {
    expect(() =>
      requireDockerGateCapabilities({
        requested: false,
        dockerAvailable: false,
        bunAvailable: false,
      }),
    ).not.toThrow();
  });

  test("fails an explicitly requested gate when Docker is unavailable", () => {
    expect(() =>
      requireDockerGateCapabilities({
        requested: true,
        dockerAvailable: false,
        bunAvailable: true,
      }),
    ).toThrow("AKM_DOCKER_TESTS=1 requires an available Docker daemon");
  });

  test("fails an explicitly requested gate when Bun is unavailable", () => {
    expect(() =>
      requireDockerGateCapabilities({
        requested: true,
        dockerAvailable: true,
        bunAvailable: false,
      }),
    ).toThrow("AKM_DOCKER_TESTS=1 requires Bun on PATH");
  });

  test("accepts an explicitly requested gate when both capabilities are ready", () => {
    expect(() =>
      requireDockerGateCapabilities({
        requested: true,
        dockerAvailable: true,
        bunAvailable: true,
      }),
    ).not.toThrow();
  });
});
