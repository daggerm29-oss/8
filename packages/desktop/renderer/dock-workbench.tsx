import { t, dockLabel } from "./i18n";
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
import { defaultLayout, panelNames, profileLabels, useLayout } from "./layout-state";
import { CommandPalette } from "./palette";
import { LedgerPanel } from './ledger-panel';
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
      role="region"
      aria-label={panelNames[id as WorkbenchPanel]}
      tabIndex={-1}
      data-panel={id}
      data-group={node.getParent()?.getId()}
      data-layout={node.getLayoutId()}
    >
      <Suspense fallback={<p>{t("loading_panel_747d3e")}</p>}>
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
        ) : id === 'ledger' ? (
          <LedgerPanel key={workspace} />
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
      <div className="layout-toolbar" aria-label={t("layout_controls_494f24")}>
        <label>
          {t("layout_a51190")}{" "}
          <select
            aria-label={t("task_layout_profile_5bf135")}
            value={layout.profile}
            disabled={!workspace || layout.saving}
            onChange={(event) =>
              layout.selectProfile(event.target.value as typeof layout.profile)
            }
          >
            {WORKBENCH_PROFILES.map((profile) => (
              <option key={profile} value={profile}>{profileLabels[profile]}</option>
            ))}
          </select>
        </label>
        <button
          disabled={
            !workspace || layout.workspace !== workspace || layout.saving
          }
          onClick={() => void layout.save()}
        >
          {t("save_layout_9508b4")}</button>
        <button
          disabled={!workspace}
          onClick={() => {
            useLayout.setState({
              model: Model.fromJson(defaultLayout(layout.profile)),
            });
            layout.changed();
          }}
        >
          {t("reset_layout_e6d48b")}</button>
        <details className="arrange-menu">
          <summary>{t("arrange_panels_bfb58e")}</summary>
          <div className="arrange-options">
            <label>
              {t("panel_d0d911")}{" "}
              <select
                aria-label={t("panel_to_arrange_886fe2")}
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
            <button onClick={() => act()}>{t("undock_panel_2600e8")}</button>
            <button onClick={() => act(DockLocation.LEFT)}>{t("dock_left_489100")}</button>
            <button onClick={() => act(DockLocation.RIGHT)}>{t("dock_right_547472")}</button>
            <button onClick={() => act(DockLocation.TOP)}>{t("dock_above_d74b4a")}</button>
            <button onClick={() => act(DockLocation.BOTTOM)}>{t("dock_below_de948f")}</button>
            <button onClick={() => act(DockLocation.CENTER)}>
              {t("group_with_editor_d924ae")}</button>
          </div>
        </details>
        <button onClick={() => setKeys(!keys)} aria-expanded={keys}>
          {t("key_bindings_d55242")}</button>
        <button
          className="palette-launcher"
          aria-keyshortcuts={layout.keymap.palette.replace(
            "Mod",
            navigator.platform.includes("Mac") ? "Meta" : "Control",
          )}
          onClick={() => layout.openPalette()}
        >
          {t("command_palette_c5b15d")}<kbd>{layout.keymap.palette}</kbd>
        </button>
      </div>
      {keys && (
        <div className="keymap-controls" aria-label={t("key_bindings_a55c1a")}>
          {(Object.keys(layout.keymap) as (keyof typeof layout.keymap)[]).map(
            (key) => (
              <label key={key}>
                {key}
                <input
                  aria-label={t("_0_shortcut_1b91c4", [key])}
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
            {t("use_mod_ctrl_meta_alt_shift_key_save_layout_t_65ceb1")}</span>
        </div>
      )}
      {settings.error ? (
        <p role="alert">{settings.error.message}</p>
      ) : workspace && layout.workspace !== workspace ? (
        <p role="status">{t("loading_workspace_layout_80fc47")}</p>
      ) : (
        <main
          className="dock-area"
          aria-label={t("dockable_workbench_34591b")}
          data-profile={layout.profile}
        >
          <Layout
            model={layout.model}
            i18nTranslator={dockLabel}
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
