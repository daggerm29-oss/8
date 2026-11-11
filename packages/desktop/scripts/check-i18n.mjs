import ts from 'typescript';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { I18nLabelDefaults } from 'flexlayout-react';

const root = fileURLToPath(new URL('../renderer/', import.meta.url));
const extract = process.argv.includes('--extract');
const catalogPath = join(root, 'messages.ts');
const catalog = extract ? JSON.parse(readFileSync(catalogPath, 'utf8').match(/= (\{[\s\S]*\}) as const;/)?.[1] ?? '{}') : {};
const violations = [];
const attributes = new Set(['aria-label', 'aria-description', 'title', 'placeholder', 'alt']);
const technical = new Set(['Mac', 'Mod', 'Ctrl', 'Meta', 'Alt', 'Shift', 'Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'Control', 'Tab', 'UTF-8', 'Build', 'Debug', 'Review', 'Explore']);
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
function jsxText(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  return decode(lines.map((line, i) => {
    let value = line.replace(/\t/g, ' ');
    if (i > 0) value = value.replace(/^ +/, '');
    if (i < lines.length - 1) value = value.replace(/ +$/, '');
    return value && i < lines.length - 1 ? value + ' ' : value;
  }).join(''));
}
function human(text) {
  return /[A-Za-z]/.test(text) && !technical.has(text) && (/\s/.test(text) || /^[A-Z][a-z]/.test(text)) && !/^(https?:|helix:|\.|#|\[|Mod\+|Control\+|Meta\+)/.test(text);
}
for (const name of readdirSync(root).filter((name) => /\.(tsx?|jsx?)$/.test(name) && !['messages.ts', 'i18n.ts'].includes(name))) {
  const path = join(root, name);
  const source = readFileSync(path, 'utf8');
  const tree = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, name.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits = [];
  function replace(node, text, jsx = false, params) {
    if (!text.trim()) return;
    const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
    violations.push(`${name}:${line}: ${text}`);
    if (!extract) return;
    const key = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 45).replace(/_$/, '') + '_' + createHash('sha256').update(text).digest('hex').slice(0, 6);
    catalog[key] = text;
    let call = `t(${JSON.stringify(key)}${params ? ', [' + params.join(', ') + ']' : ''})`;
    if (jsx) call = `{${call}}`;
    edits.push({ start: node.getStart(tree), end: node.getEnd(), text: call });
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node)) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') { node.arguments.slice(1).forEach(visit); return; }
    if (ts.isCallExpression(node) && ((ts.isIdentifier(node.expression) && node.expression.text === 'matchMedia') || (ts.isPropertyAccessExpression(node.expression) && ['querySelector', 'querySelectorAll'].includes(node.expression.name.text)))) return;
    if (ts.isJsxAttribute(node) && !attributes.has(node.name.getText(tree))) return;
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'fontFamily') return;
    if (ts.isJsxText(node)) { replace(node, jsxText(node.text), true); return; }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      if (ts.isJsxAttribute(parent)) {
        if (attributes.has(parent.name.getText(tree))) replace(node, decode(node.text), true);
        return;
      }
      if ((ts.isPropertyAssignment(parent) && parent.name === node) || ts.isElementAccessExpression(parent) || ts.isLiteralTypeNode(parent)) return;
      if (human(node.text)) replace(node, node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const text = node.head.text + node.templateSpans.map((span, i) => `{${i}}` + span.literal.text).join('');
      if (human(text)) {
        replace(node, text, false, node.templateSpans.map((span) => span.expression.getText(tree)));
        return;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  if (extract && edits.length) {
    let result = source;
    for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
    if (!source.includes('from "./i18n"') && !source.includes("from './i18n'")) result = 'import { t } from "./i18n";\n' + result;
    writeFileSync(path, result);
  }
}
if (extract) {
  const used = new Set(readdirSync(root).filter((name) => /\.tsx?$/.test(name) && name !== 'messages.ts').flatMap((name) => [...readFileSync(join(root, name), 'utf8').matchAll(/\bt\(["']([^"']+)["']/g)].map((match) => match[1])));
  for (const key of Object.keys(catalog)) if (!used.has(key) && !(key in I18nLabelDefaults)) delete catalog[key];
  Object.assign(catalog, I18nLabelDefaults);
  writeFileSync(catalogPath, 'export const messages = ' + JSON.stringify(catalog, null, 2) + ' as const;\n');
  console.log(`Extracted ${violations.length} messages (${Object.keys(catalog).length} unique catalog entries)`);
} else {
  for (const violation of violations) console.error(violation);
  console.log(`${violations.length} hard-coded UI strings outside the message catalog`);
  process.exitCode = violations.length ? 1 : 0;
}
