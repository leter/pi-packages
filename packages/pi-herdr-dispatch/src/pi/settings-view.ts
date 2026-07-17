import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

import type { DispatchConfig } from "../domain/config.js";
import type { TeamCatalog } from "../domain/team.js";
import {
  buildSettingsLines,
  buildSettingsState,
  cycleAgent,
  moveCursor,
  stepNumeric,
  type SettingChange,
  type SettingsViewState,
} from "./settings-view-model.js";
import { sanitizeLine } from "./visual.js";
import { UI_COPY } from "./ui-copy.js";

export interface SettingsViewPorts {
  getConfig(): DispatchConfig;
  getTeam(): TeamCatalog;
  applyChange(
    change: SettingChange,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  onStateChanged(listener: () => void): () => void;
}

const PANEL_MAX_WIDTH = 96;

export function openSettingsView(
  ui: Pick<ExtensionUIContext, "custom">,
  ports: SettingsViewPorts,
): Promise<void> {
  return ui.custom<void>(
    (tui, theme, _keybindings, done) => new SettingsViewComponent(tui, theme, ports, done),
  );
}

export class SettingsViewComponent implements Component {
  readonly #tui: Pick<TUI, "requestRender">;
  readonly #theme: Theme;
  readonly #ports: SettingsViewPorts;
  readonly #done: (result: undefined) => void;
  readonly #unsubscribe: () => void;
  #state: SettingsViewState;
  #failure?: string;
  #saving = false;
  #finished = false;

  constructor(
    tui: Pick<TUI, "requestRender">,
    theme: Theme,
    ports: SettingsViewPorts,
    done: (result: undefined) => void,
  ) {
    this.#tui = tui;
    this.#theme = theme;
    this.#ports = ports;
    this.#done = done;
    this.#state = buildSettingsState(ports.getConfig(), ports.getTeam());
    this.#unsubscribe = ports.onStateChanged(() => {
      this.#refresh();
      this.#tui.requestRender();
    });
  }

  render(width: number): string[] {
    const body = buildSettingsLines(this.#state);
    if (this.#failure !== undefined) {
      body.push({
        spans: [{ text: UI_COPY.settings.saveFailed(this.#failure), color: "warning" }],
      });
    }
    return this.#frame(body, width);
  }

  handleInput(data: string): void {
    if (this.#finished) return;
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.#finished = true;
      this.#done(undefined);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      this.#state = moveCursor(this.#state, -1);
      this.#tui.requestRender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      this.#state = moveCursor(this.#state, 1);
      this.#tui.requestRender();
      return;
    }
    if (this.#saving) return;
    if (matchesKey(data, "left")) void this.#adjust(-1);
    else if (matchesKey(data, "right")) void this.#adjust(1);
  }

  invalidate(): void {}

  dispose(): void {
    this.#unsubscribe();
  }

  async #adjust(direction: -1 | 1): Promise<void> {
    const row = this.#state.rows[this.#state.cursor];
    if (!row) return;
    const adjustment = row.kind === "config"
      ? stepNumeric(row, direction)
      : cycleAgent(row, direction);
    this.#state = {
      ...this.#state,
      rows: this.#state.rows.map((candidate, index) =>
        index === this.#state.cursor ? adjustment.row : candidate,
      ),
    };
    this.#failure = undefined;
    this.#saving = true;
    this.#tui.requestRender();
    try {
      const result = await this.#ports.applyChange(adjustment.change);
      this.#refresh();
      if (!result.ok) this.#failure = sanitizeLine(result.reason, 120);
    } catch (error) {
      this.#refresh();
      this.#failure = sanitizeLine(errorMessage(error), 120);
    } finally {
      this.#saving = false;
      this.#tui.requestRender();
    }
  }

  #refresh(): void {
    this.#state = buildSettingsState(
      this.#ports.getConfig(),
      this.#ports.getTeam(),
      this.#state.cursor,
    );
  }

  #frame(body: ReturnType<typeof buildSettingsLines>, width: number): string[] {
    const safeWidth = Math.max(1, Math.min(width, PANEL_MAX_WIDTH));
    if (safeWidth < 5) return [truncateToWidth(UI_COPY.settings.title(), safeWidth, "")];
    const inner = safeWidth - 4;
    const border = (text: string) => this.#theme.fg("accent", text);
    const rows = body.map(
      (line) => `${border("│ ")}${this.#paint(line, inner)}${border(" │")}`,
    );
    return [this.#frameTop(inner, border), ...rows, this.#frameBottom(inner, border)];
  }

  #frameTop(inner: number, border: (text: string) => string): string {
    const title = truncateToWidth(` ${UI_COPY.settings.title()} `, inner, "");
    const dashes = Math.max(0, inner - visibleWidth(title));
    return border("╭─") +
      this.#theme.bold(this.#theme.fg("text", title)) +
      border(`${"─".repeat(dashes)}─╮`);
  }

  #frameBottom(inner: number, border: (text: string) => string): string {
    const label = truncateToWidth(` ${UI_COPY.settings.keybar()} `, inner, "");
    const dashes = Math.max(0, inner - visibleWidth(label));
    return border("╰─") +
      this.#theme.fg("dim", label) +
      border(`${"─".repeat(dashes)}─╯`);
  }

  #paint(line: ReturnType<typeof buildSettingsLines>[number], width: number): string {
    let remaining = Math.max(1, width);
    let painted = "";
    for (const part of line.spans) {
      if (remaining <= 0) break;
      const text = truncateToWidth(part.text, remaining, "");
      remaining -= visibleWidth(text);
      const colored = this.#theme.fg(part.color, text);
      painted += part.bold ? this.#theme.bold(colored) : colored;
    }
    const padded = `${painted}${" ".repeat(Math.max(0, remaining))}`;
    return line.selected ? this.#theme.bg("selectedBg", padded) : padded;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
