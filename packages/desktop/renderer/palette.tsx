import { t } from "./i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  fuzzyScore,
  WORKBENCH_PANELS,
  type PaletteEntry,
} from "@helix/protocol";
import { openFile } from "./explorer";
import { useWorkbench } from "./state";
import { useRpc } from "./rpc";
import { panelNames, useLayout } from "./layout-state";

type Command = {
  id: string;
  kind: "command";
  label: string;
  detail: string;
  run(): void;
};
function shortcutMatches(event: KeyboardEvent, shortcut: string) {
  const parts = shortcut.toLowerCase().split("+");
  const key = parts.pop();
  const mac = navigator.platform.includes("Mac");
  return (
    event.key.toLowerCase() === key &&
    event.ctrlKey ===
      (parts.includes("ctrl") || (parts.includes("mod") && !mac)) &&
    event.metaKey ===
      (parts.includes("meta") || (parts.includes("mod") && mac)) &&
    event.altKey === parts.includes("alt") &&
    event.shiftKey === parts.includes("shift")
  );
}
export function CommandPalette() {
  const layout = useLayout();
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (shortcutMatches(event, layout.keymap.palette)) {
        event.preventDefault();
        layout.openPalette();
      } else if (shortcutMatches(event, layout.keymap.files)) {
        event.preventDefault();
        layout.openPalette("file");
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [layout.keymap, layout.openPalette]);
  return layout.palette ? <PaletteDialog key={layout.scope} /> : null;
}
function PaletteDialog() {
  const layout = useLayout();
  const workspace = useWorkbench((state) => state.workspace);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRpc<PaletteEntry[]>(
    "workbench.search",
    { workspacePath: workspace, query: debounced },
    !!workspace && layout.scope !== "command",
  );
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLInputElement>('#palette-query')?.focus();
    return () => {
      previous?.isConnected && previous.focus();
    };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 120);
    return () => clearTimeout(timer);
  }, [query]);
  const commands: Command[] = useMemo(
    () => [
      {
        id: "open-file",
        kind: "command",
        label: t("open_file_1e8d18"),
        detail: layout.keymap.files,
        run: () => layout.openPalette("file"),
      },
      {
        id: "symbols",
        kind: "command",
        label: t("go_to_symbol_c23239"),
        detail: t("workspace_index_e8d1fb"),
        run: () => layout.openPalette("symbol"),
      },
      {
        id: "agents",
        kind: "command",
        label: t("go_to_agent_1de24d"),
        detail: t("workspace_agents_15c5cb"),
        run: () => layout.openPalette("agent"),
      },
      {
        id: "checkpoints",
        kind: "command",
        label: t("go_to_checkpoint_6ee63c"),
        detail: t("inspect_checkpoint_diff_ddd483"),
        run: () => layout.openPalette("checkpoint"),
      },
      {
        id: "save-layout",
        kind: "command",
        label: t("save_layout_5cf8c5"),
        detail: layout.profile,
        run: () => void layout.save(),
      },
      ...WORKBENCH_PANELS.map(
        (panel): Command => ({
          id: `panel:${panel}`,
          kind: "command",
          label: t("show_0_ce2647", [panelNames[panel]]),
          detail: t("workbench_panel_b767c3"),
          run: () => layout.show(panel),
        }),
      ),
    ],
    [
      layout.keymap,
      layout.profile,
      layout.openPalette,
      layout.save,
      layout.show,
    ],
  );
  const matches = [
    ...(layout.scope === "all" || layout.scope === "command" ? commands : []),
    ...(layout.scope === "command"
      ? []
      : (search.data ?? []).filter(
          (entry) => layout.scope === "all" || entry.kind === layout.scope,
        )),
  ]
    .map((entry) => ({
      entry,
      score: fuzzyScore(query, `${entry.label} ${entry.detail}`),
    }))
    .filter(({ score }) => score >= 0)
    .sort(
      (a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label),
    )
    .slice(0, 80)
    .map(({ entry }) => entry);
  const index = Math.min(selected, Math.max(0, matches.length - 1));
  useEffect(() => {
    document
      .getElementById(`palette-option-${index}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);
  const close = () => useLayout.setState({ palette: false });
  const execute = async (entry: Command | PaletteEntry) => {
    if (entry.kind === "command") {
      close();
      entry.run();
    } else if (entry.path) {
      close();
      await openFile(entry.path, entry.line);
    } else if (entry.task) {
      close();
      useWorkbench.getState().setTask(entry.task);
      useWorkbench.setState({ selectedCheckpoint: entry.checkpoint ?? "" });
      layout.show(entry.kind === "agent" ? "agent" : "monitor");
      useWorkbench
        .getState()
        .message(
          t("_0_selected_1_aa6863", [entry.kind === "agent" ? t("agent_11b39c") : t("checkpoint_ee325a"), entry.id]),
        );
    }
  };
  return (
    <dialog
      ref={dialog}
      className="command-palette"
      aria-label={t("command_palette_0347f7")}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <header>
        <strong>
          {layout.scope === "all"
            ? t("commands_files_symbols_agents_checkpoints_d12d14")
            : t("search_0_s_631d1a", [layout.scope])}
        </strong>
        <button onClick={close} aria-label={t("close_command_palette_5d3b18")}>
          {t("esc_a75126")}</button>
      </header>
      <label className="sr-only" htmlFor="palette-query">
        {t("palette_search_cbded1")}</label>
      <input
        id="palette-query"
        autoFocus
        role="combobox"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls="palette-results"
        aria-activedescendant={
          matches[index] ? `palette-option-${index}` : undefined
        }
        placeholder={
          layout.scope === "file"
            ? t("search_workspace_files_cefcc3")
            : t("type_a_command_or_search_ff478e")
        }
        value={query}
        maxLength={100}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelected(0);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSelected(
              (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) %
                Math.max(1, matches.length),
            );
          } else if (event.key === "Enter" && matches[index]) {
            event.preventDefault();
            void execute(matches[index]);
          }
        }}
      />
      <div
        className="palette-results"
        id="palette-results"
        role="listbox"
        aria-label={t("palette_results_517d74")}
      >
        {matches.map((entry, at) => (
          <div
            id={`palette-option-${at}`}
            role="option"
            aria-selected={at === index}
            key={entry.id}
            onMouseMove={() => setSelected(at)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void execute(entry)}
          >
            <span className="palette-kind">{entry.kind}</span>
            <span>
              {entry.label}
              <small>{entry.detail}</small>
            </span>
          </div>
        ))}
      </div>
      {search.error && <p role="alert">{search.error.message}</p>}
      {!matches.length && (
        <p role="status">
          {search.isFetching ? t("searching_workspace_eecdf8") : t("no_matches_2df01a")}
        </p>
      )}
      <footer>{t("_navigate_enter_run_esc_dismiss_1c3f4c")}</footer>
    </dialog>
  );
}
