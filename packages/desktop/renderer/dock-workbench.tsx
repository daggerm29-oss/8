import { lazy, Suspense, useEffect, useState } from "react";
import {
  Actions,
  DockLocation,
  Layout,
  Model,
  type TabNode,
} from "flexlayout-react";
import {
  WORKBENCH_PANELS,
  WORKBENCH_PROFILES,
  type WorkbenchPanel,
  type WorkbenchSettings,
} from "@helix/protocol";
import { Explorer } from "./explorer";
import { AgentPanel, MonitorPanel } from "./agent-panels";
import { PreviewPanel, ProblemsPanel, ScmPanel } from "./environment-panels";
import { SettingsPanel, McpPanel } from "./settings";
import { useWorkbench } from "./state";
import { useRpc } from "./rpc";
import { defaultLayout, panelNames, useLayout } from "./layout-state";
import { CommandPalette } from "./palette";
import "flexlayout-react/style/dark.css";
import "./layout.css";
const Editor = lazy(() =>
  import("./editor").then((module) => ({ default: module.Editor })),
);
const TerminalPanel = lazy(() =>
  import("./terminal").then((module) => ({ default: module.TerminalPanel })),
);
function PanelContent({ node }: { node: TabNode }) {
  const workspace = useWorkbench((state) => state.workspace);
  const id = node.getComponent();
  return (
    <div
      className="dock-panel"
      data-panel={id}
      data-group={node.getParent()?.getId()}
      data-layout={node.getLayoutId()}
    >
      <Suspense fallback={<p>Loading panel…</p>}>
        {id === "editor" ? (
          <Editor />
        ) : id === "explorer" ? (
          <Explorer />
        ) : id === "agent" ? (
          <AgentPanel />
        ) : id === "terminal" ? (
          <TerminalPanel key={workspace} />
        ) : id === "preview" ? (
          <PreviewPanel key={workspace} />
        ) : id === "problems" ? (
          <ProblemsPanel />
        ) : id === "monitor" ? (
          <MonitorPanel />
        ) : id === "scm" ? (
          <ScmPanel key={workspace} />
        ) : id === "settings" ? (
          <SettingsPanel />
        ) : (
          <McpPanel />
        )}
      </Suspense>
    </div>
  );
}
export function DockWorkbench() {
  const workspace = useWorkbench((state) => state.workspace);
  const settings = useRpc<WorkbenchSettings>(
    "workbench.settings.get",
    { workspacePath: workspace },
    !!workspace,
  );
  const layout = useLayout();
  const [arrange, setArrange] = useState<WorkbenchPanel>("terminal");
  const [keys, setKeys] = useState(false);
  useEffect(() => {
    if (settings.data && useLayout.getState().workspace !== workspace)
      useLayout.getState().hydrate(workspace, settings.data);
  }, [workspace, settings.data]);
  const act = (location?: DockLocation) => {
    layout.show(arrange);
    if (location) {
      const target =
        arrange === "editor"
          ? layout.model.getRootRow()!
          : layout.model.getNodeById("editor")!.getParent()!;
      layout.model.doAction(
        Actions.moveNode(arrange, target.getId(), location, -1, true),
      );
    } else layout.model.doAction(Actions.popoutTab(arrange, "float"));
    layout.changed();
  };
  return (
    <div className="dock-workbench">
      <div className="layout-toolbar" aria-label="Layout controls">
        <label>
          Layout{" "}
          <select
            aria-label="Task layout profile"
            value={layout.profile}
            disabled={!workspace || layout.saving}
            onChange={(event) =>
              layout.selectProfile(event.target.value as typeof layout.profile)
            }
          >
            {WORKBENCH_PROFILES.map((profile) => (
              <option key={profile}>{profile}</option>
            ))}
          </select>
        </label>
        <button
          disabled={
            !workspace || layout.workspace !== workspace || layout.saving
          }
          onClick={() => void layout.save()}
        >
          Save layout
        </button>
        <button
          disabled={!workspace}
          onClick={() => {
            useLayout.setState({
              model: Model.fromJson(defaultLayout(layout.profile)),
            });
            layout.changed();
          }}
        >
          Reset layout
        </button>
        <details className="arrange-menu">
          <summary>Arrange panels</summary>
          <div className="arrange-options">
            <label>
              Panel{" "}
              <select
                aria-label="Panel to arrange"
                value={arrange}
                onChange={(event) =>
                  setArrange(event.target.value as WorkbenchPanel)
                }
              >
                {WORKBENCH_PANELS.map((id) => (
                  <option key={id} value={id}>
                    {panelNames[id]}
                  </option>
                ))}
              </select>
            </label>
            <button onClick={() => act()}>Undock panel</button>
            <button onClick={() => act(DockLocation.LEFT)}>Dock left</button>
            <button onClick={() => act(DockLocation.RIGHT)}>Dock right</button>
            <button onClick={() => act(DockLocation.TOP)}>Dock above</button>
            <button onClick={() => act(DockLocation.BOTTOM)}>Dock below</button>
            <button onClick={() => act(DockLocation.CENTER)}>
              Group with editor
            </button>
          </div>
        </details>
        <button onClick={() => setKeys(!keys)} aria-expanded={keys}>
          Key bindings
        </button>
        <button
          className="palette-launcher"
          aria-keyshortcuts={layout.keymap.palette.replace(
            "Mod",
            navigator.platform.includes("Mac") ? "Meta" : "Control",
          )}
          onClick={() => layout.openPalette()}
        >
          Command palette <kbd>{layout.keymap.palette}</kbd>
        </button>
      </div>
      {keys && (
        <div className="keymap-controls" aria-label="Key bindings">
          {(Object.keys(layout.keymap) as (keyof typeof layout.keymap)[]).map(
            (key) => (
              <label key={key}>
                {key}
                <input
                  aria-label={`${key} shortcut`}
                  value={layout.keymap[key]}
                  onChange={(event) =>
                    useLayout.setState({
                      keymap: { ...layout.keymap, [key]: event.target.value },
                    })
                  }
                />
              </label>
            ),
          )}
          <span>
            Use Mod/Ctrl/Meta/Alt/Shift + key. Save layout to persist.
          </span>
        </div>
      )}
      {settings.error ? (
        <p role="alert">{settings.error.message}</p>
      ) : workspace && layout.workspace !== workspace ? (
        <p role="status">Loading workspace layout…</p>
      ) : (
        <main
          className="dock-area"
          aria-label="Dockable workbench"
          data-profile={layout.profile}
        >
          <Layout
            model={layout.model}
            factory={(node) => <PanelContent node={node} />}
            supportsPopout={false}
            constrainFloatPanels
            onModelChange={() => layout.changed()}
            keyMap={{
              focusNextTabset: layout.keymap.nextGroup,
              focusPreviousTabset: layout.keymap.previousGroup,
            }}
          />
        </main>
      )}
      <CommandPalette />
    </div>
  );
}
