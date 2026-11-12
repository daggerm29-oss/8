import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Rule { re: RegExp; negate: boolean; dirOnly: boolean }

function globToRegex(glob: string, anchored: boolean): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i++; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}$`);
}

/** `.helixignore` matcher (FR-11): gitignore-style globs, `!` negation, trailing `/` for directories, last match wins. */
export class HelixIgnore {
  private readonly rules: Rule[] = [];

  constructor(text = '') {
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const negate = line.startsWith('!');
      if (negate) line = line.slice(1);
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      const anchored = line.startsWith('/') || line.includes('/');
      if (line.startsWith('/')) line = line.slice(1);
      if (line) this.rules.push({ re: globToRegex(line, anchored), negate, dirOnly });
    }
  }

  static load(root: string): HelixIgnore {
    const file = join(root, '.helixignore');
    return new HelixIgnore(existsSync(file) ? readFileSync(file, 'utf8') : '');
  }

  get empty(): boolean { return this.rules.length === 0; }

  /** True when the file, or any ancestor directory of it, is ignored. */
  ignores(path: string): boolean {
    if (this.rules.length === 0) return false;
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/');
      const isDir = i < parts.length;
      let ignored = false;
      for (const r of this.rules) if ((!r.dirOnly || isDir) && r.re.test(sub)) ignored = !r.negate;
      if (ignored) return true;
    }
    return false;
  }
}
