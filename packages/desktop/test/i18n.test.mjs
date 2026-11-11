import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { I18nLabelDefaults } from 'flexlayout-react';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({ entryPoints: [root + 'renderer/i18n.ts'], bundle: true, format: 'esm', platform: 'node', write: false });
const i18n = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
globalThis.document = { documentElement: { lang: '', dir: '' } };
test('catalog fallback, interpolation, translated text, language/direction and locale-aware currency', () => {
  assert.equal(i18n.t('model_updated_to_0_1_7fbf52', ['provider', 'model']), 'Model updated to provider/model.');
  i18n.configureLocale('fr', { ready_5fa7aa: 'Prêt', model_updated_to_0_1_7fbf52: 'Modèle {1} chez {0}.' });
  assert.equal(i18n.t('ready_5fa7aa'), 'Prêt');
  assert.equal(i18n.t('model_updated_to_0_1_7fbf52', ['provider', 'model']), 'Modèle model chez provider.');
  assert.equal(i18n.t('save_1509f5'), 'Save');
  assert.match(i18n.formatMoney(1.25), /1,2500/);
  assert.equal(document.documentElement.lang, 'fr');
  i18n.configureLocale('ar'); assert.equal(document.documentElement.dir, 'rtl');
  i18n.configureLocale('en'); assert.equal(document.documentElement.dir, 'ltr');
});
test('every docking library label is externalized, not silently falling back to a raw key', () => {
  for (const [key, value] of Object.entries(I18nLabelDefaults)) assert.equal(i18n.dockLabel(key), value);
});
test('AST checker reports zero hard-coded renderer UI messages', () => {
  assert.match(execFileSync(process.execPath, [root + 'scripts/check-i18n.mjs'], { encoding: 'utf8' }), /0 hard-coded UI strings/);
});
