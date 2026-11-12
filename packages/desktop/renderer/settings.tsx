import { t } from "./i18n";
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
      setMessage(t("provider_key_stored_in_the_os_keychain_06360b"));
      void vault.refetch();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="tool-panel" aria-label={t("settings_panel_a5b272")}>
      <div className="toolbar">
        <h2>{t("settings_74a883")}</h2>
        <button
          onClick={() => {
            void vault.refetch();
            void roles.refetch();
          }}
        >
          {t("refresh_settings_e03a3c")}</button>
      </div>
      <h3>{t("models_providers_d76f5d")}</h3>
      <p className="hint">
        {t("credential_store_8e2418")}{vault.data?.keychain ?? t("loading_ba3bbb")}{t("_no_plaintext_fallback_7cd8c3")}</p>
      <ul>
        {vault.data?.providers.map((provider) => (
          <li key={provider.id}>
            {provider.id} {t("_588da4")}{provider.source || t("not_configured_dd1841")}
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
          {t("provider_39d0d9")}<select
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
          >
            <option value="gemini">{t("gemini_f6ece8")}</option>
            <option value="openai">{t("openai_8b7d1a")}</option>
          </select>
        </label>
        <label>
          {t("provider_key_57ad21")}<input
            type="password"
            autoComplete="new-password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <button
          disabled={!key.trim() || busy || vault.data?.keychain === "none"}
        >
          {t("save_provider_key_d5b7ac")}</button>
      </form>
      <p role="status">{message}</p>
      <h3>{t("resolved_role_bindings_8e5ca1")}</h3>
      <ul>
        {Object.entries(roles.data ?? {}).map(([role, binding]) => (
          <li key={role}>
            <strong>{role}</strong> {t("_78887d")}{" "}
            {binding.chain
              .map((model) => `${model.provider}/${model.model}`)
              .join(" → ")}{" "}
            {t("_6e01f7")}{binding.source}
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
    if (!window.confirm(t("change_trust_for_mcp_server_0_88c4f8", [name]))) return;
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
    <section className="tool-panel" aria-label={t("mcp_manager_panel_08aa7e")}>
      <div className="toolbar">
        <h2>{t("mcp_manager_b3563d")}</h2>
        <button onClick={() => void servers.refetch()}>{t("refresh_servers_df6d33")}</button>
      </div>
      {(error || servers.error) && (
        <p role="alert">{error || servers.error?.message}</p>
      )}
      {servers.data?.length ? (
        <ul>
          {servers.data.map((server) => (
            <li key={server.name}>
              <strong>{server.name}</strong> {t("_588da4")}{server.status} {t("_588da4")}{server.trust}
              <button
                onClick={() =>
                  void trust(server.name, server.trust !== "trusted")
                }
              >
                {t("change_server_trust_8c5c21")}</button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-state">
          {t("no_mcp_servers_configured_in_the_engine_03c362")}</div>
      )}
    </section>
  );
}
