import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeSnapshot {
  fingerprint: string;
  entries: readonly string[];
}

export async function captureWorktreeSnapshot(worktreePath: string): Promise<WorktreeSnapshot> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", worktreePath, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
  );
  const entries = Object.freeze(
    stdout
      .split("\u0000")
      .filter(Boolean)
      .map((entry) => entry.replace(/[\u0001-\u001f\u007f-\u009f]/gu, "�"))
      .sort(),
  );
  return {
    fingerprint: createHash("sha256").update(entries.join("\u0000"), "utf8").digest("hex"),
    entries,
  };
}
