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
  { id: "agent", name: "Agent", icon: Bot },
  { id: "terminal", name: "Terminal", icon: TerminalSquare },
  { id: "preview", name: "Preview", icon: PanelsTopLeft },
  { id: "problems", name: "Problems", icon: CircleAlert },
  { id: "monitor", name: "Task monitor", icon: Activity },
  { id: "scm", name: "Source control", icon: GitBranch },
  { id: "mcp", name: "MCP manager", icon: Plug },
  { id: "settings", name: "Settings", icon: Settings2 },
] satisfies { id: Panel; name: string; icon: typeof Bot }[];
function Workbench() {
  const workspace = useWorkbench((state) => state.workspace);
  const panel = useWorkbench((state) => state.panel);
  const notice = useWorkbench((state) => state.notice);
  const dirty = useWorkbench((state) => state.dirty);
  const [path, setPath] = useState("");
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
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
          <span className="brand-mark">H</span>
          <strong>helix</strong>
          <span className="brand-divider" />
          <span>Workbench</span>
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
            aria-label="Workspace path"
            list="known-workspaces"
            value={path}
            placeholder="Open workspace by absolute path…"
            onChange={(event) => setPath(event.target.value)}
          />
          <datalist id="known-workspaces">
            {workspaces.data?.map((workspace) => (
              <option key={workspace.path} value={workspace.path} />
            ))}
          </datalist>
          <button disabled={!path.trim() || opening}>Open workspace</button>
        </form>
        <span id="engine-status" className="engine ok" role="status">
          Engine connected
        </span>
      </header>
      {error && (
        <p className="banner" role="alert">
          {error}
        </p>
      )}
      <div className="workbench-body">
        <nav className="activity-bar" aria-label="Workbench panels">
          <button
            aria-label="Explorer"
            title="Explorer"
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
          {workspace.split("/").filter(Boolean).at(-1) || "No workspace"}
        </span>
        <span
          className={`isolation ${isolation.data?.isolation === "light" ? "light" : ""}`}
        >
          <ShieldCheck size={12} />
          {isolation.data?.isolation === "light"
            ? "LIGHT SANDBOX · trusted repository"
            : `Isolation: ${isolation.data?.isolation ?? "checking"}`}{" "}
          · {isolation.data?.backend || "unavailable"}
        </span>
        <span className="save-notice" role="status">
          {notice || (dirty ? "Unsaved changes" : "Ready")}
        </span>
        <span>UTF-8</span>
        <span>Helix 0.1</span>
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
        <h1>Helix Workbench</h1>
        <p>Connect to your Engine</p>
        <label>
          Engine token
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
          />
        </label>
        <button disabled={busy}>{busy ? "Connecting…" : "Connect"}</button>
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
      if (!response.ok) throw new Error("Engine configuration unavailable");
      return response.json() as Promise<{ auth: string }>;
    },
  });
}
rpc.subscribe(({ method }) => {
  if (method === "event")
    void queryClient.invalidateQueries({
      predicate: (query) =>
        !["engine-config"].includes(String(query.queryKey[0])),
    });
  if (method === "disconnected") {
    useWorkbench
      .getState()
      .message("Engine disconnected; reconnect to resume.");
    document.getElementById("engine-status")?.classList.remove("ok");
  }
});
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Connection />
  </QueryClientProvider>,
);
