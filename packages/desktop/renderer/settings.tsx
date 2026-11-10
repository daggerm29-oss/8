import { useState } from "react";
import { rpc, useRpc } from "./rpc";
import { useWorkbench } from "./state";

type VaultStatus = {
  keychain: string;
  providers: { id: string; source: string | null }[];
};
export function SettingsPanel() {
  const workspace = useWorkbench((state) => state.workspace);
  const vault = useRpc<VaultStatus>("vault.status");
  const roles = useRpc<
    Record<
      string,
      { chain: { provider: string; model: string }[]; source: string }
    >
  >("models.roles", { workspacePath: workspace }, !!workspace);
  const [provider, setProvider] = useState("gemini");
  const [key, setKey] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await rpc.call("vault.setKey", { provider, key });
      setKey("");
      setMessage("Provider key stored in the OS keychain");
      void vault.refetch();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="tool-panel" aria-label="Settings panel">
      <div className="toolbar">
        <h2>Settings</h2>
        <button
          onClick={() => {
            void vault.refetch();
            void roles.refetch();
          }}
        >
          Refresh settings
        </button>
      </div>
      <h3>Models &amp; providers</h3>
      <p className="hint">
        Credential store: {vault.data?.keychain ?? "Loading…"}. No plaintext
        fallback.
      </p>
      <ul>
        {vault.data?.providers.map((provider) => (
          <li key={provider.id}>
            {provider.id} · {provider.source || "Not configured"}
          </li>
        ))}
      </ul>
      <form
        className="settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label>
          Provider
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
          >
            <option value="gemini">Gemini</option>
            <option value="openai">OpenAI</option>
          </select>
        </label>
        <label>
          Provider key
          <input
            type="password"
            autoComplete="new-password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <button
          disabled={!key.trim() || busy || vault.data?.keychain === "none"}
        >
          Save provider key
        </button>
      </form>
      <p role="status">{message}</p>
      <h3>Resolved role bindings</h3>
      <ul>
        {Object.entries(roles.data ?? {}).map(([role, binding]) => (
          <li key={role}>
            <strong>{role}</strong> ·{" "}
            {binding.chain
              .map((model) => `${model.provider}/${model.model}`)
              .join(" → ")}{" "}
            · {binding.source}
          </li>
        ))}
      </ul>
    </section>
  );
}
export function McpPanel() {
  const servers =
    useRpc<{ name: string; status: string; trust: string; tools: unknown[] }[]>(
      "mcp.list",
    );
  const [error, setError] = useState("");
  const trust = async (name: string, trusted: boolean) => {
    if (!window.confirm(`Change trust for MCP server ${name}?`)) return;
    try {
      await rpc.call("mcp.trust", {
        name,
        trust: trusted ? "trusted" : "untrusted",
      });
      void servers.refetch();
    } catch (error) {
      setError((error as Error).message);
    }
  };
  return (
    <section className="tool-panel" aria-label="MCP manager panel">
      <div className="toolbar">
        <h2>MCP manager</h2>
        <button onClick={() => void servers.refetch()}>Refresh servers</button>
      </div>
      {(error || servers.error) && (
        <p role="alert">{error || servers.error?.message}</p>
      )}
      {servers.data?.length ? (
        <ul>
          {servers.data.map((server) => (
            <li key={server.name}>
              <strong>{server.name}</strong> · {server.status} · {server.trust}
              <button
                onClick={() =>
                  void trust(server.name, server.trust !== "trusted")
                }
              >
                Change server trust
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-state">
          No MCP servers configured in the Engine.
        </div>
      )}
    </section>
  );
}
