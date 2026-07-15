import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { resolveCanonicalWorktree } from "../../src/domain/worktree.js";

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

  it("rejects a write target outside a Git worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-herdr-worktree-"));
    roots.push(root);

    await expect(resolveCanonicalWorktree(root)).rejects.toThrow("not a readable Git worktree");
  });
});
