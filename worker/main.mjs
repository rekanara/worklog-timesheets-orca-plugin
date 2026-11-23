// Worklog worker.
// Agents write one note per finished task to <workspace>/.worklog/*.md. The worker moves each
// note into the plugin's private store (worktrees get deleted), and adds the person's own Git
// commits as a fallback. Entries are stored per month: entries:YYYY-MM.
import { readdir, readFile, unlink, stat, appendFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import path from 'node:path'

const NOTES_DIR = '.worklog'
const SCAN_MS = 15_000
const COMMIT_SCAN_MS = 5 * 60_000
const FIRST_COMMIT_DAYS = 62
const MAX_NOTE_BYTES = 32 * 1024
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

const pad = (n) => String(n).padStart(2, '0')
export const dayOf = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const monthOf = (day) => day.slice(0, 7)
export const slug = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project'
const newId = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

function fail(code, message) {
  return Object.assign(new Error(message), { code })
}

// Hours worked on one entry: '' or 0 clears it; accepts "1,5" as well as 1.5.
export function parseHours(v) {
  if (v === '' || v == null) return null
  const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'))
  if (!Number.isFinite(n) || n < 0 || n > 24) throw fail('invalid_params', 'hours must be between 0 and 24')
  return n ? Math.round(n * 100) / 100 : null
}
// An entry read from a backup file: keep only known fields with sane types, or drop it (null).
export function cleanEntry(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !x.id || x.id.length > 64) return null
  if (!DATE_RE.test(x.date ?? '') || typeof x.text !== 'string' || !x.text.trim()) return null
  if (!['agent', 'me', 'commit'].includes(x.source)) return null
  const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null)
  const hash = str(x.hash, 40)
  if (x.source === 'commit' && !hash) return null
  let hours = null
  try { hours = parseHours(x.hours) } catch {}
  const [y, mo, d] = x.date.split('-').map(Number)
  return {
    id: x.id,
    date: x.date,
    at: Number.isFinite(x.at) ? x.at : new Date(y, mo - 1, d, 12).getTime(),
    source: x.source,
    ...(x.source === 'commit' ? { hash } : {}),
    repo: str(x.repo, 1024),
    projectId: str(x.projectId, 200),
    projectName: str(x.projectName, 200),
    area: str(x.area, 60),
    text: x.text.trim().slice(0, 300),
    hours,
    details: Array.isArray(x.details) ? x.details.filter((t) => typeof t === 'string').slice(0, 5).map((t) => t.slice(0, 300)) : [],
    branch: str(x.branch, 200),
    ...(x.hidden === true ? { hidden: true } : {})
  }
}
const BACKUP_FORMAT = 'worklog-backup'
const MAX_BACKUP_CHARS = 50 * 1024 * 1024

export const sumHours =(list) => Math.round(list.reduce((t, e) => t + (e.hours || 0), 0) * 100) / 100

// A commit is noise once the same day and project already has a written note (agent or manual).
const coverKey = (e) => `${e.date}|${e.projectId ?? e.projectName ?? ''}`
export function visible(list, includeCommits) {
  const shown = list.filter((e) => !e.hidden && (includeCommits || e.source !== 'commit'))
  const written = new Set(shown.filter((e) => e.source !== 'commit').map(coverKey))
  return shown.filter((e) => e.source !== 'commit' || !written.has(coverKey(e)))
}

export function protocol(lang) {
  const language = lang === 'id' ? 'Indonesian (Bahasa Indonesia)' : 'English'
  return `Work log (Worklog):
When you finish a task, or stop partway, record what was done in one short note so it reaches my timesheet.
- Create one file per task at .worklog/<short-slug>.md in the root of the current workspace.
- First line: "# " followed by one sentence in the past tense saying what was done, in ${language}, written for a manager rather than a developer ("# Added email format validation to sign-up").
- Second line: "area: " and the part of the product it touched, in one or two words ("area: checkout", "area: auth", "area: landing page").
- Optional: up to three "- " lines with notable details or results.
- Write it once per task, never commit the .worklog folder, and never edit notes you did not write. Orca collects them automatically.`
}

