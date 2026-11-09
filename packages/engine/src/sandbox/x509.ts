import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';

/* Minimal DER encoder: just enough X.509 v3 for a per-sandbox CA and per-host leaf certificates (§16.6). */
const len = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, ...parts: Buffer[]): Buffer => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const set = (...p: Buffer[]) => tlv(0x31, ...p);
const int = (b: Buffer) => tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0]));
const octet = (b: Buffer) => tlv(0x04, b);
const bits = (b: Buffer, unused = 0) => tlv(0x03, Buffer.from([unused]), b);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const ctx = (n: number, b: Buffer, constructed = true) => tlv((constructed ? 0xa0 : 0x80) | n, b);
function oid(s: string): Buffer {
  const [a, b, ...rest] = s.split('.').map(Number);
  const out = [a * 40 + b];
  for (const v of rest) {
    const chunk: number[] = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) chunk.unshift((x & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
function time(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0');
  const body = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(body));
}
const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const ext = (id: string, critical: boolean, value: Buffer) => seq(oid(id), ...(critical ? [bool(true)] : []), octet(value));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

export interface CertKey { cert: string; key: string; der: Buffer }

const pem = (label: string, der: Buffer) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;

function build(opts: { subject: string; issuer: string; pub: KeyObject; signer: KeyObject; extensions: Buffer[]; days: number }): Buffer {
  const now = Date.now();
  const tbs = seq(
    ctx(0, int(Buffer.from([2]))),
    int(Buffer.concat([Buffer.from([0x01]), randomBytes(15)])),
    ECDSA_SHA256,
    name(opts.issuer),
    seq(time(new Date(now - 3600_000)), time(new Date(now + opts.days * 86400_000))),
    name(opts.subject),
    opts.pub.export({ type: 'spki', format: 'der' }),
    ctx(3, seq(...opts.extensions)),
  );
  return seq(tbs, ECDSA_SHA256, bits(sign('sha256', tbs, { key: opts.signer, dsaEncoding: 'der' })));
}

const keyId = (pub: KeyObject) => createHash('sha1').update(pub.export({ type: 'spki', format: 'der' })).digest();

export class CertAuthority {
  readonly cert: string;
  private readonly key: KeyObject;
  private readonly pub: KeyObject;
  private readonly leaves = new Map<string, CertKey>();

  constructor(commonName: string) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    this.pub = publicKey;
    const der = build({ subject: commonName, issuer: commonName, pub: publicKey, signer: privateKey, days: 30, extensions: [
      ext('2.5.29.19', true, seq(bool(true), int(Buffer.from([0])))),
      ext('2.5.29.15', true, bits(Buffer.from([0x06]), 1)),
      ext('2.5.29.14', false, octet(keyId(publicKey))),
    ] });
    this.commonName = commonName;
    this.cert = pem('CERTIFICATE', der);
  }

  readonly commonName: string;

  /** Leaf certificate for `host` (DNS name or IP), cached per authority. */
  leaf(host: string): CertKey {
    const hit = this.leaves.get(host);
    if (hit) return hit;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const v = isIP(host);
    const san = v ? ctx(7, Buffer.from(v === 4 ? host.split('.').map(Number) : []), false) : ctx(2, Buffer.from(host), false);
    const der = build({ subject: host, issuer: this.commonName, pub: publicKey, signer: this.key, days: 7, extensions: [
      ext('2.5.29.17', false, seq(san)),
      ext('2.5.29.19', true, seq()),
      ext('2.5.29.15', true, bits(Buffer.from([0x80]), 7)),
      ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      ext('2.5.29.35', false, seq(ctx(0, keyId(this.pub), false))),
    ] });
    const out = { cert: pem('CERTIFICATE', der), key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, der };
    this.leaves.set(host, out);
    return out;
  }
}
