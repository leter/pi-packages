import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

import type { AttentionRecord, StoredDispatch } from "../registry/types.js";
import {
  buildDetailLines,
  buildListLines,
  availableActions,
  detailChrome,
  listChrome,
  selectableIds,
  type DispatchAction,
  type DispatchViewSnapshot,
  type OutputReadState,
  type ViewChrome,
  type ViewLine,
} from "./dispatch-view-model.js";
import { sanitizeLine } from "./visual.js";
import { UI_COPY } from "./ui-copy.js";

/**
 * Interactive dispatch view panel (list ⇄ detail).
 *
 * The panel is a read-only observation surface. It re-reads the Registry on
 * every render, performs output reads only as explicit bounded one-shots,
 * and produces at most one result: a command prefilled into the editor,
 * which still passes through the existing preview + confirmation gates.
 */

export interface DispatchViewPorts {
  snapshot(): DispatchViewSnapshot;
  getDispatch(dispatchId: string): StoredDispatch | undefined;
  listAttention(dispatchId: string): readonly AttentionRecord[];
  /** One explicit bounded tail read; lines is 50 or 200. */
  inspect(terminalId: string, lines: number): Promise<{ text: string }>;
  /** Marks a settled record's result as seen when its detail is opened. */
  markResultSeen?(dispatchId: string): void;
  onStateChanged(listener: () => void): () => void;
  now?(): number;
}

export type DispatchViewResult = { action: DispatchAction; dispatchId: string } | undefined;

export interface DispatchViewOptions {
  action?: DispatchAction;
}

const RELATIVE_TIME_TICK_MS = 30_000;
const LIST_WINDOW_ROWS = 10;
const PAGE_ROWS = 8;

export function openDispatchView(
  ui: Pick<ExtensionUIContext, "custom">,
  ports: DispatchViewPorts,
  options: DispatchViewOptions = {},
): Promise<DispatchViewResult> {
  return ui.custom<DispatchViewResult>(
    (tui, theme, _keybindings, done) => new DispatchViewComponent(tui, theme, ports, done, options),
  );
}

type Screen = { kind: "list" } | { kind: "detail"; dispatchId: string };

export class DispatchViewComponent implements Component {
  readonly #tui: Pick<TUI, "requestRender">;
  readonly #theme: Theme;
  readonly #ports: DispatchViewPorts;
  readonly #done: (result: DispatchViewResult) => void;
  readonly #now: () => number;
  readonly #action?: DispatchAction;
  readonly #unsubscribe: () => void;
  readonly #timer: ReturnType<typeof setInterval>;
  #screen: Screen = { kind: "list" };
  #selectedId: string | undefined;
  #selectedIndex = 0;
  #windowStart = 0;
  #showSettled = false;
  #showTechnical = false;
  #output: OutputReadState = { status: "none" };
  #readToken = 0;
  #finished = false;

  constructor(
    tui: Pick<TUI, "requestRender">,
    theme: Theme,
    ports: DispatchViewPorts,
    done: (result: DispatchViewResult) => void,
    options: DispatchViewOptions = {},
  ) {
    this.#tui = tui;
    this.#theme = theme;
    this.#ports = ports;
    this.#done = done;
    this.#action = options.action;
    this.#now = ports.now ?? Date.now;
    this.#unsubscribe = ports.onStateChanged(() => this.#tui.requestRender());
    this.#timer = setInterval(() => this.#tui.requestRender(), RELATIVE_TIME_TICK_MS);
    this.#timer.unref?.();
  }

