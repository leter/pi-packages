import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const packageRoot = new URL("../../", import.meta.url);

describe("Pi package resources", () => {
  it("ships hd-crew from the package skill manifest", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("package.json", packageRoot), "utf8"),
    ) as { pi?: { extensions?: string[]; skills?: string[] } };
    const skill = await readFile(
      new URL("skills/hd-crew/SKILL.md", packageRoot),
      "utf8",
    );

    expect(manifest.pi).toEqual({
      extensions: ["./src/index.ts"],
      skills: ["./skills"],
    });
    expect(skill).toMatch(/^---\nname: hd-crew\ndescription: .+\n---\n/u);
    expect(skill).toContain("herdr_agents_list");
    expect(skill).toContain("herdr_dispatch_propose");
    expect(skill).toContain("exact `terminalId`");
    expect(skill).toContain("user TUI actions");
  });
});
