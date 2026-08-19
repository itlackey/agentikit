// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { WorkflowSourceIrV1, WorkflowSourceSpan } from "./schema";

export interface WorkflowSourceError {
  code: string;
  message: string;
  path: string;
  /** 1-indexed source line. */
  line: number;
}

export type WorkflowSourceCompileResult =
  | { ok: true; ir: WorkflowSourceIrV1 }
  | { ok: false; errors: WorkflowSourceError[] };

export class WorkflowSourceFailure extends Error {
  readonly error: WorkflowSourceError;

  constructor(code: string, message: string, source: WorkflowSourceSpan) {
    super(message);
    this.name = "WorkflowSourceFailure";
    this.error = { code, message, path: source.path, line: source.start };
  }
}

export function sourceFailureResult(cause: unknown, path: string): WorkflowSourceCompileResult {
  if (cause instanceof WorkflowSourceFailure) return { ok: false, errors: [cause.error] };
  return {
    ok: false,
    errors: [
      {
        code: "invalid-workflow-source",
        message: cause instanceof Error ? cause.message : String(cause),
        path,
        line: 1,
      },
    ],
  };
}
