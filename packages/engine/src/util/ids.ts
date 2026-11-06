import { createHash, randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = 0;
let lastRandom: number[] = [];

/** Monotonic ULID (time-ordered, §23.1). */
export function ulid(now = Date.now()): string {
  let random: number[];
  if (now === lastTime) {
    random = lastRandom.slice();
    for (let i = random.length - 1; i >= 0; i--) {
      if (random[i] < 31) {
        random[i]++;
        break;
      }
      random[i] = 0;
    }
  } else {
    const bytes = randomBytes(16);
    random = Array.from({ length: 16 }, (_, i) => bytes[i] % 32);
  }
  lastTime = now;
  lastRandom = random;
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + random.map((r) => CROCKFORD[r]).join('');
}

export function prefixedId(prefix: string): string {
  return `${prefix}_${ulid().toLowerCase()}`;
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Stable JSON with sorted keys, used for canonical argument hashing (§15.2 duplicate elimination). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function hexId(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
