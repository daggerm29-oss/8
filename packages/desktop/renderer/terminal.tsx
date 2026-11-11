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
  const [status, setStatus] = useState("No shell open");
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
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    terminal.current = term;
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
        setStatus(`Shell exited (${params.exitCode})`);
      }
    });
    return () => {
      const id = pty.current;
      pty.current = null;
      if (id) void rpc.call("pty.kill", { ptyId: id }).catch(() => {});
      unsubscribe();
      input.dispose();
      observer.disconnect();
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
      setStatus(`Sandbox shell · ${result.sandbox.isolation}`);
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
      setStatus(`Command exited ${result.exitCode}`);
      void queryClient.invalidateQueries({ queryKey: ["problems.list"] });
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      unsubscribe();
      setBusy(false);
    }
  };
  return (
    <section className="tool-panel" aria-label="Terminal panel">
      <div className="toolbar">
        <h2>Terminal</h2>
        <span role="status">{status}</span>
        <button
          disabled={!workspace || busy || !!pty.current}
          onClick={() => void open()}
        >
          Open shell
        </button>
        <button
          disabled={!pty.current}
          onClick={() => {
            if (pty.current) void rpc.call("pty.kill", { ptyId: pty.current });
          }}
        >
          Close shell
        </button>
      </div>
      <div ref={host} className="xterm-host" data-testid="terminal-host" />
      <form
        className="command-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <label htmlFor="command">$</label>
        <input
          id="command"
          aria-label="Command"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="Run a sandboxed command"
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.nativeEvent.isComposing || event.keyCode === 229)
            )
              event.preventDefault();
          }}
        />
        <button disabled={!workspace || busy || !command.trim()}>
          Run command
        </button>
      </form>
      <pre className="command-output" aria-label="Command output">
        {output}
      </pre>
      <p className="hint">
        User PTY is separate from agent execution. All commands run inside the
        workspace sandbox.
      </p>
    </section>
  );
}
