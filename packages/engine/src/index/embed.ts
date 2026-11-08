/**
 * Bundled local embedder (F-IDX-6 local-first, §12.3). Signed feature hashing of identifier words, their 5-char
 * prefixes, and character trigrams (common code keywords skipped) into a fixed-size L2-normalized vector: deterministic, offline, and cheap. It captures
 * subword/morphological similarity (`tokenization` ≈ `tokenizeSource`) that whole-token BM25 misses; it is not
 * a neural model. Model ID and dimension are stored with every vector so a future embedder can coexist.
 */
import { identifierTerms } from './extract.ts';

export const EMBED_MODEL = 'helix-local-hash-v1';
export const EMBED_DIM = 512;

const CODE_STOP = new Set(['export', 'import', 'function', 'return', 'const', 'let', 'var', 'string', 'number', 'boolean', 'void', 'null', 'undefined', 'true', 'false', 'new', 'this', 'class', 'def', 'self', 'func', 'pub', 'public', 'private', 'static', 'async', 'await', 'if', 'else', 'for', 'while', 'src', 'lib']);

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

function addFeature(v: Float32Array, feature: string, weight: number): void {
  const h = fnv1a(feature);
  v[h % EMBED_DIM] += h & 0x80000000 ? -weight : weight;
}

export function embed(text: string): Float32Array {
  const v = new Float32Array(EMBED_DIM);
  for (const term of identifierTerms(text).split(' ')) {
    if (!term || CODE_STOP.has(term)) continue;
    addFeature(v, `w:${term}`, 1);
    addFeature(v, `p:${term.slice(0, 5)}`, 1);
    const padded = `^${term}$`;
    for (let i = 0; i + 3 <= padded.length; i++) addFeature(v, `t:${padded.slice(i, i + 3)}`, 0.3);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < EMBED_DIM; i++) v[i] /= norm;
  return v;
}

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
}

export function fromBlob(b: Uint8Array): Float32Array {
  return new Float32Array(new Uint8Array(b).buffer);
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
