#!/usr/bin/env node
// Runs a shell command, saves the full output to a log file, and prints only
// the exit code, failure lines and the last lines. Keeps long test/build/CI
// output out of an AI session's context. The exit code is passed through.
// Run: node scripts/quiet.mjs [--lines 40] [--timeout 900] "<shell command>"
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    lines: { type: 'string', default: '40' },
    timeout: { type: 'string', default: '900' },
    log: { type: 'string' },
  },
})
const command = positionals.join(' ')
if (!command) {
  console.error('usage: node scripts/quiet.mjs [--lines 40] [--timeout 900] "<shell command>"')
  process.exit(2)
}

const dir = join(tmpdir(), 'helix-logs')
mkdirSync(dir, { recursive: true })
const slug = command.replace(/[^a-z0-9]+/gi, '-').slice(0, 60).replace(/^-|-$/g, '')
const logPath = values.log ?? join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${slug}.log`)
const log = createWriteStream(logPath)
const started = Date.now()

const child = spawn('bash', ['-o', 'pipefail', '-c', command], { stdio: ['ignore', 'pipe', 'pipe'] })
child.stdout.pipe(log, { end: false })
child.stderr.pipe(log, { end: false })
const timer = setTimeout(() => {
  log.write(`\n[quiet] timeout after ${values.timeout}s, killing\n`)
  child.kill('SIGKILL')
}, Number(values.timeout) * 1000)

child.on('close', (code, signal) => {
  clearTimeout(timer)
  log.end(() => {
    const clip = (l) => (l.length > 300 ? `${l.slice(0, 300)} …[+${l.length - 300} chars]` : l)
    const lines = readFileSync(logPath, 'utf8').split('\n').map(clip)
    const failurePattern = /(^|\s)(not ok|fail(ed|ure)?|error|✖|✗|panic|timed? ?out)\b/i
    const failures = [...new Set(lines.filter((l) => failurePattern.test(l) && !/^\s*(✔|ok \d)/.test(l) && !/\b0 (fail|error)|\b(fail(ed|ures?)?|errors?)\s*[:=]?\s*0\b/i.test(l)))].slice(0, 25)
    const tail = lines.slice(-Number(values.lines))
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`[quiet] exit ${code ?? signal} in ${seconds}s — ${lines.length} lines — full log: ${logPath}`)
    if (failures.length) console.log(`[quiet] failure lines (first ${failures.length}):\n${failures.join('\n')}`)
    console.log(`[quiet] last ${tail.length} lines:\n${tail.join('\n')}`)
    process.exit(code ?? 1)
  })
})
