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
        label: "Open File",
        detail: layout.keymap.files,
        run: () => layout.openPalette("file"),
      },
      {
        id: "symbols",
        kind: "command",
        label: "Go to Symbol",
        detail: "Workspace index",
        run: () => layout.openPalette("symbol"),
      },
      {
        id: "agents",
        kind: "command",
        label: "Go to Agent",
        detail: "Workspace agents",
        run: () => layout.openPalette("agent"),
      },
      {
        id: "checkpoints",
        kind: "command",
        label: "Go to Checkpoint",
        detail: "Inspect checkpoint diff",
        run: () => layout.openPalette("checkpoint"),
      },
      {
        id: "save-layout",
        kind: "command",
        label: "Save Layout",
        detail: layout.profile,
        run: () => void layout.save(),
      },
      ...WORKBENCH_PANELS.map(
        (panel): Command => ({
          id: `panel:${panel}`,
          kind: "command",
          label: `Show ${panelNames[panel]}`,
          detail: "Workbench panel",
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
          `${entry.kind === "agent" ? "Agent" : "Checkpoint"} selected: ${entry.id}`,
        );
    }
  };
  return (
    <dialog
      ref={dialog}
      className="command-palette"
      aria-label="Command palette"
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
            ? "Commands, files, symbols, agents & checkpoints"
            : `Search ${layout.scope}s`}
        </strong>
        <button onClick={close} aria-label="Close command palette">
          Esc
        </button>
      </header>
      <label className="sr-only" htmlFor="palette-query">
        Palette search
      </label>
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
            ? "Search workspace files…"
            : "Type a command or search…"
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
        aria-label="Palette results"
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
          {search.isFetching ? "Searching workspace…" : "No matches"}
        </p>
      )}
      <footer>↑↓ Navigate · Enter Run · Esc Dismiss</footer>
    </dialog>
  );
}
