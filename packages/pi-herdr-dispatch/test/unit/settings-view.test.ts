import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_DISPATCH_CONFIG, type DispatchConfig } from "../../src/domain/config.js";
import { DEFAULT_TEAM_CATALOG, type TeamCatalog } from "../../src/domain/team.js";
import {
  SettingsViewComponent,
  type SettingsViewPorts,
} from "../../src/pi/settings-view.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function harness() {
  let config: DispatchConfig = { ...DEFAULT_DISPATCH_CONFIG };
  let team: TeamCatalog = DEFAULT_TEAM_CATALOG;
  const applyChange = vi.fn<SettingsViewPorts["applyChange"]>(async (change) => {
    if (change.kind === "config") config = { ...config, [change.key]: change.value };
    else {
      const role = team.roles[change.roleKey]!;
      team = {
        ...team,
        roles: { ...team.roles, [change.roleKey]: { ...role, agent: change.agent } },
      };
    }
    return { ok: true };
  });
  const done = vi.fn();
  const tui = { requestRender: vi.fn() };
  const ports: SettingsViewPorts = {
    getConfig: () => config,
    getTeam: () => team,
    applyChange,
    onStateChanged: () => () => undefined,
  };
  const component = new SettingsViewComponent(tui, theme, ports, done);
  return { component, applyChange, done };
}

describe("settings view component", () => {
  it("steps the focused setting, persists it, and re-reads the saved value", async () => {
    const { component, applyChange } = harness();

    component.handleInput("\x1b[C");

    await vi.waitFor(() => expect(applyChange).toHaveBeenCalledExactlyOnceWith({
      kind: "config",
      key: "defaultRunQuota",
      value: 11,
    }));
    expect(component.render(120).join("\n")).toContain("本次额度          11");
  });

  it("rolls back to the port value and shows one failure line", async () => {
    const { component, applyChange } = harness();
    applyChange.mockResolvedValueOnce({ ok: false, reason: "permission denied" });

    component.handleInput("\x1b[C");

    await vi.waitFor(() => {
      const rendered = component.render(120).join("\n");
      expect(rendered).toContain("本次额度          10");
      expect(rendered.match(/保存失败:permission denied/gu)).toHaveLength(1);
    });
  });

  it("cycles role agents, frames at 96 columns, and closes on escape", async () => {
    const { component, applyChange, done } = harness();
    for (let index = 0; index < 4; index += 1) component.handleInput("\x1b[B");
    component.handleInput("\x1b[C");

    await vi.waitFor(() => expect(applyChange).toHaveBeenCalledWith({
      kind: "role-agent",
      roleKey: "coder",
      agent: "opencode",
    }));
    const lines = component.render(160);
    expect(lines[0]).toContain("设置");
    expect(lines.at(-1)).toContain("↑↓ 选择 · ←→ 调整 · esc 关闭");
    for (const line of lines) expect(visibleWidth(line)).toBe(96);

    component.handleInput("\x1b");
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});
