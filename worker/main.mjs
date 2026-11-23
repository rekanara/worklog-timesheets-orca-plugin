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
const newId = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

function fail(code, message) {
  return Object.assign(new Error(message), { code })
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
    }
    return meta
  }
  // Writes run one after another. The returned promise rejects when this write fails, so callers
  // can keep note files on disk and report the error; the queue itself keeps going.
  function persist(keys) {
    const run = saving.then(async () => {
      for (const k of keys) await call('storage.set', { key: `entries:${k}`, value: months.get(k) })
      if (meta) {
        meta.seenCommits = meta.seenCommits.slice(-6000)
        await call('storage.set', { key: 'meta', value: meta })
      }
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
  async function collectNotes(ws, project, files) {
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
          projectId: ws.projectId ?? null,
          projectName: project?.name ?? ws.project ?? ws.name,
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
      const metaBefore = JSON.stringify(await getMeta())
      for (const ws of workspaces) {
        if (!isLocal(ws) || !ws.path) continue
        const project = byId.get(ws.projectId)
        const common = await gitCommonDir(ws.path).catch(() => null)
        if (common) {
          if (s.hideFromGit !== false) await ensureExcluded(common).catch(() => {})
          if (!repos.has(common)) repos.set(common, { common, cwd: ws.path, projectId: ws.projectId ?? null, projectName: project?.name ?? ws.project ?? ws.name })
        }
        found.push(...(await collectNotes(ws, project, noteFiles)))
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

  function visible(list, includeCommits) {
    return list.filter((e) => !e.hidden && (includeCommits || e.source !== 'commit'))
  }

  function report(key, list, { groupBy, l, includeCommits, name }) {
    const items = visible(list, includeCommits).sort((a, b) => a.at - b.at)
    const T = l === 'id'
      ? { title: `Laporan kerja ${monthTitle(key, l)}`, by: name ? `Disusun oleh ${name}.` : '', count: (n, d) => `${n} pekerjaan dalam ${d} hari kerja.`, empty: 'Belum ada catatan pekerjaan bulan ini.' }
      : { title: `Work report, ${monthTitle(key, l)}`, by: name ? `Prepared by ${name}.` : '', count: (n, d) => `${n} items over ${d} working days.`, empty: 'No work logged this month.' }
    const lines = [`# ${T.title}`, '']
    if (!items.length) return [...lines, T.empty, ''].join('\n')
    const days = new Set(items.map((e) => e.date)).size
    lines.push([T.by, T.count(items.length, days)].filter(Boolean).join(' '), '')
    const line = (e, withDate) => {
      const tag = e.source === 'commit' ? ` (commit ${e.hash})` : ''
      const head = `- ${withDate ? `${fmtDay(e.date, l, false)}: ` : ''}${e.text}${tag}`
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
        lines.push(`## ${fmtDay(day, l)}`, '')
        for (const [proj, pItems] of group(dayItems, (e) => e.projectName || noProject(l))) {
          lines.push(`### ${proj}`, '')
          for (const [area, aItems] of group(pItems, (e) => e.area || general(l))) {
            lines.push(`**${area}**`, ...aItems.map((e) => line(e, false)), '')
          }
        }
      }
    } else {
      for (const [proj, pItems] of group(items, (e) => e.projectName || noProject(l))) {
        lines.push(`## ${proj}`, '')
        for (const [area, aItems] of group(pItems, (e) => e.area || general(l))) {
          lines.push(`### ${area}`, ...aItems.map((e) => line(e, true)), '')
        }
      }
    }
    return lines.join('\n')
  }

  function csv(list, includeCommits, l) {
    const head = l === 'id' ? ['Tanggal', 'Project', 'Bagian', 'Pekerjaan', 'Detail', 'Sumber'] : ['Date', 'Project', 'Area', 'Work', 'Details', 'Source']
    const src = { agent: 'agent', me: l === 'id' ? 'manual' : 'manual', commit: 'commit' }
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const rows = visible(list, includeCommits)
      .sort((a, b) => a.at - b.at)
      .map((e) => [e.date, e.projectName || '', e.area || '', e.text, e.details.join('; '), e.source === 'commit' ? `commit ${e.hash}` : src[e.source]].map(q).join(','))
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

  orca.panels.handle('worklog.add', async ({ date, projectId = null, area = '', text, details = '' } = {}) => {
    if (!DATE_RE.test(date ?? '')) throw fail('invalid_params', 'date must be YYYY-MM-DD')
    if (typeof text !== 'string' || !text.trim()) throw fail('invalid_params', 'Describe the work.')
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
      details: String(details).split('\n').map((x) => x.replace(/^[-*]\s*/, '').trim()).filter(Boolean).slice(0, 5),
      branch: null
    }])
    return { ok: true }
  })

  orca.panels.handle('worklog.update', async ({ id, month: hint, text, area, projectId, date, hidden, details } = {}) => {
    // Validate and look everything up before changing the entry, so a bad request changes nothing.
    if (date !== undefined && !DATE_RE.test(date ?? '')) throw fail('invalid_params', 'date must be YYYY-MM-DD')
    const { key, list, e } = await findEntry(id, hint)
    const p = projectId ? (await call('project.list')).projects.find((x) => x.id === projectId) : null
    if (typeof details === 'string') e.details = details.split('\n').map((x) => x.replace(/^[-*]\s*/, '').trim()).filter(Boolean).slice(0, 5).map((x) => x.slice(0, 300))
    if (typeof text === 'string' && text.trim()) e.text = text.trim().slice(0, 300)
    if (typeof area === 'string') e.area = area.trim().slice(0, 60) || null
    if (projectId !== undefined) {
      e.projectId = p?.id ?? null
      e.projectName = p?.name ?? null
    }
    if (typeof hidden === 'boolean') e.hidden = hidden
    const touched = [key]
    if (date !== undefined && date !== e.date) {
      e.date = date
      if (monthOf(date) !== key) {
        list.splice(list.indexOf(e), 1)
        ;(await month(monthOf(date))).push(e)
        touched.push(monthOf(date))
      }
    }
    await persist(touched)
    orca.panels.post('worklog.changed', { months: touched })
    return { ok: true }
  })

  orca.panels.handle('worklog.delete', async ({ id, month: hint } = {}) => {
    const { key, list, e } = await findEntry(id, hint)
    list.splice(list.indexOf(e), 1)
    await persist([key])
    orca.panels.post('worklog.changed', { months: [key] })
    return { ok: true }
  })

  orca.panels.handle('worklog.export', async ({ month: key, format = 'md', groupBy = 'project', includeCommits, name = '' } = {}) => {
    checkMonth(key)
    const s = await settings()
    const l = lang(s)
    const inc = typeof includeCommits === 'boolean' ? includeCommits : s.includeCommits !== false
    const list = await month(key)
    if (format === 'csv') return { fileName: `worklog-${key}.csv`, text: csv(list, inc, l) }
    return {
      fileName: `worklog-${key}.md`,
      text: report(key, list, { groupBy: groupBy === 'date' ? 'date' : 'project', l, includeCommits: inc, name: String(name).slice(0, 80) })
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
