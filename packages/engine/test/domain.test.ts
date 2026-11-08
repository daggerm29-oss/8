import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Db } from '../src/storage/db.ts';
import { WorkspaceIndex } from '../src/index/index.ts';
import { domainMap } from '../src/tools/index-tools.ts';

const FILES: Record<string, string> = {
  'app/api/users/[id]/route.ts': 'export async function GET(req: Request) {\n  return Response.json({});\n}\nexport async function DELETE() {}\n',
  'app/(shop)/cart/page.tsx': 'export default function CartPage() {\n  return null;\n}\n',
  'server/index.ts': "const key = process.env.STRIPE_SECRET_KEY ?? 'sk_live_51HxDEADBEEF';\napp.get('/health', health);\nrouter.post('/orders', createOrder);\napp.delete(`/orders/:id`, (req, res) => res.end());\nconst url = import.meta.env.VITE_API_URL;\n",
  'api/main.py': "import os\nDB = os.environ.get('DATABASE_URL')\n\n@app.get('/items/{item_id}')\nasync def read_item(item_id: int):\n    return {}\n\n@bp.route('/login', methods=['GET', 'POST'])\ndef login():\n    return ''\n",
  'cmd/srv/main.go': 'package main\n\nfunc main() {\n\thttp.HandleFunc("/ping", ping)\n\tr.POST("/upload", uploadHandler)\n\t_ = os.Getenv("PORT")\n}\n',
  'prisma/schema.prisma': 'model User {\n  id    Int    @id\n  email String @unique\n  posts Post[]\n}\n\nmodel Post {\n  id     Int  @id\n  userId Int\n}\n',
  'db/001_init.sql': 'CREATE TABLE IF NOT EXISTS invoices (\n  id SERIAL PRIMARY KEY,\n  amount NUMERIC(10, 2) NOT NULL,\n  customer_id INT,\n  FOREIGN KEY (customer_id) REFERENCES customers(id)\n);\n',
  'src/db/schema.ts': "export const sessions = pgTable('sessions', {\n  id: text('id').primaryKey(),\n  userId: text('user_id'),\n  expiresAt: timestamp('expires_at'),\n});\n",
};

test('domain extractors: routes, tables, config keys (names only), incremental replace, domain_map tool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-domain-'));
  for (const [p, body] of Object.entries(FILES)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), body); }
  const db = new Db(':memory:');
  db.run(`INSERT INTO workspace (id, path, created_at) VALUES ('ws1', ?, 'now')`, dir);
  const idx = new WorkspaceIndex(db, 'ws1', dir);
  idx.update();
  const d = idx.domain();

  assert.deepEqual(d.routes.map((r) => `${r.method} ${r.path} ${r.handler} ${r.framework} ${r.file}:${r.line}`).sort(), [
    'DELETE /api/users/[id] DELETE next app/api/users/[id]/route.ts:4',
    'DELETE /orders/:id <inline> express server/index.ts:4',
    'GET /api/users/[id] GET next app/api/users/[id]/route.ts:1',
    'GET /cart CartPage next-page app/(shop)/cart/page.tsx:1',
    'GET /health health express server/index.ts:2',
    'GET /items/{item_id} read_item fastapi api/main.py:4',
    'GET /login login flask api/main.py:8',
    'POST /login login flask api/main.py:8',
    'POST /orders createOrder express server/index.ts:3',
    'POST /upload uploadHandler gin cmd/srv/main.go:5',
    'ANY /ping ping net/http cmd/srv/main.go:4',
  ].sort());

  assert.deepEqual(d.tables.map((t) => `${t.name}[${t.source}]:${t.columns.join(',')}@${t.file}:${t.line}`).sort(), [
    'invoices[sql]:id,amount,customer_id@db/001_init.sql:1',
    'Post[prisma]:id,userId@prisma/schema.prisma:7',
    'sessions[drizzle]:id,userId,expiresAt@src/db/schema.ts:1',
    'User[prisma]:id,email,posts@prisma/schema.prisma:1',
  ].sort());

  assert.deepEqual(d.config.map((c) => `${c.key}@${c.file}:${c.line}`), [
    'DATABASE_URL@api/main.py:2', 'PORT@cmd/srv/main.go:6', 'STRIPE_SECRET_KEY@server/index.ts:1', 'VITE_API_URL@server/index.ts:5',
  ]);
  const dump = JSON.stringify(db.all('SELECT * FROM idx_config')) + JSON.stringify(db.all('SELECT * FROM idx_routes')) + JSON.stringify(db.all('SELECT * FROM idx_tables'));
  assert.ok(!dump.includes('sk_live'), 'config values are never stored');

  writeFileSync(join(dir, 'server/index.ts'), "app.get('/v2/health', health);\n");
  idx.update();
  const after = idx.domain();
  assert.ok(after.routes.some((r) => r.path === '/v2/health') && !after.routes.some((r) => r.path === '/health' || r.path === '/orders'), 'edited file rows replaced');
  assert.ok(!after.config.some((c) => c.key === 'STRIPE_SECRET_KEY'));

  const out = await domainMap.run({}, { index: idx } as never);
  assert.match(out.content, /GET \/v2\/health → health {2}\[express\] server\/index\.ts:1/);
  assert.match(out.content, /invoices \(id, amount, customer_id\) {2}\[sql\] db\/001_init\.sql:1/);
  assert.match(out.content, /DATABASE_URL {2}api\/main\.py:2/);
  const routesOnly = await domainMap.run({ kind: 'routes' }, { index: idx } as never);
  assert.ok(!routesOnly.content.includes('## Tables'));
});
