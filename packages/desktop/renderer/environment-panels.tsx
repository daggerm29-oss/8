import { useState } from 'react';
import { rpc, queryClient, useRpc } from './rpc';
import { useWorkbench, type Diagnostic } from './state';
import { openFile } from './explorer';

export function PreviewPanel() {
  const workspace = useWorkbench((state) => state.workspace);
  const [url, setUrl] = useState('');
  const [message, setMessage] = useState('No development server running');
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true); setMessage('Starting sandboxed development server…');
    try { const result = await rpc.call<{ url: string }>('preview.start', { workspacePath: workspace }); setUrl(result.url); setMessage(result.url); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="tool-panel preview-panel" aria-label="Application preview"><div className="toolbar"><h2>Preview</h2><button disabled={!workspace || busy} onClick={() => void start()}>Start preview</button>{url && <button onClick={() => { const frame = document.querySelector<HTMLIFrameElement>('#application-preview'); if (frame) frame.src = url; }}>Reload preview</button>}</div><p className="hint" role="status">{message}</p>{url ? <iframe id="application-preview" title="Application preview" src={url} sandbox="allow-scripts allow-forms allow-same-origin" /> : <div className="empty-state">Start the workspace application in its sandbox.</div>}</section>;
}
type GitStatus = { isRepo: boolean; branch: string; files: { path: string; index: string; worktree: string }[] };
export function ScmPanel() {
  const workspace = useWorkbench((state) => state.workspace);
  const status = useRpc<GitStatus>('git.status', { workspacePath: workspace }, !!workspace);
  const diff = useRpc<{ staged: string; unstaged: string }>('git.diff', { workspacePath: workspace }, !!workspace && status.data?.isRepo === true);
  const [message, setMessage] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  const act = async (method: string) => {
    setBusy(true);
    try { const response = await rpc.call<{ sha?: string }>(method, { workspacePath: workspace, message }); setResult(response.sha ? `Committed ${response.sha}` : 'Changes staged'); void queryClient.invalidateQueries({ queryKey: ['git.status'] }); void queryClient.invalidateQueries({ queryKey: ['git.diff'] }); }
    catch (error) { setResult((error as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="tool-panel" aria-label="Source control panel"><div className="toolbar"><h2>Source control</h2><span>{status.data?.branch || 'No repository'}</span><button disabled={busy || !status.data?.isRepo} onClick={() => void act('git.stageAll')}>Stage all</button><button onClick={() => { void status.refetch(); void diff.refetch(); }} disabled={!workspace}>Refresh source control</button></div>{status.error && <p role="alert">{status.error.message}</p>}<ul className="changed-files">{status.data?.files.map((file) => <li key={file.path}><code>{file.index}{file.worktree}</code><button onClick={() => void openFile(file.path)}>{file.path}</button></li>)}</ul><form className="command-form" onSubmit={(event) => { event.preventDefault(); void act('git.commit'); }}><input aria-label="Commit message" placeholder="Describe the change" value={message} onChange={(event) => setMessage(event.target.value)} /><button disabled={!status.data?.isRepo || !message.trim() || busy}>Commit staged</button></form><p role="status">{result}</p><pre className="diff-output" aria-label="Source control diff">{diff.data?.staged}{diff.data?.unstaged}</pre></section>;
}
export function ProblemsPanel() {
  const workspace = useWorkbench((state) => state.workspace);
  const problems = useRpc<Diagnostic[]>('problems.list', { workspacePath: workspace }, !!workspace);
  return <section className="tool-panel" aria-label="Problems panel"><div className="toolbar"><h2>Problems</h2><span>{problems.data?.length ?? 0} diagnostics</span><button disabled={!workspace} onClick={() => void problems.refetch()}>Refresh problems</button></div>{problems.error && <p role="alert">{problems.error.message}</p>}{problems.data?.length ? <ul className="problems-list">{problems.data.map((problem, index) => <li key={index}><span className="problem-severity">{problem.severity}</span><button disabled={!problem.file} onClick={() => problem.file && void openFile(problem.file, problem.line)}>{problem.file || problem.source}:{problem.line || 1}</button><span>{problem.code} {problem.message}</span></li>)}</ul> : <div className="empty-state">No reported problems. Run verification or a command to collect diagnostics.</div>}</section>;
}
