import fs from "node:fs";
import path from "node:path";
import { getLockfilePath } from "../../src/core/paths";
import type { LockfileEntry } from "../../src/integrations/lockfile";

/** Seed resolved bundle state for tests without exposing a production-only synchronous writer. */
export function seedLockEntries(entries: LockfileEntry[]): void {
  const lockfilePath = getLockfilePath();
  let existing: LockfileEntry[] = [];
  if (fs.existsSync(lockfilePath)) {
    const parsed: unknown = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
    if (!Array.isArray(parsed)) throw new Error(`Test lockfile is not an array: ${lockfilePath}`);
    existing = parsed as LockfileEntry[];
  }

  const incomingIds = new Set(entries.map((entry) => entry.id));
  const priorById = new Map(existing.map((entry) => [entry.id, entry]));
  const merged = entries.map((entry) => ({ ...priorById.get(entry.id), ...entry }));
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
  fs.writeFileSync(
    lockfilePath,
    `${JSON.stringify([...existing.filter((entry) => !incomingIds.has(entry.id)), ...merged], null, 2)}\n`,
    "utf8",
  );
}
