import { t } from "./i18n";
import { create } from "zustand";
import {
  Actions,
  DockLocation,
  Model,
  type IJsonModel,
} from "flexlayout-react";
import {
  DEFAULT_WORKBENCH_KEYS,
  type WorkbenchKeys,
  type WorkbenchPanel,
  type WorkbenchProfile,
  type WorkbenchSettings,
} from "@helix/protocol";
import { rpc, queryClient } from "./rpc";
import { useWorkbench } from "./state";

export const panelNames: Record<WorkbenchPanel, string> = {
  explorer: t("explorer_c39d64"),
  editor: t("editor_936a16"),
  agent: t("agent_11b39c"),
  terminal: t("terminal_e0926f"),
  preview: t("preview_324b13"),
  problems: t("problems_a7b182"),
  monitor: t("task_monitor_ac382a"),
  scm: t("source_control_9bd7ea"),
  settings: t("settings_74a883"),
  mcp: t("mcp_manager_b3563d"),
  ledger: t("ledger_traces_bee3c3"),
};
export const profileLabels = { Build: t('build_bdd254'), Debug: t('debug_1a03bd'), Review: t('review_aff076'), Explore: t('explore_3b7390') };
const tab = (id: WorkbenchPanel) => ({
  type: "tab" as const,
  id,
  component: id,
  name: panelNames[id],
  enableClose: id !== "editor",
});
export function defaultLayout(profile: WorkbenchProfile): IJsonModel {
  const tools: WorkbenchPanel[] =
    profile === "Debug"
      ? ["terminal", "problems", "preview", "monitor", "scm", "mcp", "settings"]
      : profile === "Review"
        ? [
            "scm",
            "problems",
            "terminal",
            "preview",
            "monitor",
            "mcp",
            "settings",
          ]
        : profile === "Explore"
          ? [
              "monitor",
              "terminal",
              "preview",
              "problems",
              "scm",
              "mcp",
              "settings",
            ]
          : [
              "terminal",
              "preview",
              "problems",
              "monitor",
              "scm",
              "mcp",
              "settings",
            ];
  tools.push('ledger');
  return {
    global: {
      tabEnableRename: false,
      tabSetEnableClose: false,
      tabEnablePopout: false,
      tabEnableFloat: true,
      tabSetMinWidth: 140,
      tabSetMinHeight: 90,
    },
    borders: [],
    layout: {
      type: "row",
      id: "root",
      children: [
        {
          type: "tabset",
          id: "files",
          weight: 18,
          children: [tab("explorer")],
        },
        {
          type: "row",
          id: "center",
          weight: 55,
          children: [
            {
              type: "tabset",
              id: "editors",
              weight: 65,
              children: [tab("editor")],
            },
            {
              type: "tabset",
              id: "tools",
              weight: 35,
              children: tools.map(tab),
            },
          ],
        },
        { type: "tabset", id: "agents", weight: 27, children: [tab("agent")] },
      ],
    },
  };
}
type LayoutState = {
  workspace: string;
  profile: WorkbenchProfile;
  model: Model;
  profiles: WorkbenchSettings["profiles"];
  keymap: WorkbenchKeys;
  revision: number;
  saving: boolean;
  palette: boolean;
  scope: "all" | "file" | "symbol" | "agent" | "checkpoint" | "command";
  hydrate(workspace: string, settings: WorkbenchSettings): void;
  selectProfile(profile: WorkbenchProfile): void;
  changed(): void;
  save(): Promise<void>;
  show(panel: WorkbenchPanel): void;
  openPalette(scope?: LayoutState["scope"]): void;
};
export const useLayout = create<LayoutState>((set, get) => ({
  workspace: "",
  profile: "Build",
  model: Model.fromJson(defaultLayout("Build")),
  profiles: {},
  keymap: { ...DEFAULT_WORKBENCH_KEYS },
  revision: 0,
  saving: false,
  palette: false,
  scope: "all",
  hydrate: (workspace, settings) => {
    if (useWorkbench.getState().workspace !== workspace) return;
    set({
      workspace,
      profile: settings.activeProfile,
      profiles: settings.profiles,
      keymap: settings.keymap,
      model: Model.fromJson(
        (settings.profiles[settings.activeProfile] as IJsonModel | undefined) ??
          defaultLayout(settings.activeProfile),
      ),
      revision: 0,
      palette: false,
    });
  },
  selectProfile: (profile) => {
    const state = get();
    if (state.profile === profile) return;
    set({
      profile,
      model: Model.fromJson(
        (state.profiles[profile] as IJsonModel | undefined) ??
          defaultLayout(profile),
      ),
      revision: state.revision + 1,
    });
  },
  changed: () => set((state) => ({ revision: state.revision + 1 })),
  save: async () => {
    const state = get();
    if (!state.workspace || state.saving) return;
    set({ saving: true });
    try {
      const result = await rpc.call<WorkbenchSettings>(
        "workbench.settings.set",
        {
          workspacePath: state.workspace,
          profile: state.profile,
          layout: state.model.toJson(),
          keymap: state.keymap,
        },
      );
      queryClient.setQueryData(
        ["workbench.settings.get", { workspacePath: state.workspace }],
        result,
      );
      if (get().workspace === state.workspace) {
        set({ profiles: result.profiles });
        useWorkbench.getState().message(t("_0_layout_saved_ba0814", [state.profile]));
      }
    } catch (error) {
      useWorkbench.getState().message((error as Error).message);
    } finally {
      set({ saving: false });
    }
  },
  show: (panel) => {
    const { model } = get();
    if (!model.getNodeById(panel))
      model.doAction(
        Actions.addTab(
          tab(panel),
          model.getRootRow()!.getId(),
          DockLocation.RIGHT,
          -1,
        ),
      );
    model.doAction(Actions.selectTab(panel));
    const node = model.getNodeById(panel)!;
    if (node.getLayoutId() !== model.getRootRow()!.getLayoutId())
      model.doAction(Actions.movePopoutToFront(node.getLayoutId()));
    if (!["explorer", "editor"].includes(panel))
      useWorkbench.getState().setPanel(panel as import("./state").Panel);
    get().changed();
    requestAnimationFrame(() => {
      const region = document.querySelector<HTMLElement>(`[data-panel="${panel}"]`);
      (region?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, select:not(:disabled), summary') ?? region)?.focus();
    });
  },
  openPalette: (scope = "all") => set({ palette: true, scope }),
}));