export function parseNote(text, fileName) {
  let src = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  const meta = {}
  const fm = src.match(/^---\n([\s\S]*?)\n---\n?/)
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/)
      if (m) meta[m[1].toLowerCase()] = m[2].replace(/^["']|["']$/g, '')
    }
    src = src.slice(fm[0].length)
  }
  let title = meta.title
  let area = meta.area
  const details = []
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (!title) { title = line.replace(/^#+\s*/, ''); continue }
    const a = line.match(/^(area|bagian)\s*:\s*(.+)$/i)
    if (a && !area) { area = a[2]; continue }
    details.push(line.replace(/^[-*]\s*/, ''))
  }
  if (!title) title = fileName.replace(/\.(md|txt)$/i, '').replace(/[-_]+/g, ' ')
  return {
    text: title.slice(0, 300),
    area: (area || '').trim().slice(0, 60) || null,
    details: details.slice(0, 5).map((d) => d.slice(0, 300))
  }
}

// Turn a branch name into an area: "feature/checkout-v2" -> "checkout v2".
export function areaFromBranch(branch) {
  if (!branch || /^(main|master|develop|dev|trunk)$/.test(branch)) return null
  const last = branch.replace(/^(feature|feat|fix|bugfix|hotfix|chore|refactor|docs|test)[/-]/i, '').split('/').pop()
  const words = last.replace(/[-_]+/g, ' ').replace(/\b\d{2,}\b/g, '').trim()
  return words ? words.slice(0, 40) : null
}

// Most common meaningful folder in a commit's paths: "lib/features/checkout/x.dart" -> "checkout".
const SKIP = new Set(['src', 'lib', 'app', 'apps', 'packages', 'pkg', 'internal', 'cmd', 'features', 'feature', 'modules', 'module', 'components', 'pages', 'screens', 'views', 'routes', 'test', 'tests', '__tests__', 'spec', 'main', 'java', 'kotlin', 'com', 'web', 'public', 'assets', 'resources', 'core', 'shared', 'common', 'ui'])
export function areaFromPaths(paths) {
  const count = new Map()
  for (const p of paths) {
    const parts = p.split('/').slice(0, -1).filter((s) => !s.startsWith('.'))
    const stem = (p.split('/').pop() || '').replace(/\.[^.]+$/, '')
    const pick = parts.find((s) => !SKIP.has(s.toLowerCase())) || (paths.length <= 3 && stem && !stem.startsWith('.') ? stem : null)
    if (pick) count.set(pick, (count.get(pick) || 0) + 1)
  }
  let best = null
  for (const [k, v] of count) if (!best || v > best[1]) best = [k, v]
  return best ? best[0].replace(/[-_]+/g, ' ') : null
}

function git(cwd, args, timeout = 20_000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout))
  })
}

async function gitCommonDir(wsPath) {
  const dotGit = path.join(wsPath, '.git')
  let st
  try {
    st = await stat(dotGit)
  } catch {
    return null
  }
  if (st.isDirectory()) return dotGit
  const m = (await readFile(dotGit, 'utf8')).match(/^gitdir:\s*(.+)\s*$/m)
  if (!m) return null
  const gitDir = path.resolve(wsPath, m[1].trim())
  try {
    return path.resolve(gitDir, (await readFile(path.join(gitDir, 'commondir'), 'utf8')).trim())
  } catch {
    return gitDir
  }
}

