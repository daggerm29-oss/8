import type { Db } from "../storage/db.ts";
import { parseDiagnostics, type Diagnostic } from "../diagnostics/parsers.ts";
import { globalRedactor } from "../util/redact.ts";

export function recordTerminalProblems(
  db: Db,
  ws: string,
  command: string,
  output: string,
) {
  const diagnostics = parseDiagnostics(command, globalRedactor.redact(output));
  db.run(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
    `workbench.problems:${ws}`,
    JSON.stringify(diagnostics),
  );
  return diagnostics;
}

export function listProblems(db: Db, ws: string): Diagnostic[] {
  const terminal = db.get<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    `workbench.problems:${ws}`,
  );
  const diagnostics: Diagnostic[] = terminal ? JSON.parse(terminal.value) : [];
  const latest = new Set<string>();
  const rows = db.all<{ task: string; data_json: string }>(
    "SELECT task, data_json FROM events WHERE ws = ? AND topic = 'verify.gate' ORDER BY seq DESC LIMIT 1000",
    ws,
  );
  for (const row of rows) {
    const gate = JSON.parse(row.data_json) as {
      gate: string;
      diagnostics?: Diagnostic[];
    };
    const key = `${row.task}:${gate.gate}`;
    if (latest.has(key)) continue;
    latest.add(key);
    diagnostics.push(...(gate.diagnostics ?? []));
  }
  const unique = new Map<string, Diagnostic>();
  for (const diagnostic of diagnostics)
    unique.set(JSON.stringify(diagnostic), diagnostic);
  return [...unique.values()];
}
