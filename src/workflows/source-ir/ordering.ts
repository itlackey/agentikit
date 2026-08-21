// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

export type CanonicalTopologicalJobsResult<T> =
  | { ok: true; jobs: T[] }
  | { ok: false; kind: "missing"; job: T; dependency: string }
  | { ok: false; kind: "cycle"; job: T };

/** The one canonical job ordering: emit one lexical ready job, then recompute readiness. */
export function canonicalTopologicalJobs<T extends { id: string; needs: readonly string[] }>(
  jobs: readonly T[],
): CanonicalTopologicalJobsResult<T> {
  const byId = new Map(jobs.map((job) => [job.id, job]));
  for (const job of jobs) {
    for (const dependency of job.needs) {
      if (!byId.has(dependency)) {
        return { ok: false, kind: "missing", job, dependency };
      }
    }
  }

  const ordered: T[] = [];
  const emitted = new Set<string>();
  while (ordered.length < jobs.length) {
    const ready = jobs
      .filter((job) => !emitted.has(job.id) && job.needs.every((need) => emitted.has(need)))
      .sort((left, right) => compareCodePoints(left.id, right.id))[0];
    if (!ready) {
      const cyclic = jobs
        .filter((job) => !emitted.has(job.id))
        .sort((left, right) => compareCodePoints(left.id, right.id))[0];
      if (!cyclic) throw new Error("Dependency ordering stalled without a remaining job.");
      return { ok: false, kind: "cycle", job: cyclic };
    }
    ordered.push(ready);
    emitted.add(ready.id);
  }
  return { ok: true, jobs: ordered };
}

export function compareWorkflowSourceCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCodePoints(left: string, right: string): number {
  return compareWorkflowSourceCodePoints(left, right);
}
