import { t } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  Files,
  Bot,
  TerminalSquare,
  PanelsTopLeft,
  CircleAlert,
  Activity,
  GitBranch,
  Settings2,
  Plug,
  FolderOpen,
  ShieldCheck,
} from "lucide-react";
import { rpc, queryClient, useRpc } from "./rpc";
import { confirmDiscard, useWorkbench, type Panel } from "./state";
import { DockWorkbench } from "./dock-workbench";
import { useLayout } from "./layout-state";
import "./workbench.css";
const panels = [
  { id: "agent", name: t("agent_11b39c"), icon: Bot },
  { id: "terminal", name: t("terminal_e0926f"), icon: TerminalSquare },
  { id: "preview", name: t("preview_324b13"), icon: PanelsTopLeft },
  { id: "problems", name: t("problems_a7b182"), icon: CircleAlert },
  { id: "monitor", name: t("task_monitor_ac382a"), icon: Activity },
  { id: "scm", name: t("source_control_9bd7ea"), icon: GitBranch },
  { id: "mcp", name: t("mcp_manager_b3563d"), icon: Plug },
  { id: "settings", name: t("settings_74a883"), icon: Settings2 },
] satisfies { id: Panel; name: string; icon: typeof Bot }[];
function Workbench() {
  const workspace = useWorkbench((state) => state.workspace);
  const panel = useWorkbench((state) => state.panel);
  const notice = useWorkbench((state) => state.notice);
  const dirty = useWorkbench((state) => state.dirty);
  const [path, setPath] = useState("");
  const [opening, setOpening] = useState(false);
  const [contrast, setContrast] = useState(() => matchMedia('(prefers-contrast: more), (forced-colors: active)').matches);
  useEffect(() => {
    document.documentElement.dataset.contrast = contrast ? 'high' : 'default';
  }, [contrast]);
  const [error, setError] = useState("");
  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      if (event.key === 'F6' && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>('.activity-bar button')?.focus();
      }
    };
    window.addEventListener('keydown', navigate, true);
    return () => window.removeEventListener('keydown', navigate, true);
  }, []);
  const workspaces = useRpc<{ path: string }[]>("workspace.list");
  const isolation = useRpc<{
    isolation: string;
    backend: string;
    reason: string;
  }>("workbench.status", workspace ? { workspacePath: workspace } : {});
  const open = async () => {
    if (!confirmDiscard()) return;
    setOpening(true);
    setError("");
    try {
      const result = await rpc.call<{ path: string }>("workspace.open", {
        workspacePath: path,
      });
      useWorkbench.getState().setWorkspace(result.path);
      void workspaces.refetch();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setOpening(false);
    }
  };
  return (
    <div className="workbench">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">{t("h_44bd7a")}</span>
          <strong>{t("helix_54a85d")}</strong>
          <span className="brand-divider" />
          <span>{t("workbench_a4e733")}</span>
        </div>
        <form
          className="workspace-form"
          onSubmit={(event) => {
            event.preventDefault();
            void open();
          }}
        >
          <FolderOpen size={14} />
          <input
            aria-label={t("workspace_path_1fddb7")}
            list="known-workspaces"
            value={path}
            placeholder={t("open_workspace_by_absolute_path_6357a4")}
            onChange={(event) => setPath(event.target.value)}
          />
          <datalist id="known-workspaces">
            {workspaces.data?.map((workspace) => (
              <option key={workspace.path} value={workspace.path} />
            ))}
          </datalist>
          <button disabled={!path.trim() || opening}>{t("open_workspace_b3e34b")}</button>
        </form>
        <button aria-pressed={contrast} onClick={() => setContrast(!contrast)}>{t("high_contrast_415a83")}</button>
        <span id="engine-status" className="engine ok" role="status">
          {t("engine_connected_aa27f4")}</span>
      </header>
      {error && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}
      <div className="workbench-body">
        <nav className="activity-bar" aria-keyshortcuts="F6" aria-label={t("workbench_panels_67dfe1")}>
          <button
            aria-label={t("explorer_c39d64")}
            title={t("explorer_c39d64")}
            onClick={() => useLayout.getState().show("explorer")}
          >
            <Files size={20} />
          </button>
          {panels.map(({ id, name, icon: Icon }) => (
            <button
              key={id}
              aria-label={name}
              title={name}
              aria-pressed={panel === id}
              onClick={() => useLayout.getState().show(id)}
            >
              <Icon size={20} />
            </button>
          ))}
        </nav>
        <DockWorkbench />
      </div>
      <footer className="statusbar">
        <span>
          <GitBranch size={12} />
          {workspace.split("/").filter(Boolean).at(-1) || t("no_workspace_fce263")}
        </span>
        <span
          className={`isolation ${isolation.data?.isolation === "light" ? "light" : ""}`}
        >
          <ShieldCheck size={12} />
          {isolation.data?.isolation === "light"
            ? t("light_sandbox_trusted_repository_ccc684")
            : t("isolation_0_821e0e", [isolation.data?.isolation ?? "checking"])}{" "}
          {t("_6e01f7")}{isolation.data?.backend || "unavailable"}
        </span>
        <span className="save-notice" role="status">
          {notice || (dirty ? t("unsaved_changes_a710c2") : t("ready_5fa7aa"))}
        </span>
        <span>{t("utf_8_3ad303")}</span>
        <span>{t("helix_0_1_b8292d")}</span>
      </footer>
    </div>
  );
}
function Connection() {
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [token, setToken] = useState(
    new URLSearchParams(location.hash.slice(1)).get("token") || "",
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (token || !window.helixDesktop) return;
    let current = true;
    window.helixDesktop
      .engineConnection()
      .then((connection) => {
        if (current && connection.token) setToken(connection.token);
      })
      .catch((error: Error) => current && setError(error.message));
    return () => {
      current = false;
    };
  }, []);
  const connect = async (value: string) => {
    setBusy(true);
    setError("");
    try {
      await rpc.connect(value);
      history.replaceState(null, "", location.pathname);
      setToken("");
      setConnected(true);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return connected ? (
    <Workbench />
  ) : (
    <ConnectionGate
      connect={connect}
      token={token}
      setToken={setToken}
      busy={busy}
      error={error}
    />
  );
}
function ConnectionGate({
  connect,
  token,
  setToken,
  busy,
  error,
}: {
  connect(token: string): Promise<void>;
  token: string;
  setToken(token: string): void;
  busy: boolean;
  error: string;
}) {
  const config = useQueryConfig();
  const started = useRef(false);
  useEffect(() => {
    if (!started.current && (token || config.data?.auth === "none")) {
      started.current = true;
      void connect(token);
    }
  }, [token, config.data?.auth, connect]);
  return (
    <main className="connect-screen">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void connect(token);
        }}
      >
        <h1>{t("helix_workbench_b7e493")}</h1>
        <p>{t("connect_to_your_engine_5154ba")}</p>
        <label>
          {t("engine_token_2f39cc")}<input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
          />
        </label>
        <button disabled={busy}>{busy ? t("connecting_72021e") : t("connect_1a2303")}</button>
        {(error || config.error) && (
          <p role="alert">{error || config.error?.message}</p>
        )}
      </form>
    </main>
  );
}
import { useQuery } from "@tanstack/react-query";
function useQueryConfig() {
  return useQuery({
    queryKey: ["engine-config"],
    queryFn: async () => {
      const response = await fetch("/config.json");
      if (!response.ok) throw new Error(t("engine_configuration_unavailable_d39f96"));
      return response.json() as Promise<{ auth: string }>;
    },
  });
}
rpc.subscribe(({ method, params }) => {
  if (method === "event" && params.topic !== 'agent.step.activity' && params.topic !== 'model.delta')
    void queryClient.invalidateQueries({
      predicate: (query) =>
        !["engine-config", "task.activity"].includes(String(query.queryKey[0])),
    });
  if (method === "disconnected") {
    useWorkbench
      .getState()
      .message(t("engine_disconnected_reconnect_to_resume_d3fdb1"));
    document.getElementById("engine-status")?.classList.remove("ok");
  }
});
document.title = t('helix_workbench_b7e493');
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Connection />
  </QueryClientProvider>,
);
