import { connect } from 'node:net';

/** CONNECT through a proxy socket; resolves with the status line. 403 = denied by policy, 502 = allowed (`.invalid` never resolves). */
export function connectVia(sock: string, target: string): Promise<string> {
  return new Promise((resolve) => {
    const c = connect(sock, () => c.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let buf = '';
    c.on('data', (d) => { buf += d; if (buf.includes('\r\n')) { c.destroy(); resolve(buf.split('\r\n')[0]); } });
    c.on('error', () => resolve(buf || 'error'));
    c.on('close', () => resolve(buf.split('\r\n')[0] || 'closed'));
  });
}
