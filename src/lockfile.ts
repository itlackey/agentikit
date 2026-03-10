import fs from "node:fs";
import path from "node:path";
import { getConfigDir } from "./config";
import type { RegistrySource } from "./registry-types";

// ── Types ───────────────────────────────────────────────────────────────────

export interface LockfileEntry {
  id: string;
  source: RegistrySource;
  ref: string;
  resolvedVersion?: string;
  resolvedRevision?: string;
  integrity?: string;
}

// ── Paths ───────────────────────────────────────────────────────────────────

function getLockfilePath(): string {
  return path.join(getConfigDir(), "stash.lock");
}

// ── Read / Write ────────────────────────────────────────────────────────────

export function readLockfile(): LockfileEntry[] {
  const lockfilePath = getLockfilePath();
  try {
    const raw = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(isValidLockfileEntry);
  } catch {
    return [];
  }
}

export function writeLockfile(entries: LockfileEntry[]): void {
  const lockfilePath = getLockfilePath();
  const dir = path.dirname(lockfilePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = lockfilePath + `.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(entries, null, 2) + "\n", "utf8");
    fs.renameSync(tmpPath, lockfilePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

export function upsertLockEntry(entry: LockfileEntry): void {
  const entries = readLockfile();
  const withoutExisting = entries.filter((e) => e.id !== entry.id);
  writeLockfile([...withoutExisting, entry]);
}

export function removeLockEntry(id: string): void {
  const entries = readLockfile();
  writeLockfile(entries.filter((e) => e.id !== id));
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isValidLockfileEntry(value: unknown): value is LockfileEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    obj.id !== "" &&
    typeof obj.source === "string" &&
    ["npm", "github", "git", "local"].includes(obj.source) &&
    typeof obj.ref === "string" &&
    obj.ref !== ""
  );
}