export default function activate(orca) {
  const months = new Map() // 'YYYY-MM' -> entries[]
  let meta = null // { seenCommits: string[], commitsSince: { [repo]: ms } }
  const excluded = new Set()
  let lastCommitScan = 0
  let scanning = false
  let saving = Promise.resolve()

  const call = (method, params = {}) => orca.host.call(method, params)

  async function settings() {
    try {
      return (await call('settings.get')).settings ?? {}
    } catch {
      return {}
    }
  }
  function lang(s) {
    if (s.language === 'id' || s.language === 'en') return s.language
    const loc = (Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG || '').toLowerCase()
    return /^(id|ms|in)\b/.test(loc) ? 'id' : 'en'
  }

  async function month(key) {
    if (!months.has(key)) {
      let list = []
      try {
        const { value } = await call('storage.get', { key: `entries:${key}` })
        if (Array.isArray(value)) list = value
      } catch {}
      months.set(key, list)
    }
    return months.get(key)
  }
  async function getMeta() {
    if (!meta) {
      try {
        meta = (await call('storage.get', { key: 'meta' })).value
      } catch {}
      meta = meta && typeof meta === 'object' ? meta : {}
      meta.seenCommits ??= []
      meta.commitsSince ??= {}
      meta.repoProjects ??= {} // repo (git common dir or folder) -> projectId, learned from the user's edits
      meta.months ??= [] // every month key ever written; storage cannot list its keys
    }
    return meta
  }
  // Months that may hold entries: the index, plus the last five years for data saved before the index existed.
  async function allMonthKeys() {
    const keys = new Set([...(await getMeta()).months, ...months.keys()])
    const now = new Date()
    for (let i = -1; i < 60; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      keys.add(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`)
    }
    return [...keys].filter((k) => MONTH_RE.test(k)).sort()
  }
  // Writes run one after another. The returned promise rejects when this write fails, so callers
  // can keep note files on disk and report the error; the queue itself keeps going.
  function persist(keys) {
    const run = saving.then(async () => {
      for (const k of keys) await call('storage.set', { key: `entries:${k}`, value: months.get(k) })
      const m = await getMeta()
      for (const k of keys) if (!m.months.includes(k)) m.months.push(k)
      m.seenCommits = m.seenCommits.slice(-6000)
      await call('storage.set', { key: 'meta', value: m })
    })
    saving = run.catch((e) => orca.log(`save failed: ${e.message}`))
    return run
  }
  async function addEntries(entries) {
    const touched = new Set()
    for (const e of entries) {
      const key = monthOf(e.date)
      ;(await month(key)).push(e)
      touched.add(key)
    }
    if (!touched.size) return
    try {
      await persist([...touched])
    } catch (err) {
      // Not saved: take the entries back out so a retry does not duplicate them.
      const ids = new Set(entries.map((e) => e.id))
      for (const k of touched) {
        const list = months.get(k)
        for (let i = list.length - 1; i >= 0; i--) if (ids.has(list[i].id)) list.splice(i, 1)
      }
      throw err
    }
    orca.panels.post('worklog.changed', { months: [...touched] })
    updateStatusBar().catch(() => {})
  }

  async function places() {
    const [{ workspaces }, { projects }] = await Promise.all([call('workspace.list'), call('project.list')])
    return { workspaces, projects }
  }
  const isLocal = (row) => row.hostId === 'local' || row.hostId == null

  async function ensureExcluded(common) {
    if (excluded.has(common)) return
    excluded.add(common)
    const file = path.join(common, 'info', 'exclude')
    let cur = ''
    try {
      cur = await readFile(file, 'utf8')
    } catch {}
    if (/^\/?\.worklog\/?\s*$/m.test(cur)) return
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}# Worklog: agent work notes, never committed\n.worklog/\n`)
  }

  // Reads notes but leaves the files in place; scan() deletes them once the entries are saved.
  async function collectNotes(ws, { repo, projectId, projectName }, files) {
    const dir = path.join(ws.path, NOTES_DIR)
    let names
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const out = []
    for (const name of names) {
      if (!/\.(md|txt)$/i.test(name)) continue
      const file = path.join(dir, name)
      try {
        const st = await stat(file)
        if (!st.isFile() || Date.now() - st.mtimeMs < 2000) continue
        if (st.size > MAX_NOTE_BYTES) { orca.log(`skipped ${file}: too large`); continue }
        const note = parseNote(await readFile(file, 'utf8'), name)
        const at = Math.round(st.mtimeMs)
        out.push({
          id: newId(),
          date: dayOf(at),
          at,
          source: 'agent',
          repo,
          projectId,
          projectName,
          area: note.area || areaFromBranch(ws.branch),
          text: note.text,
          details: note.details,
          branch: ws.branch ?? null
        })
        files.push(file)
      } catch (e) {
        orca.log(`could not read ${file}: ${e.message}`)
      }
    }
    return out
  }

  async function collectCommits(repos) {
    const m = await getMeta()
    const seen = new Set(m.seenCommits)
    const out = []
    for (const { common, cwd, projectId, projectName } of repos) {
      const email = (await git(cwd, ['config', 'user.email']))?.trim()
      if (!email) continue
      const since = m.commitsSince[common] ?? Date.now() - FIRST_COMMIT_DAYS * 86_400_000
      const startedAt = Date.now()
      const log = await git(cwd, ['log', '--all', '--no-merges', `--author=${email}`, `--since=${new Date(since - 3600_000).toISOString()}`, '--format=%x1e%H%x1f%at%x1f%s', '--name-only'])
      if (log == null) continue
      for (const block of log.split('\x1e').slice(1)) {
        const [head, ...files] = block.split('\n')
        const [hash, ts, subject] = head.split('\x1f')
        if (!hash || seen.has(hash)) continue
        seen.add(hash)
        m.seenCommits.push(hash)
        const at = Number(ts) * 1000
        out.push({
          id: newId(),
          date: dayOf(at),
          at,
          source: 'commit',
          hash: hash.slice(0, 10),
          repo: common,
          projectId,
          projectName,
          area: areaFromPaths(files.filter(Boolean)),
          text: (subject || '').slice(0, 300),
          details: [],
          branch: null
        })
      }
      m.commitsSince[common] = startedAt
    }
    return out
  }

  async function scan({ commits = false } = {}) {
    if (scanning) return 0
    scanning = true
    try {
      const s = await settings()
      const { workspaces, projects } = await places()
      const byId = new Map(projects.map((p) => [p.id, p]))
      const repos = new Map()
      const found = []
      const noteFiles = []
      const m = await getMeta()
      const metaBefore = JSON.stringify(m)
      for (const ws of workspaces) {
        if (!isLocal(ws) || !ws.path) continue
        const common = await gitCommonDir(ws.path).catch(() => null)
        const repo = common ?? path.resolve(ws.path)
        // Orca's own project wins; otherwise use the project the user picked before for this repo.
        const learned = byId.has(m.repoProjects[repo]) ? m.repoProjects[repo] : null
        const projectId = ws.projectId ?? learned
        const owner = { repo, projectId, projectName: byId.get(projectId)?.name ?? ws.project ?? ws.name }
        if (common) {
          if (s.hideFromGit !== false) await ensureExcluded(common).catch(() => {})
          if (!repos.has(common)) repos.set(common, { common, cwd: ws.path, ...owner })
        }
        found.push(...(await collectNotes(ws, owner, noteFiles)))
      }
      if (commits && s.includeCommits !== false) {
        found.push(...(await collectCommits([...repos.values()])))
        lastCommitScan = Date.now()
      }
      if (found.length) {
        try {
          await addEntries(found)
        } catch (err) {
          meta = JSON.parse(metaBefore) // forget commits marked seen, so the next scan retries them
          throw err
        }
        for (const file of noteFiles) await unlink(file).catch((e) => orca.log(`could not remove ${file}: ${e.message}`))
      }
      await updateStatusBar()
      return found.length
    } finally {
      scanning = false
    }
  }

  // ---- reports ----

  function fmtDay(day, l, withWeekday = true) {
    const [y, mo, d] = day.split('-').map(Number)
    return new Date(y, mo - 1, d).toLocaleDateString(l === 'id' ? 'id-ID' : 'en-GB', withWeekday ? { weekday: 'long', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'short' })
  }
  function monthTitle(key, l) {
    const [y, mo] = key.split('-').map(Number)
    return new Date(y, mo - 1, 1).toLocaleDateString(l === 'id' ? 'id-ID' : 'en-GB', { month: 'long', year: 'numeric' })
  }
  const general = (l) => (l === 'id' ? 'Umum' : 'General')
  const noProject = (l) => (l === 'id' ? 'Tanpa project' : 'No project')

  const fmtHours = (h, l) => `${h.toLocaleString(l === 'id' ? 'id-ID' : 'en-GB', { maximumFractionDigits: 2 })} ${l === 'id' ? 'jam' : 'h'}`

  function report(key, list, { groupBy, l, includeCommits, name, projectName }) {
    const items = visible(list, includeCommits).sort((a, b) => a.at - b.at)
    const forProject = projectName ? ` · ${projectName}` : ''
    const T = l === 'id'
      ? { title: `Laporan kerja ${monthTitle(key, l)}${forProject}`, by: name ? `Disusun oleh ${name}.` : '', count: (n, d, h) => `${n} pekerjaan dalam ${d} hari kerja${h ? `, total ${h}` : ''}.`, empty: 'Belum ada catatan pekerjaan bulan ini.' }
      : { title: `Work report, ${monthTitle(key, l)}${forProject}`, by: name ? `Prepared by ${name}.` : '', count: (n, d, h) => `${n} items over ${d} working days${h ? `, ${h} in total` : ''}.`, empty: 'No work logged this month.' }
    const lines = [`# ${T.title}`, '']
    if (!items.length) return [...lines, T.empty, ''].join('\n')
    const days = new Set(items.map((e) => e.date)).size
    const total = sumHours(items)
    const hoursOf = (arr) => { const h = sumHours(arr); return h ? ` · ${fmtHours(h, l)}` : '' }
    lines.push([T.by, T.count(items.length, days, total ? fmtHours(total, l) : '')].filter(Boolean).join(' '), '')
    const line = (e, withDate) => {
      const tag = e.source === 'commit' ? ` (commit ${e.hash})` : ''
      const hrs = e.hours ? ` (${fmtHours(e.hours, l)})` : ''
      const head = `- ${withDate ? `${fmtDay(e.date, l, false)}: ` : ''}${e.text}${hrs}${tag}`
      return [head, ...e.details.map((d) => `  - ${d}`)].join('\n')
    }
    const group = (arr, keyFn) => {
      const m = new Map()
      for (const e of arr) {
        const k = keyFn(e)
        if (!m.has(k)) m.set(k, [])
        m.get(k).push(e)
      }
      return m
    }
    if (groupBy === 'date') {
      for (const [day, dayItems] of group(items, (e) => e.date)) {
        lines.push(`## ${fmtDay(day, l)}${hoursOf(dayItems)}`, '')
        for (const [proj, pItems] of group(dayItems, (e) => e.projectName || noProject(l))) {
          lines.push(`### ${proj}`, '')
          for (const [area, aItems] of group(pItems, (e) => e.area || general(l))) {
            lines.push(`**${area}**`, ...aItems.map((e) => line(e, false)), '')
          }
        }
      }
    } else {
      for (const [proj, pItems] of group(items, (e) => e.projectName || noProject(l))) {
        lines.push(`## ${proj}${hoursOf(pItems)}`, '')
        for (const [area, aItems] of group(pItems, (e) => e.area || general(l))) {
          lines.push(`### ${area}`, ...aItems.map((e) => line(e, true)), '')
        }
      }
    }
    return lines.join('\n')
  }

  function csv(list, includeCommits, l) {
    const head = l === 'id' ? ['Tanggal', 'Project', 'Bagian', 'Pekerjaan', 'Jam', 'Detail', 'Sumber'] : ['Date', 'Project', 'Area', 'Work', 'Hours', 'Details', 'Source']
    const src = { agent: 'agent', me: 'manual', commit: 'commit' }
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    // Hours use a dot (1.5) so spreadsheets in any locale read them as numbers after import.
    const rows = visible(list, includeCommits)
      .sort((a, b) => a.at - b.at)
      .map((e) => [e.date, e.projectName || '', e.area || '', e.text, e.hours ?? '', e.details.join('; '), e.source === 'commit' ? `commit ${e.hash}` : src[e.source]].map(q).join(','))
    return '\uFEFF' + [head.map(q).join(','), ...rows].join('\r\n') + '\r\n'
  }

  function checkMonth(key) {
    if (!MONTH_RE.test(key ?? '')) throw fail('invalid_params', 'month must be YYYY-MM')
  }
  // `hint` is the month the panel shows; loading it first finds entries even after a worker restart.
  async function findEntry(id, hint) {
    if (MONTH_RE.test(hint ?? '')) await month(hint)
    for (const [key, list] of months) {
      const e = list.find((x) => x.id === id)
      if (e) return { key, list, e }
    }
    throw fail('invalid_params', 'No such entry')
  }

  // ---- panel requests ----

  orca.panels.handle('worklog.month', async ({ month: key } = {}) => {
    checkMonth(key)
    const s = await settings()
    let projects = []
    try {
      projects = (await call('project.list')).projects.filter((p) => !p.hidden).map((p) => ({ id: p.id, name: p.name }))
    } catch {}
    return {
      lang: lang(s),
      includeCommits: s.includeCommits !== false,
      protocol: protocol(lang(s)),
      entries: await month(key),
      projects
    }
  })

  orca.panels.handle('worklog.scan', async () => ({ added: await scan({ commits: true }) }))

  orca.panels.handle('worklog.add', async ({ date, projectId = null, area = '', text, details = '', hours } = {}) => {
    if (!DATE_RE.test(date ?? '')) throw fail('invalid_params', 'date must be YYYY-MM-DD')
    if (typeof text !== 'string' || !text.trim()) throw fail('invalid_params', 'Describe the work.')
    const h = parseHours(hours)
    let project = null
    if (projectId) project = (await call('project.list')).projects.find((p) => p.id === projectId) ?? null
    const [y, mo, d] = date.split('-').map(Number)
    await addEntries([{
      id: newId(),
      date,
      at: new Date(y, mo - 1, d, 12).getTime(),
      source: 'me',
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      area: String(area).trim().slice(0, 60) || null,
      text: text.trim().slice(0, 300),
      hours: h,
      details: String(details).split('\n').map((x) => x.replace(/^[-*]\s*/, '').trim()).filter(Boolean).slice(0, 5),
      branch: null
    }])
    return { ok: true }
  })

  orca.panels.handle('worklog.update', async ({ id, month: hint, text, area, projectId, date, hidden, details, hours } = {}) => {
    // Validate and look everything up before changing the entry, so a bad request changes nothing.
    if (date !== undefined && !DATE_RE.test(date ?? '')) throw fail('invalid_params', 'date must be YYYY-MM-DD')
    const h = hours === undefined ? undefined : parseHours(hours)
    const { key, list, e } = await findEntry(id, hint)
    const p = projectId ? (await call('project.list')).projects.find((x) => x.id === projectId) : null
    const touched = [key]
    if (h !== undefined) e.hours = h
    if (projectId !== undefined && e.repo && (p?.id ?? null) !== (e.projectId ?? null)) touched.push(...(await learnProject(e, p)))
    if (typeof details === 'string') e.details = details.split('\n').map((x) => x.replace(/^[-*]\s*/, '').trim()).filter(Boolean).slice(0, 5).map((x) => x.slice(0, 300))
    if (typeof text === 'string' && text.trim()) e.text = text.trim().slice(0, 300)
    if (typeof area === 'string') e.area = area.trim().slice(0, 60) || null
    if (projectId !== undefined) {
      e.projectId = p?.id ?? null
      e.projectName = p?.name ?? null
    }
    if (typeof hidden === 'boolean') e.hidden = hidden
    if (date !== undefined && date !== e.date) {
      e.date = date
      if (monthOf(date) !== key) {
        list.splice(list.indexOf(e), 1)
        ;(await month(monthOf(date))).push(e)
        touched.push(monthOf(date))
      }
    }
    const changedMonths = [...new Set(touched)]
    await persist(changedMonths)
    orca.panels.post('worklog.changed', { months: changedMonths })
    return { ok: true }
  })

  // Picking a project for an entry with no project (or correcting a learned one) teaches the repo
  // rule: later notes and commits from that repo get the project, and so do its other loose entries
  // in the months already loaded. Orca's own workspace project is never overridden.
  async function learnProject(e, p) {
    const rules = (await getMeta()).repoProjects
    if (e.projectId != null && rules[e.repo] !== e.projectId) return []
    if (p) rules[e.repo] = p.id
    else delete rules[e.repo]
    if (!p) return []
    const changed = []
    for (const [k, list] of months) {
      for (const x of list) {
        if (x !== e && x.repo === e.repo && !x.projectId) {
          x.projectId = p.id
          x.projectName = p.name
          changed.push(k)
        }
      }
    }
    return changed
  }

  orca.panels.handle('worklog.delete', async ({ id, month: hint } = {}) => {
    const { key, list, e } = await findEntry(id, hint)
    list.splice(list.indexOf(e), 1)
    await persist([key])
    orca.panels.post('worklog.changed', { months: [key] })
    return { ok: true }
  })

  // ---- backup ----

  // Everything needed to rebuild the log elsewhere: all entries, the learned repo projects, and the
  // commits already taken (so a restored machine does not log them a second time).
  orca.panels.handle('worklog.backup', async () => {
    const m = await getMeta()
    const out = {}
    for (const k of await allMonthKeys()) {
      const list = await month(k)
      if (list.length) out[k] = list
    }
    const text = JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), months: out, seenCommits: m.seenCommits, repoProjects: m.repoProjects }, null, 1)
    return { fileName: `worklog-backup-${dayOf(Date.now())}.json`, text, entries: Object.values(out).flat().length }
  })

  // Merges a backup into the log: entries already present (same id) are skipped, nothing is overwritten.
  orca.panels.handle('worklog.restore', async ({ text } = {}) => {
    if (typeof text !== 'string' || text.length > MAX_BACKUP_CHARS) throw fail('invalid_params', 'Not a Worklog backup file.')
    let data
    try {
      data = JSON.parse(text)
    } catch {
      throw fail('invalid_params', 'Not a Worklog backup file.')
    }
    if (data?.format !== BACKUP_FORMAT || !data.months || typeof data.months !== 'object') throw fail('invalid_params', 'Not a Worklog backup file.')
    const incoming = Object.values(data.months).flatMap((v) => (Array.isArray(v) ? v : [])).map(cleanEntry)
    const valid = incoming.filter(Boolean)
    const keys = new Set([...(await allMonthKeys()), ...valid.map((e) => monthOf(e.date))])
    // Same id = same entry; for commits the hash also counts, since each machine gives its own id.
    const known = new Set()
    const sig = (e) => (e.source === 'commit' ? `commit:${e.hash.slice(0, 10)}` : null)
    for (const k of keys) for (const e of await month(k)) { known.add(e.id); if (sig(e)) known.add(sig(e)) }
    const fresh = []
    for (const e of valid) {
      if (known.has(e.id) || (sig(e) && known.has(sig(e)))) continue
      known.add(e.id)
      if (sig(e)) known.add(sig(e))
      fresh.push(e)
    }
    await addEntries(fresh)
    const m = await getMeta()
    if (Array.isArray(data.seenCommits)) {
      const seen = new Set(m.seenCommits)
      for (const h of data.seenCommits) if (typeof h === 'string' && /^[0-9a-f]{7,64}$/.test(h) && !seen.has(h)) { seen.add(h); m.seenCommits.push(h) }
    }
    if (data.repoProjects && typeof data.repoProjects === 'object') {
      for (const [repo, id] of Object.entries(data.repoProjects)) if (typeof id === 'string' && !(repo in m.repoProjects)) m.repoProjects[repo] = id
    }
    await persist([])
    return { added: fresh.length, skipped: valid.length - fresh.length, invalid: incoming.length - valid.length }
  })

  // projectId limits the report to one project, so one client's report never carries another's work.
  orca.panels.handle('worklog.export', async ({ month: key, format = 'md', groupBy = 'project', includeCommits, name = '', projectId = null } = {}) => {
    checkMonth(key)
    const s = await settings()
    const l = lang(s)
    const inc = typeof includeCommits === 'boolean' ? includeCommits : s.includeCommits !== false
    let list = await month(key)
    let projectName = null
    if (projectId) {
      list = list.filter((e) => e.projectId === projectId)
      let current = null
      try {
        current = (await call('project.list')).projects.find((p) => p.id === projectId)
      } catch {}
      projectName = current?.name ?? list.find((e) => e.projectName)?.projectName ?? String(projectId)
    }
    const base = `worklog-${key}${projectName ? `-${slug(projectName)}` : ''}`
    if (format === 'csv') return { fileName: `${base}.csv`, text: csv(list, inc, l) }
    return {
      fileName: `${base}.md`,
      text: report(key, list, { groupBy: groupBy === 'date' ? 'date' : 'project', l, includeCommits: inc, name: String(name).slice(0, 80), projectName })
    }
  })

  let lastStatus = ''
  async function updateStatusBar() {
    const s = await settings()
    const l = lang(s)
    const today = dayOf(Date.now())
    const items = visible(await month(monthOf(today)), s.includeCommits !== false).filter((e) => e.date === today)
    const text = l === 'id' ? `${items.length} kerjaan hari ini` : `${items.length} done today`
    const projects = new Set(items.map((e) => e.projectName).filter(Boolean))
    const tooltip = l === 'id'
      ? `Worklog: ${items.length} pekerjaan tercatat hari ini${projects.size ? ` di ${[...projects].join(', ')}` : ''}`
      : `Worklog: ${items.length} item${items.length === 1 ? '' : 's'} logged today${projects.size ? ` in ${[...projects].join(', ')}` : ''}`
    if (`${text}|${tooltip}` === lastStatus) return
    lastStatus = `${text}|${tooltip}`
    try {
      await call('statusBar.update', { id: 'today', text, tooltip, visible: true })
    } catch (e) {
      orca.log(`status bar: ${e.message}`)
    }
  }

  orca.commands.register('worklog.today', async () => {
    const s = await settings()
    const l = lang(s)
    const today = dayOf(Date.now())
    const items = visible(await month(monthOf(today)), s.includeCommits !== false).filter((e) => e.date === today).sort((a, b) => a.at - b.at)
    if (!items.length) return l === 'id' ? 'Belum ada pekerjaan tercatat hari ini.' : 'Nothing logged today yet.'
    const lines = items.map((e) => `- ${e.projectName || noProject(l)} / ${e.area || general(l)}: ${e.text}`)
    return `${fmtDay(today, l)}\n${lines.join('\n')}`
  })

  const tick = () => scan({ commits: Date.now() - lastCommitScan > COMMIT_SCAN_MS }).catch((e) => orca.log(`scan failed: ${e.message}`))
  tick()
  const timer = setInterval(tick, SCAN_MS)
  return { dispose: () => clearInterval(timer) }
}
