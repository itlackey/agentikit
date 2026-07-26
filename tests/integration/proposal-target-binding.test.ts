import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { akmProposalAccept, akmProposalCreate } from "../../src/commands/proposal/proposal";
import {
  createProposal,
  isProposalSkipped,
  listProposals,
  resolveProposalId,
} from "../../src/commands/proposal/repository";
import { type AkmConfig, resetConfigCache } from "../../src/core/config/config";
import { type IsolatedAkmStorage, withIsolatedAkmStorage, writeSandboxConfig } from "../_helpers/sandbox";

const VALID_LESSON = `---\ndescription: Proposal with a stable bound destination\nwhen_to_use: Testing proposal destinations\n---\n\nBound content.\n`;
const tempDirs: string[] = [];
let storage: IsolatedAkmStorage;

function stash(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "lessons"), { recursive: true });
  return root;
}

function namedStash(name: string): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "akm-proposal-named-"));
  tempDirs.push(parent);
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, "lessons"), { recursive: true });
  return root;
}

function config(primary: string, team: string, other?: string): AkmConfig {
  return {
    bundles: {
      primary: { path: primary, writable: true },
      team: { path: team, writable: true },
      ...(other ? { other: { path: other, writable: true } } : {}),
    } as AkmConfig["bundles"],
    defaultBundle: "primary",
    defaultWriteTarget: "primary",
  } as AkmConfig;
}

beforeEach(() => {
  storage = withIsolatedAkmStorage();
});

