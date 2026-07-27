// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output shape registration for `akm propose` (#226).
// Shares the proposal-producer envelope shape (success carries a proposal
// entry; failure carries an AgentFailureReason discriminant) with the
// internal `akmReflect` result shape — but `reflect` has no standalone CLI
// verb and no `output("reflect", ...)` call site (reflect.ts is called
// directly by the improve loop, not through this registry), so only
// `propose` is registered here.

import { shapeProposalProducerOutput } from "../helpers";
import type { OutputShapeEntry } from "../registry";

const handler = (result: unknown, detail: Parameters<typeof shapeProposalProducerOutput>[1]) =>
  shapeProposalProducerOutput(result as Record<string, unknown>, detail);

export const proposalProducerShapes: OutputShapeEntry[] = [{ command: "propose", handler }];
