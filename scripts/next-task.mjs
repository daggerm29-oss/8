#!/usr/bin/env node
// Builds CURRENT_TASK.md: a small, self-contained context packet for the next
// roadmap tasks so a build session does not have to read the large planning
// documents. It copies text verbatim from plan.md, architecture.md, docs/roadmap.md
// and progress.md; it never summarises, narrows, or reorders scope.
// Run: node scripts/next-task.mjs [--count 3] [--out CURRENT_TASK.md] [--stdout]
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const requirementPattern = /\b(?:FR-\d+|F-[A-Z]+-\d+|NFR-\d+|SEC-\d+|PERF-\d+)\b/g
const SECTION_LIMIT = 14000

export function parseRoadmap(text) {
  const milestones = []
  let item = null
  for (const line of text.split('\n')) {
    const heading = line.match(/^## (M\d+)\s*[—-]\s*(.+)$/)
    if (heading) {
      milestones.push({ id: heading[1], name: heading[2].trim(), items: [] })
      item = null
      continue
    }
    if (/^## /.test(line)) {
      item = null
      milestones.push({ id: null, items: [] })
      continue
    }
    const milestone = milestones.at(-1)
    const box = line.match(/^- \[( |x|X)\] (.+)$/)
    if (box && milestone?.id) {
      item = {
        ticked: box[1] !== ' ',
        title: box[2].replace(/\*\*/g, '').split(' — ')[0].trim(),
        lines: [line],
        evidence: false,
        blocked: false,
        stuck: false,
      }
      milestone.items.push(item)
    } else if (item && /^\s+\S/.test(line)) {
      item.lines.push(line)
      if (/^\s+- Evidence:\s*\S/.test(line)) item.evidence = true
      if (/^\s+- Blocked:/.test(line)) item.blocked = true
      if (/^\s+- Stuck:/.test(line)) item.stuck = true
    } else if (/^\S/.test(line)) {
      item = null
    }
  }
  const real = milestones.filter((m) => m.id)
  const firstIncomplete = real.find((m) => m.items.some((i) => !(i.ticked && i.evidence)))
  const executionId = text.match(/^<!-- execution-milestone: (M\d+) -->$/m)?.[1]
  const current =
    (executionId && real.find((m) => m.id === executionId && m.items.some((i) => !(i.ticked && i.evidence)))) ||
    firstIncomplete
  return { milestones: real, current }
}

export function selectTasks(milestone, count) {
  const open = milestone.items.filter((i) => !(i.ticked && i.evidence))
  const fresh = open.filter((i) => !i.blocked && !i.stuck)
  return {
    next: fresh.slice(0, count),
    stuck: open.filter((i) => i.stuck && !i.blocked),
    blocked: open.filter((i) => i.blocked),
    remaining: open.length,
  }
}

export function planRow(plan, id) {
  const lines = plan.split('\n')
  const tableRow = lines.findIndex((l) => l.startsWith(`| ${id} |`))
  if (tableRow !== -1) {
    let top = tableRow
    while (top > 0 && lines[top - 1].startsWith('|')) top--
    return [lines[top], lines[top + 1], lines[tableRow]].join('\n')
  }
  const listItem = lines.find((l) => l.startsWith(`- ${id} `))
  if (listItem) return listItem
  const start = lines.findIndex((l) => l.startsWith(`**${id} `) || l.startsWith(`**${id}**`) || l.startsWith(`- **${id} `))
  if (start === -1) return null
  const out = []
  for (let i = start; i < lines.length; i++) {
    if (i > start && (lines[i].trim() === '' || /^(\*\*|- \*\*|#)/.test(lines[i]))) break
    out.push(lines[i])
  }
  return out.join('\n')
}

export function architectureSection(architecture, ref) {
  const lines = architecture.split('\n')
  const escaped = ref.replace(/\./g, '\\.')
  const headingPattern = new RegExp(`^(#{2,6}) ${escaped}(?:\\.)?(?:\\s|$)`)
  const start = lines.findIndex((l) => headingPattern.test(l))
  if (start === -1) return null
  const level = lines[start].match(/^#+/)[0].length
  const out = [lines[start]]
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#+) /)
    if (h && h[1].length <= level) break
    out.push(lines[i])
  }
  let text = out.join('\n').trimEnd()
  if (text.length > SECTION_LIMIT) {
    text = `${text.slice(0, SECTION_LIMIT)}\n\n> [truncated at ${SECTION_LIMIT} chars; read the rest with: grep -n "^#.* ${ref}" architecture.md]`
  }
  return text
}

export function expandIdRange(prefix, from, to) {
  const start = Number(from)
  const end = Number(to)
  if (!(end >= start) || end - start > 50) return [`${prefix}${from}`]
  return Array.from({ length: end - start + 1 }, (_, i) => `${prefix}${start + i}`)
}

export function expandSectionRange(from, to) {
  const a = from.split('.')
  const b = to.split('.')
  if (b.length === 1 && a.length > 1) b.unshift(...a.slice(0, a.length - 1))
  if (a.length !== b.length || a.slice(0, -1).join('.') !== b.slice(0, -1).join('.')) return [from, to]
  const base = a.slice(0, -1)
  return expandIdRange('', a.at(-1), b.at(-1)).map((n) => [...base, n].join('.'))
}

export function citations(item) {
  const head = item.lines[0]
  const ids = new Set(head.match(requirementPattern) ?? [])
  for (const [, prefix, from, to] of head.matchAll(/\b([OX])(\d+)(?:\s*[–-]\s*\1?(\d+))?\b/g)) {
    for (const id of to ? expandIdRange(prefix, from, to) : [`${prefix}${from}`]) ids.add(id)
  }
  const bracket = head.match(/\[([^\]]*§[^\]]*)\]/)?.[1] ?? ''
  const sections = new Set()
  for (const [, from, to] of bracket.matchAll(/(\d+(?:\.\d+)*)(?:\s*[–-]\s*§?(\d+(?:\.\d+)*))?/g)) {
    for (const ref of to ? expandSectionRange(from, to) : [from]) sections.add(ref)
  }
  return { ids: [...ids], sections: [...sections] }
}

function section(text, title) {
  const match = text.match(new RegExp(`^## ${title}[^\\n]*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'))
  return match?.[1].trim() ?? ''
}

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }).trim()
  } catch {
    return ''
  }
}

export function buildPacket({ roadmap, plan, architecture, progress, git = {}, count = 3 }) {
  const { current } = parseRoadmap(roadmap)
  if (!current) return '# CURRENT_TASK\n\nAll roadmap milestones are complete. Report to the user and stop.\n'
  const { next, stuck, blocked, remaining } = selectTasks(current, count)
  const statusRows = roadmap.split('\n').filter((l) => /^\| (?:FR-\d+|F-[A-Z]+-\d+|NFR-\d+|SEC-\d+|PERF-\d+) \|/.test(l))
  const tableHeader = roadmap.split('\n').find((l) => /^\| ID \|/.test(l)) ?? '| ID | Milestone | Status | Audit | Tasks | Gap |'

  const out = []
  out.push('# CURRENT_TASK (generated — do not edit, do not commit)')
  out.push('')
  out.push(
    '> Generated by `node scripts/next-task.mjs` from `docs/roadmap.md`, `plan.md`, `architecture.md` and `progress.md`. Text below is copied verbatim; the source documents stay authoritative (AGENTS.md §0). Regenerate after every completed task.',
  )
  out.push('')
  out.push(`- Current milestone: **${current.id} ${current.name}** — ${remaining} open items (tasks + exit gates)`)
  if (git.branch) out.push(`- Branch: \`${git.branch}\``)
  if (git.pr) out.push(`- Open session PRs:\n${git.pr.split('\n').map((l) => `  - ${l}`).join('\n')}`)
  if (git.log) out.push(`- Recent commits:\n${git.log.split('\n').map((l) => `  - ${l}`).join('\n')}`)
  out.push('')
  if (git.ci !== undefined) {
    out.push('## Latest CI on this branch', '', git.ci || 'Unavailable: `gh` CLI not authenticated or no runs found. Check with `node scripts/quiet.mjs "gh run list -L 3"` if the task depends on CI.', '')
  }

  const notes = section(progress, 'Current task notes')
  if (notes) {
    out.push('## Resume notes (progress.md → Current task notes)', '', notes, '')
  }

  if (next.length === 0) {
    out.push('## No fresh tasks', '', 'Every open item is Blocked or Stuck. Retry the Stuck items below (fresh approach), or end the session (AGENTS.md §5).', '')
  }

  next.forEach((item, index) => {
    const { ids, sections } = citations(item)
    out.push(`## Task ${index + 1} of ${next.length}: ${item.title}`, '')
    out.push('### Roadmap item (docs/roadmap.md)', '', '```md', ...item.lines, '```', '')
    if (ids.length) {
      out.push('### Requirements (plan.md, verbatim — full acceptance criterion applies)', '')
      for (const id of ids) out.push(planRow(plan, id) ?? `- ${id}: not found by heading; run \`grep -n "${id}" plan.md\``, '')
      const rows = statusRows.filter((r) => ids.some((id) => r.startsWith(`| ${id} |`)))
      if (rows.length) out.push('### Requirement status rows (docs/roadmap.md)', '', tableHeader, tableHeader.replace(/[^|]+/g, ' --- '), ...rows, '')
    }
    for (const ref of sections) {
      const text = architectureSection(architecture, ref)
      out.push(`### architecture.md §${ref}`, '', text ?? `Not found; run \`grep -n "^#.* ${ref}" architecture.md\``, '')
    }
  })

  const gates = current.items.filter((i) => /^G\d+\.\d+/.test(i.title) && !(i.ticked && i.evidence))
  if (gates.length) {
    out.push(`## Open exit gates for ${current.id} (still required)`, '', ...gates.map((g) => `- ${g.lines[0].replace(/^- \[.\] /, '')}`), '')
  }
  if (stuck.length) {
    out.push('## Stuck tasks (open; retry with a different approach after fresh tasks)', '', ...stuck.flatMap((i) => i.lines), '')
  }
  if (blocked.length) {
    out.push('## Blocked tasks (open; need a runner, hardware or keys)', '', ...blocked.map((i) => `- ${i.title}`), '')
  }
  return `${out.join('\n').trimEnd()}\n`
}

export function summarizeFailedLog(log, maxLines = 25) {
  const lines = log.split('\n').map((l) => l.replace(/^[^\t]*\t[^\t]*\t(?:\S+Z )?/, '').slice(0, 240))
  const marked = lines.filter((l) => /(##\[error\]|not ok|✖|Error:|ERR!|FAIL|failed)/i.test(l))
  return [...new Set(marked.length ? marked : lines.slice(-maxLines))].slice(0, maxLines)
}

function ciSummary(branch, root) {
  if (!branch) return ''
  const json = run('gh', ['run', 'list', '--branch', branch, '-L', '5', '--json', 'databaseId,workflowName,conclusion,status,headSha,url'], root)
  if (!json) return ''
  let runs
  try {
    runs = JSON.parse(json).filter((r) => r.conclusion !== 'skipped')
  } catch {
    return ''
  }
  if (!runs.length) return ''
  const latest = runs[0]
  const out = [`- ${latest.workflowName}: **${latest.conclusion || latest.status}** at \`${latest.headSha.slice(0, 7)}\` — ${latest.url}`]
  if (latest.conclusion === 'failure') {
    const log = run('gh', ['run', 'view', String(latest.databaseId), '--log-failed'], root)
    if (log) out.push('', 'Failure lines (`gh run view --log-failed`, filtered):', '', '```text', ...summarizeFailedLog(log), '```')
    else out.push('- Failure log unavailable; run `node scripts/quiet.mjs "gh run view ' + latest.databaseId + ' --log-failed"`.')
  }
  return out.join('\n')
}

function main() {
  const { values } = parseArgs({
    options: {
      count: { type: 'string', default: '3' },
      out: { type: 'string', default: 'CURRENT_TASK.md' },
      stdout: { type: 'boolean', default: false },
      root: { type: 'string' },
    },
  })
  const root = values.root ?? join(dirname(fileURLToPath(import.meta.url)), '..')
  const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : '')
  const git = {
    branch: run('git', ['branch', '--show-current'], root),
    log: run('git', ['log', '--oneline', '-5'], root),
    pr: run('gh', ['pr', 'list', '--state', 'open', '--search', 'head:helix/session-', '--json', 'number,headRefName,baseRefName,url', '--template', '{{range .}}#{{.number}} {{.headRefName}} → {{.baseRefName}} {{.url}}{{"\\n"}}{{end}}'], root),
  }
  git.ci = ciSummary(git.branch, root)
  const packet = buildPacket({
    roadmap: read('docs/roadmap.md'),
    plan: read('plan.md'),
    architecture: read('architecture.md'),
    progress: read('progress.md'),
    git,
    count: Math.max(1, Number.parseInt(values.count, 10) || 3),
  })
  if (values.stdout) process.stdout.write(packet)
  else {
    writeFileSync(join(root, values.out), packet)
    const titles = packet.match(/^## Task \d+ of \d+: .+$/gm) ?? []
    console.log(`Wrote ${values.out} (${packet.length} chars, ~${Math.round(packet.length / 4)} tokens)`)
    for (const t of titles) console.log(`  ${t.replace(/^## /, '')}`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
