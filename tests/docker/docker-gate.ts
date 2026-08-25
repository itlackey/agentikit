// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export interface DockerGateCapabilities {
  requested: boolean;
  dockerAvailable: boolean;
  bunAvailable: boolean;
}

/**
 * Keep an explicitly requested Docker gate from becoming a false-green skip.
 * Callers may still skip the heavyweight matrix when `requested` is false.
 */
export function requireDockerGateCapabilities(capabilities: DockerGateCapabilities): void {
  if (!capabilities.requested) return;

  if (!capabilities.dockerAvailable) {
    throw new Error("AKM_DOCKER_TESTS=1 requires an available Docker daemon (`docker info` failed)");
  }

  if (!capabilities.bunAvailable) {
    throw new Error("AKM_DOCKER_TESTS=1 requires Bun on PATH");
  }
}
