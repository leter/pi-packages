import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function resolveCanonicalWorktree(cwd: string): Promise<string> {
  if (!cwd) throw new TypeError("target cwd must not be empty");
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    }));
  } catch (error) {
    throw new Error(`write dispatch target is not a readable Git worktree: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  const root = stdout.trim();
  if (!root || root.includes("\n") || root.includes("\u0000")) {
    throw new Error("Git returned an invalid worktree path");
  }
  return realpath(root);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
