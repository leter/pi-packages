import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { resolveCanonicalWorktree } from "../../src/domain/worktree.js";
import { captureWorktreeSnapshot } from "../../src/domain/worktree-audit.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("write worktree identity", () => {
  it("resolves nested target cwd to the canonical Git worktree root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-herdr-worktree-"));
    roots.push(root);
    await execFileAsync("git", ["init", "--quiet", root]);
    const nested = join(root, "packages", "one");
    await mkdir(nested, { recursive: true });

    await expect(resolveCanonicalWorktree(nested)).resolves.toBe(await realpath(root));
  });

  it("captures deterministic before/after status without attributing authorship", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-herdr-worktree-"));
    roots.push(root);
    await execFileAsync("git", ["init", "--quiet", root]);
    await writeFile(join(root, "tracked.txt"), "before\n", "utf8");
    await execFileAsync("git", ["-C", root, "add", "tracked.txt"]);
    await execFileAsync("git", [
      "-C",
      root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    const before = await captureWorktreeSnapshot(root);
    await writeFile(join(root, "tracked.txt"), "after\n", "utf8");
    await writeFile(join(root, "new.txt"), "change\n", "utf8");
    const after = await captureWorktreeSnapshot(root);

    expect(before.entries).toEqual([]);
    expect(after.entries).toEqual([" M tracked.txt", "?? new.txt"]);
    expect(after.diffStat).toContain("tracked.txt");
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("rejects a write target outside a Git worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-herdr-worktree-"));
    roots.push(root);

    await expect(resolveCanonicalWorktree(root)).rejects.toThrow("not a readable Git worktree");
  });
});
