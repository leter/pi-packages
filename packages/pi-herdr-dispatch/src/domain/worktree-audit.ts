import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeSnapshot {
  fingerprint: string;
  entries: readonly string[];
  diffStat: string;
}

export async function captureWorktreeSnapshot(worktreePath: string): Promise<WorktreeSnapshot> {
  const options = { encoding: "utf8" as const, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 };
  const [{ stdout }, unstaged, staged] = await Promise.all([
    execFileAsync(
      "git",
      ["-C", worktreePath, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      options,
    ),
    execFileAsync("git", ["-C", worktreePath, "diff", "--stat", "--no-ext-diff"], options),
    execFileAsync("git", ["-C", worktreePath, "diff", "--cached", "--stat", "--no-ext-diff"], options),
  ]);
  const entries = Object.freeze(
    stdout
      .split("\u0000")
      .filter(Boolean)
      .map((entry) => entry.replace(/[\u0001-\u001f\u007f-\u009f]/gu, "�"))
      .sort(),
  );
  const diffStat = `${unstaged.stdout}${staged.stdout}`
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "�")
    .slice(0, 20_000)
    .trim();
  return {
    fingerprint: createHash("sha256").update(entries.join("\u0000"), "utf8").digest("hex"),
    entries,
    diffStat,
  };
}