  render(width: number): string[] {
    let body: ViewLine[];
    let chrome: ViewChrome;
    try {
      if (this.#screen.kind === "list") {
        body = this.#listLines();
        chrome = listChrome(this.#ports.snapshot(), this.#showSettled);
      } else {
        ({ body, chrome } = this.#detailView());
      }
    } catch (error) {
      body = [{ spans: [{ text: UI_COPY.manager.viewUnavailable(errorText(error)), color: "warning" }] }];
      chrome = { title: UI_COPY.manager.title(), hint: UI_COPY.manager.closeKeybar().trim() };
    }
    return this.#frame(body, chrome, width);
  }

  handleInput(data: string): void {
    if (this.#finished) return;
    try {
      if (this.#screen.kind === "list") this.#handleListInput(data);
      else this.#handleDetailInput(data);
    } catch {
      // A failed Registry read never crashes input handling; the next render reports it.
    }
    this.#tui.requestRender();
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.#timer);
    this.#unsubscribe();
  }

  #handleListInput(data: string): void {
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) return this.#move(-1);
    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) return this.#move(1);
    if (matchesKey(data, "pageUp")) return this.#move(-PAGE_ROWS);
    if (matchesKey(data, "pageDown")) return this.#move(PAGE_ROWS);
    if (matchesKey(data, "home")) return this.#moveTo(0);
    if (matchesKey(data, "end")) return this.#moveTo(this.#ids().length - 1);
    if (matchesKey(data, "enter") || matchesKey(data, "right")) {
      this.#reconcileSelection();
      if (this.#selectedId !== undefined) {
        if (this.#action) {
          this.#finish({ action: this.#action, dispatchId: this.#selectedId });
          return;
        }
        this.#screen = { kind: "detail", dispatchId: this.#selectedId };
        this.#output = { status: "none" };
        this.#showTechnical = false;
        this.#markSeenIfUnseen(this.#selectedId);
      }
      return;
    }
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "left") ||
      matchesKey(data, "ctrl+c")
    ) return this.#finish(undefined);
    const key = printableKey(data);
    if (key === "s") {
      this.#showSettled = !this.#showSettled;
      this.#reconcileSelection();
    }
  }

  #handleDetailInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) return this.#finish(undefined);
    if (matchesKey(data, "escape") || matchesKey(data, "left")) {
      this.#screen = { kind: "list" };
      this.#output = { status: "none" };
      this.#showTechnical = false;
      this.#readToken += 1;
      return;
    }
    const key = printableKey(data);
    if (key === "r") return this.#startRead(50);
    if (key === "R") return this.#startRead(200);
    if (key === "D" || key === "d") {
      this.#showTechnical = !this.#showTechnical;
      return;
    }
    if (key === "y" || key === "c" || key === "v") {
      const dispatch = this.#currentDispatch();
      if (!dispatch || dispatch.lifecycle === "settled") return;
      const action = key === "y" ? "reply" : key === "c" ? "cancel" : "resolve";
      const snapshot = this.#ports.snapshot();
      if (!availableActions(dispatch, this.#ports.listAttention(dispatch.id), snapshot.originSessionId).includes(action)) {
        return;
      }
      this.#finish({ action, dispatchId: dispatch.id });
    }
  }

  #listLines(): ViewLine[] {
    const snapshot = this.#ports.snapshot();
    this.#reconcileSelection(snapshot);
    const ids = selectableIds(snapshot, this.#showSettled);
    const visibleIds = new Set(ids.slice(this.#windowStart, this.#windowStart + LIST_WINDOW_ROWS));
    return buildListLines(snapshot, this.#selectedId, this.#showSettled, this.#now(), visibleIds);
  }

  #detailView(): { body: ViewLine[]; chrome: ViewChrome } {
    const dispatch = this.#currentDispatch();
    if (!dispatch) {
      return {
        body: [{ spans: [{ text: UI_COPY.manager.missingRegistryDispatch(), color: "warning" }] }],
        chrome: { title: UI_COPY.manager.detailTitle(), hint: UI_COPY.manager.backKeybar().trim() },
      };
    }
    const snapshot = this.#ports.snapshot();
    const attention = this.#ports.listAttention(dispatch.id);
    return {
      body: buildDetailLines(
        dispatch,
        attention,
        this.#output,
        this.#now(),
        snapshot.originSessionId,
        this.#showTechnical,
      ),
      chrome: detailChrome(dispatch, attention, snapshot.originSessionId),
    };
  }

  /** Viewing a settled result is what marks it seen (presentation metadata only). */
  #markSeenIfUnseen(dispatchId: string): void {
    try {
      const dispatch = this.#ports.getDispatch(dispatchId);
      if (dispatch?.lifecycle === "settled" && dispatch.resultSeenAt === undefined) {
        this.#ports.markResultSeen?.(dispatchId);
      }
    } catch {
      // A failed Registry read never crashes input handling.
    }
  }

  #currentDispatch(): StoredDispatch | undefined {
    return this.#screen.kind === "detail"
      ? this.#ports.getDispatch(this.#screen.dispatchId)
      : undefined;
  }

  #move(delta: number): void {
    const ids = this.#ids();
    if (ids.length === 0) return;
    this.#reconcileSelection();
    const current = this.#selectedId === undefined ? -1 : ids.indexOf(this.#selectedId);
    const base = current === -1 ? (delta > 0 ? -1 : 0) : current;
    this.#moveTo(Math.min(ids.length - 1, Math.max(0, base + delta)));
  }

  #moveTo(index: number): void {
    const ids = this.#ids();
    if (ids.length === 0) return;
    const next = Math.min(ids.length - 1, Math.max(0, index));
    this.#selectedId = ids[next];
    this.#selectedIndex = next;
    this.#ensureSelectionVisible(ids.length);
  }

  /** Keep the selection on the same dispatch across refreshes; fall back to position. */
  #reconcileSelection(snapshot?: DispatchViewSnapshot): void {
    const ids = snapshot ? selectableIds(snapshot, this.#showSettled) : this.#ids();
    if (ids.length === 0) {
      this.#selectedId = undefined;
      this.#selectedIndex = 0;
      this.#windowStart = 0;
      return;
    }
    if (this.#selectedId !== undefined) {
      const index = ids.indexOf(this.#selectedId);
      if (index !== -1) {
        this.#selectedIndex = index;
        this.#ensureSelectionVisible(ids.length);
        return;
      }
    }
    this.#selectedIndex = Math.min(this.#selectedIndex, ids.length - 1);
    this.#selectedId = ids[this.#selectedIndex];
    this.#ensureSelectionVisible(ids.length);
  }

  #ensureSelectionVisible(total: number): void {
    const maximumStart = Math.max(0, total - LIST_WINDOW_ROWS);
    if (this.#selectedIndex < this.#windowStart) this.#windowStart = this.#selectedIndex;
    if (this.#selectedIndex >= this.#windowStart + LIST_WINDOW_ROWS) {
      this.#windowStart = this.#selectedIndex - LIST_WINDOW_ROWS + 1;
    }
    this.#windowStart = Math.min(maximumStart, Math.max(0, this.#windowStart));
  }

  #ids(): string[] {
    try {
      return selectableIds(this.#ports.snapshot(), this.#showSettled);
    } catch {
      return [];
    }
  }

  #startRead(lines: number): void {
    if (this.#output.status === "reading") return;
    const dispatch = this.#currentDispatch();
    if (!dispatch) return;
    const token = ++this.#readToken;
    this.#output = { status: "reading", requestedLines: lines };
    this.#ports.inspect(dispatch.targetTerminalId, lines).then(
      ({ text }) => {
        if (token !== this.#readToken) return;
        this.#output = {
          status: "read",
          terminalId: dispatch.targetTerminalId,
          text,
          requestedLines: lines,
          readAt: this.#now(),
        };
        this.#tui.requestRender();
      },
      (error: unknown) => {
        if (token !== this.#readToken) return;
        this.#output = { status: "error", message: errorText(error) };
        this.#tui.requestRender();
      },
    );
  }

  #finish(result: DispatchViewResult): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#done(result);
  }

  /** Wrap body lines in the rounded frame; title/counts live in the top border, the keybar in the bottom border. */
  #frame(body: ViewLine[], chrome: ViewChrome, width: number): string[] {
    const safeWidth = Math.max(24, width);
    const inner = safeWidth - 4;
    const border = (text: string) => this.#theme.fg("accent", text);
    const rows = body.map(
      (line) => `${border("│ ")}${this.#paint(line, inner)}${border(" │")}`,
    );
    return [this.#frameTop(chrome, inner, border), ...rows, this.#frameBottom(chrome.hint, inner, border)];
  }

  #frameTop(chrome: ViewChrome, inner: number, border: (text: string) => string): string {
    const title = truncateToWidth(` ${chrome.title} `, inner, "");
    const counts = chrome.counts === undefined ? "" : ` ${chrome.counts} `;
    const titleWidth = visibleWidth(title);
    const countsWidth = visibleWidth(counts);
    const dashes = inner - titleWidth - countsWidth;
    if (dashes < 0) {
      return border(`╭─${"─".repeat(Math.max(0, inner))}─╮`);
    }
    const paintedTitle = this.#theme.bold(this.#theme.fg("text", title));
    const paintedCounts =
      counts === "" ? "" : this.#theme.fg(chrome.countsColor ?? "muted", counts);
    return (
      border("╭─") + paintedTitle + border("─".repeat(dashes)) + paintedCounts + border("─╮")
    );
  }

  #frameBottom(hint: string, inner: number, border: (text: string) => string): string {
    const label = truncateToWidth(` ${hint} `, inner, "");
    const dashes = inner - visibleWidth(label);
    return border("╰─") + this.#theme.fg("dim", label) + border(`${"─".repeat(Math.max(0, dashes))}─╯`);
  }

  #paint(line: ViewLine, width: number): string {
    const safeWidth = Math.max(1, width);
    let remaining = safeWidth;
    let painted = "";
    for (const part of line.spans) {
      if (remaining <= 0) break;
      const text = truncateToWidth(part.text, remaining, "");
      remaining -= visibleWidth(text);
      const colored = this.#theme.fg(part.color, text);
      painted += part.bold ? this.#theme.bold(colored) : colored;
    }
    const leftPad = line.align === "center" ? Math.floor(Math.max(0, remaining) / 2) : 0;
    const padded = `${" ".repeat(leftPad)}${painted}${" ".repeat(Math.max(0, remaining - leftPad))}`;
    return line.selected ? this.#theme.bg("selectedBg", padded) : padded;
  }
}

function printableKey(data: string): string | undefined {
  if (/^[\x20-\x7e]$/u.test(data)) return data;
  return decodeKittyPrintable(data);
}

function errorText(error: unknown): string {
  return sanitizeLine(error instanceof Error ? error.message : String(error), 120);
}
