import { t } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { rpc, queryClient } from "./rpc";
import { useWorkbench } from "./state";

export function TerminalPanel() {
  const workspace = useWorkbench((state) => state.workspace);
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const pty = useRef<string | null>(null);
  const [status, setStatus] = useState<string>(t("no_shell_open_121854"));
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useState("");
  const [output, setOutput] = useState("");
  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      theme: { background: "#101215", foreground: "#d4d7dc" },
      fontSize: 12,
      cursorBlink: true,
      screenReaderMode: true,
    });
    term.attachCustomKeyEventHandler((event) => event.key !== 'Tab' && event.key !== 'F6');
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    terminal.current = term;
    const updateTheme = () => {
      const style = getComputedStyle(document.documentElement);
      term.options.theme = { background: style.getPropertyValue('--bg').trim(), foreground: style.getPropertyValue('--fg').trim() };
    };
    updateTheme();
    const contrast = new MutationObserver(updateTheme);
    contrast.observe(document.documentElement, { attributes: true, attributeFilter: ['data-contrast'] });
    const observer = new ResizeObserver(() => {
      if (host.current?.clientWidth) fit.fit();
    });
    observer.observe(host.current);
    const input = term.onData((data) => {
      if (pty.current)
        void rpc
          .call("pty.write", { ptyId: pty.current, data })
          .catch((error) => setStatus(error.message));
    });
    const unsubscribe = rpc.subscribe(({ method, params }) => {
      if (params.ptyId !== pty.current) return;
      if (method === "pty.output") term.write(String(params.data));
      if (method === "pty.exit") {
        pty.current = null;
        setStatus(t("shell_exited_0_f77cee", [params.exitCode]));
      }
    });
    return () => {
      const id = pty.current;
      pty.current = null;
      if (id) void rpc.call("pty.kill", { ptyId: id }).catch(() => {});
      unsubscribe();
      input.dispose();
      observer.disconnect();
      contrast.disconnect();
      term.dispose();
      terminal.current = null;
    };
  }, [workspace]);
  const open = async () => {
    setBusy(true);
    try {
      const result = await rpc.call<{
        ptyId: string;
        sandbox: { isolation: string };
      }>("pty.open", {
        workspacePath: workspace,
        cols: terminal.current?.cols,
        rows: terminal.current?.rows,
      });
      pty.current = result.ptyId;
      setStatus(t("sandbox_shell_0_010bb6", [result.sandbox.isolation]));
      terminal.current?.focus();
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    if (!command.trim() || busy) return;
    setBusy(true);
    setOutput("");
    const runId = crypto.randomUUID();
    const unsubscribe = rpc.subscribe(({ method, params }) => {
      if (method === "terminal.output" && params.runId === runId)
        setOutput((text) => (text + String(params.text)).slice(-100_000));
    });
    try {
      const result = await rpc.call<{ exitCode: number | null }>(
        "terminal.run",
        { workspacePath: workspace, command, runId },
      );
      setStatus(t("command_exited_0_8795b2", [result.exitCode]));
      void queryClient.invalidateQueries({ queryKey: ["problems.list"] });
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      unsubscribe();
      setBusy(false);
    }
  };
  return (
    <section className="tool-panel" aria-label={t("terminal_panel_bcdd89")}>
      <div className="toolbar">
        <h2>{t("terminal_e0926f")}</h2>
        <span role="status">{status}</span>
        <button
          disabled={!workspace || busy || !!pty.current}
          onClick={() => void open()}
        >
          {t("open_shell_2b9978")}</button>
        <button
          disabled={!pty.current}
          onClick={() => {
            if (pty.current) void rpc.call("pty.kill", { ptyId: pty.current });
          }}
        >
          {t("close_shell_478208")}</button>
      </div>
      <div ref={host} className="xterm-host" data-testid="terminal-host" />
      <form
        className="command-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <label htmlFor="command">{t("_09fc96")}</label>
        <input
          id="command"
          aria-label={t("command_713166")}
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder={t("run_a_sandboxed_command_76b861")}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.nativeEvent.isComposing || event.keyCode === 229)
            )
              event.preventDefault();
          }}
        />
        <button disabled={!workspace || busy || !command.trim()}>
          {t("run_command_940a94")}</button>
      </form>
      <pre className="command-output" role="region" tabIndex={0} aria-label={t("command_output_ff7a52")}>
        {output}
      </pre>
      <p className="hint">
        {t("user_pty_is_separate_from_agent_execution_all_2e9332")}</p>
    </section>
  );
}