afterEach(() => {
  storage.cleanup();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("proposal queue target binding", () => {
  test("an unqualified ref in a named secondary queue uses and records the configured source identity", async () => {
    const primary = stash("akm-proposal-primary-");
    const team = stash("akm-proposal-directory-name-is-not-identity-");
    const cfg = config(primary, team);
    const { proposal: created } = akmProposalCreate({
      queue: "team",
      config: cfg,
      ref: "lessons/bound-secondary",
      source: "propose",
      payload: { content: VALID_LESSON },
    });

    expect(created.ref).toBe("team//lessons/bound-secondary");
    expect(created.proposedTarget).toEqual({ source: "team", root: path.resolve(team) });

    const accepted = await akmProposalAccept({ queue: "team", id: created.id, config: cfg });
    expect(accepted.assetPath).toBe(path.join(team, "lessons", "bound-secondary.md"));
    expect(fs.existsSync(path.join(primary, "lessons", "bound-secondary.md"))).toBe(false);
  });

  test("an unbound secondary-queue proposal does not fall through to a Git default bundle", async () => {
    const team = stash("akm-proposal-git-default-secondary-");
    const created = createProposal(team, {
      ref: "lessons/git-default-fallback",
      source: "propose",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    const cfg = {
      bundles: {
        remote: { git: "https://example.com/default.git", writable: true },
        team: { path: team, writable: true },
      } as AkmConfig["bundles"],
      defaultBundle: "remote",
    } as AkmConfig;

    const accepted = await akmProposalAccept({ queue: "team", id: created.id, config: cfg });
    expect(accepted.assetPath).toBe(path.join(team, "lessons", "git-default-fallback.md"));
    expect(fs.existsSync(accepted.assetPath)).toBe(true);
  });

  test("a qualified implicit queue remains bound when another target is the default", async () => {
    const team = stash("akm-proposal-implicit-default-team-");
    const cfg = {
      bundles: { team: { path: team, writable: true } } as AkmConfig["bundles"],
      defaultWriteTarget: "team",
    } as AkmConfig;
    writeSandboxConfig(cfg);

    const created = createProposal(storage.stashDir, {
      ref: "stash//lessons/implicit-bound",
      source: "propose",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    expect(created.proposedTarget).toEqual({ source: "stash", root: path.resolve(storage.stashDir) });

    const accepted = await akmProposalAccept({ stashDir: storage.stashDir, id: created.id, config: cfg });
    expect(accepted.assetPath).toBe(path.join(storage.stashDir, "lessons", "implicit-bound.md"));
    expect(fs.existsSync(path.join(team, "lessons", "implicit-bound.md"))).toBe(false);
  });

  test("a conflicting explicit target is rejected before a bound proposal writes", async () => {
    const primary = stash("akm-proposal-conflict-primary-");
    const team = stash("akm-proposal-conflict-team-");
    const other = stash("akm-proposal-conflict-other-");
    const cfg = config(primary, team, other);
    const created = createProposal(team, {
      ref: "lessons/target-conflict",
      source: "propose",
      force: true,
      target: { source: "team", root: team },
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");

    await expect(akmProposalAccept({ queue: "team", target: "other", id: created.id, config: cfg })).rejects.toThrow(
      /bound to target|resolves to/,
    );
    expect(fs.existsSync(path.join(team, "lessons", "target-conflict.md"))).toBe(false);
    expect(fs.existsSync(path.join(other, "lessons", "target-conflict.md"))).toBe(false);
  });

  test("a qualified proposal cannot bind its bundle identity to another queue root", () => {
    const primary = stash("akm-proposal-qualified-primary-");
    const team = stash("akm-proposal-qualified-team-");
    const cfg = config(primary, team);

    expect(() =>
      akmProposalCreate({
        queue: "primary",
        config: cfg,
        ref: "team//lessons/wrong-root",
        source: "propose",
        payload: { content: VALID_LESSON },
      }),
    ).toThrow(/conflicts with queue target/i);
    expect(fs.existsSync(path.join(primary, "lessons", "wrong-root.md"))).toBe(false);
    expect(fs.existsSync(path.join(team, "lessons", "wrong-root.md"))).toBe(false);
  });

  test("qualified filters preserve bundle identity while a short ref scopes to all duplicates in the queue", () => {
    const queue = stash("akm-proposal-duplicate-queue-");
    const team = createProposal(queue, {
      ref: "team//lessons/shared",
      source: "propose",
      force: true,
      target: { source: "team", root: queue },
      payload: { content: VALID_LESSON },
    });
    const other = createProposal(queue, {
      ref: "other//lessons/shared",
      source: "propose",
      force: true,
      target: { source: "other", root: queue },
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(team) || isProposalSkipped(other)) throw new Error("unexpected skip");

    expect(listProposals(queue, { ref: "lessons/shared" }).map((proposal) => proposal.id)).toEqual([team.id, other.id]);
    expect(listProposals(queue, { ref: "team//lessons/shared" }).map((proposal) => proposal.id)).toEqual([team.id]);
    expect(resolveProposalId(queue, "other//lessons/shared").id).toBe(other.id);
  });

  test("a legacy path-derived qualifier maps to the configured owner of the queue root", async () => {
    const primary = namedStash("physical");
    const team = stash("akm-proposal-alias-team-");
    const cfg = config(primary, team);
    writeSandboxConfig(cfg);
    resetConfigCache();

    const created = createProposal(primary, {
      ref: "physical//lessons/configured-owner",
      source: "propose",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    expect(created.ref).toBe("primary//lessons/configured-owner");
    expect(created.proposedTarget).toEqual({ source: "primary", root: path.resolve(primary) });

    const unqualified = createProposal(primary, {
      ref: "lessons/configured-default",
      source: "propose",
      force: true,
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(unqualified)) throw new Error("unexpected skip");
    expect(unqualified.ref).toBe("primary//lessons/configured-default");
    expect(unqualified.proposedTarget).toEqual({ source: "primary", root: path.resolve(primary) });

    const accepted = await akmProposalAccept({ stashDir: primary, id: created.id, config: cfg });
    expect(accepted.assetPath).toBe(path.join(primary, "lessons", "configured-owner.md"));
  });

  test("a legacy path alias that collides with another configured bundle cannot redirect the proposal", () => {
    const primary = namedStash("collision");
    const collisionTarget = stash("akm-proposal-collision-target-");
    const cfg = {
      bundles: {
        primary: { path: primary, writable: true },
        collision: { path: collisionTarget, writable: true },
      } as AkmConfig["bundles"],
      defaultBundle: "primary",
      defaultWriteTarget: "primary",
    } as AkmConfig;
    writeSandboxConfig(cfg);
    resetConfigCache();

    expect(() =>
      createProposal(primary, {
        ref: "collision//lessons/no-redirect",
        source: "propose",
        force: true,
        payload: { content: VALID_LESSON },
      }),
    ).toThrow(/legacy path alias.*configured bundle.*refusing to redirect/i);
    expect(fs.existsSync(path.join(collisionTarget, "lessons", "no-redirect.md"))).toBe(false);
  });

  test("accept rejects a target changed after the proposal captured its before hash", async () => {
    const primary = stash("akm-proposal-stale-primary-");
    const team = stash("akm-proposal-stale-team-");
    const cfg = config(primary, team);
    const assetPath = path.join(team, "lessons", "stale-target.md");
    fs.writeFileSync(assetPath, VALID_LESSON.replace("Bound content.", "Original content."), "utf8");
    const created = createProposal(team, {
      ref: "team//lessons/stale-target",
      source: "propose",
      force: true,
      target: { source: "team", root: team },
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    fs.writeFileSync(assetPath, VALID_LESSON.replace("Bound content.", "Newer user content."), "utf8");

    await expect(akmProposalAccept({ queue: "team", id: created.id, config: cfg })).rejects.toThrow(
      /changed after proposal/i,
    );
    expect(fs.readFileSync(assetPath, "utf8")).toContain("Newer user content.");
  });

  test("accept rejects a file created after a bound create proposal", async () => {
    const primary = stash("akm-proposal-created-primary-");
    const team = stash("akm-proposal-created-team-");
    const cfg = config(primary, team);
    const assetPath = path.join(team, "lessons", "created-later.md");
    const created = createProposal(team, {
      ref: "team//lessons/created-later",
      source: "propose",
      force: true,
      target: { source: "team", root: team },
      payload: { content: VALID_LESSON },
    });
    if (isProposalSkipped(created)) throw new Error("unexpected skip");
    fs.writeFileSync(assetPath, VALID_LESSON.replace("Bound content.", "User-created content."), "utf8");

    await expect(akmProposalAccept({ queue: "team", id: created.id, config: cfg })).rejects.toThrow(
      /created after proposal/i,
    );
    expect(fs.readFileSync(assetPath, "utf8")).toContain("User-created content.");
  });
});
