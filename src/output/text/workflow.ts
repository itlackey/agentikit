// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Output text formatters for all `akm workflow *` commands.

import {
  formatWorkflowCreatePlain,
  formatWorkflowListPlain,
  formatWorkflowPlanPlain,
  formatWorkflowResumePlain,
  formatWorkflowRunPlain,
  formatWorkflowStatusPlain,
} from "./helpers";
import type { TextFormatterEntry } from "./registry";

export const workflowFormatters: TextFormatterEntry[] = [
  { command: "workflow-status", handler: (r) => formatWorkflowStatusPlain(r) },
  { command: "workflow-list", handler: (r) => formatWorkflowListPlain(r) },
  { command: "workflow-create", handler: (r) => formatWorkflowCreatePlain(r) },
  { command: "workflow-resume", handler: (r) => formatWorkflowResumePlain(r) },
  { command: "workflow-abandon", handler: (r) => formatWorkflowStatusPlain(r) },
  { command: "workflow-run", handler: (r) => formatWorkflowRunPlain(r) },
  { command: "workflow-plan", handler: (r) => formatWorkflowPlanPlain(r) },
];
