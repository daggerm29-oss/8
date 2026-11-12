import { blake3 } from '@noble/hashes/blake3';

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function blake3Hex(data: Uint8Array | string): string {
  const out = blake3(typeof data === 'string' ? new TextEncoder().encode(data) : data);
  let s = '';
  for (const b of out) s += HEX[b];
  return s;
}

/**
 * Merkle tree over the indexed files (§11.1): a file node is its BLAKE3 content hash, a directory node is the
 * BLAKE3 of its sorted `kind name hash` entries. The returned map holds every directory ('' is the root), so an
 * edit changes only the hashes along the edited path.
 */
export function merkleTree(files: Iterable<{ path: string; hash: string }>): Map<string, string> {
  const children = new Map<string, Map<string, string>>();
  const dirs = new Set<string>(['']);
  const put = (dir: string, name: string, entry: string) => {
    let m = children.get(dir);
    if (!m) children.set(dir, (m = new Map()));
    m.set(name, entry);
  };
  for (const f of files) {
    const i = f.path.lastIndexOf('/');
    const dir = i < 0 ? '' : f.path.slice(0, i);
    put(dir, f.path.slice(i + 1), `f ${f.hash}`);
    for (let d = dir; d !== ''; d = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '') dirs.add(d);
  }
  const out = new Map<string, string>();
  const depth = (d: string) => (d === '' ? 0 : d.split('/').length);
  const order = [...dirs].sort((a, b) => depth(b) - depth(a) || (a < b ? -1 : 1));
  for (const d of order) {
    const m = children.get(d) ?? new Map<string, string>();
    const lines = [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([n, e]) => `${e.startsWith('f ') ? 'f' : 'd'} ${n} ${e.slice(2)}`);
    const h = blake3Hex(lines.join('\n'));
    out.set(d, h);
    if (d !== '') {
      const i = d.lastIndexOf('/');
      put(i < 0 ? '' : d.slice(0, i), d.slice(i + 1), `d ${h}`);
    }
  }
  return out;
}
