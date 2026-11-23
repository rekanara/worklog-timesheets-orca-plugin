// Run: node --test test/*.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import activate, { parseNote, areaFromBranch, areaFromPaths, parseHours, visible, cleanEntry } from '../worker/main.mjs'

test('parseNote', () => {
  const n = parseNote('# Added email validation\narea: auth\n- covers sign-up\n- and login\n', 'x.md')
  assert.deepEqual(n, { text: 'Added email validation', area: 'auth', details: ['covers sign-up', 'and login'] })
  assert.equal(parseNote('---\ntitle: "Fixed cart"\narea: checkout\n---\n', 'x.md').text, 'Fixed cart')
  assert.equal(parseNote('', 'fix-login_bug.md').text, 'fix login bug')
  assert.equal(parseNote('# Done\nbagian: kasir', 'x.md').area, 'kasir')
})

test('area guessing', () => {
  assert.equal(areaFromBranch('feature/checkout-v2'), 'checkout v2')
  assert.equal(areaFromBranch('main'), null)
  assert.equal(areaFromPaths(['lib/features/checkout/a.dart', 'lib/features/checkout/b.dart', 'src/auth/x.ts']), 'checkout')
})

// Minimal fake of the Orca host: storage in a Map, one local workspace.
function fakeOrca(store, wsPath, wsProjectId = 'p1') {
  const handlers = {}
  const state = { failSave: false }
  const orca = {
    log: () => {},
    commands: { register: () => {} },
    panels: { handle: (n, fn) => { handlers[n] = fn }, post: () => {} },
    host: {
      call: async (method, p) => {
        if (method === 'settings.get') return { settings: { includeCommits: false, hideFromGit: false, language: 'en' } }
        if (method === 'workspace.list') return { workspaces: [{ hostId: 'local', path: wsPath, projectId: wsProjectId, name: 'ws' }] }
        if (method === 'project.list') return { projects: [{ id: 'p1', name: 'Shop' }, { id: 'p2', name: 'Klinik' }] }
        if (method === 'storage.get') return { value: store.get(p.key) }
        if (method === 'storage.set') { if (state.failSave) throw new Error('disk full'); store.set(p.key, structuredClone(p.value)); return {} }
        return {}
      }
    }
  }
  return { orca, handlers, state }
}
const settle = () => new Promise((r) => setTimeout(r, 50))
const exists = (f) => access(f).then(() => true, () => false)

test('notes survive a failed save, then are taken once saved', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'worklog-'))
  await mkdir(path.join(ws, '.worklog'))
  const note = path.join(ws, '.worklog', 'a.md')
  await writeFile(note, '# Added checkout\narea: checkout\n')
  const old = new Date(Date.now() - 60_000)
  await utimes(note, old, old)

  const store = new Map()
  const { orca, handlers, state } = fakeOrca(store, ws)
  state.failSave = true
  const w = activate(orca)
  await settle() // first tick fails to save
  assert.ok(await exists(note), 'note must stay on disk when saving fails')
  await assert.rejects(handlers['worklog.scan']())
  assert.ok(await exists(note))

  state.failSave = false
  assert.deepEqual(await handlers['worklog.scan'](), { added: 1 })
  assert.ok(!(await exists(note)), 'note removed after it was saved')
  const key = `entries:${old.toISOString().slice(0, 7)}`
  assert.equal([...store.values()].flat().filter((e) => e?.text === 'Added checkout').length, 1, `one entry under ${key}`)
  w.dispose()
})

test('bad update changes nothing; entries found after restart via month hint', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'worklog-'))
  const store = new Map()
  let { orca, handlers } = fakeOrca(store, ws)
  let w = activate(orca)
  await settle()
  await handlers['worklog.add']({ date: '2026-03-04', text: 'Original' })
  const [e] = store.get('entries:2026-03')

  await assert.rejects(handlers['worklog.update']({ id: e.id, month: '2026-03', text: 'Changed', date: 'nope' }))
  assert.equal((await handlers['worklog.month']({ month: '2026-03' })).entries[0].text, 'Original')
  w.dispose()

  ;({ orca, handlers } = fakeOrca(store, ws)) // fresh worker, nothing loaded in memory
  w = activate(orca)
  await settle()
  await handlers['worklog.update']({ id: e.id, month: '2026-03', text: 'Renamed' })
  assert.equal(store.get('entries:2026-03')[0].text, 'Renamed')
  w.dispose()
})

test('export for one project leaves other clients out', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'worklog-'))
  const store = new Map([['entries:2026-05', [
    { id: 'a', date: '2026-05-02', at: 1, source: 'me', projectId: 'p1', projectName: 'Shop', area: 'cart', text: 'Shop work', details: [] },
    { id: 'b', date: '2026-05-03', at: 2, source: 'me', projectId: 'p2', projectName: 'Klinik', area: 'auth', text: 'Klinik work', details: [] },
    { id: 'c', date: '2026-05-04', at: 3, source: 'me', projectId: null, projectName: null, area: null, text: 'Loose work', details: [] }
  ]]])
  const { orca, handlers } = fakeOrca(store, ws)
  const w = activate(orca)
  await settle()
  const md = await handlers['worklog.export']({ month: '2026-05', projectId: 'p1' })
  assert.equal(md.fileName, 'worklog-2026-05-shop.md')
  assert.match(md.text, /^# Work report, May 2026 · Shop/)
  assert.match(md.text, /Shop work/)
  assert.doesNotMatch(md.text, /Klinik|Loose/)
  const csv = await handlers['worklog.export']({ month: '2026-05', format: 'csv', projectId: 'p1' })
  assert.equal(csv.fileName, 'worklog-2026-05-shop.csv')
  assert.doesNotMatch(csv.text, /Klinik|Loose/)
  const all = await handlers['worklog.export']({ month: '2026-05' })
  assert.equal(all.fileName, 'worklog-2026-05.md')
  assert.match(all.text, /Klinik work[\s\S]*Loose work|Loose work[\s\S]*Klinik work/)
  w.dispose()
})

test('hours: parsing, report totals, CSV column', async () => {
  assert.equal(parseHours(''), null)
  assert.equal(parseHours('1,5'), 1.5)
  assert.equal(parseHours(2), 2)
  assert.equal(parseHours('0'), null)
  assert.throws(() => parseHours('25'))
  assert.throws(() => parseHours('abc'))

  const ws = await mkdtemp(path.join(tmpdir(), 'worklog-'))
  const store = new Map()
  const { orca, handlers } = fakeOrca(store, ws)
  const w = activate(orca)
  await settle()
  await handlers['worklog.add']({ date: '2026-06-01', projectId: 'p1', text: 'Cart', hours: '1,5' })
  await handlers['worklog.add']({ date: '2026-06-02', projectId: 'p1', text: 'Login', hours: 2 })
  await assert.rejects(handlers['worklog.add']({ date: '2026-06-02', text: 'Bad', hours: 99 }))
  const md = (await handlers['worklog.export']({ month: '2026-06' })).text
  assert.match(md, /2 items over 2 working days, 3\.5 h in total\./)
  assert.match(md, /## Shop · 3\.5 h/)
  assert.match(md, /Cart \(1\.5 h\)/)
  const csv = (await handlers['worklog.export']({ month: '2026-06', format: 'csv' })).text
  assert.match(csv, /"Hours"/)
  assert.match(csv, /"Cart","1\.5"/)
  const [e] = store.get('entries:2026-06')
  await handlers['worklog.update']({ id: e.id, month: '2026-06', hours: '' })
  assert.equal(store.get('entries:2026-06')[0].hours, null)
  w.dispose()
})

test('a commit is dropped when the same day and project has a written note', () => {
  const list = [
    { date: '2026-06-01', projectId: 'p1', source: 'agent', text: 'Note' },
    { date: '2026-06-01', projectId: 'p1', source: 'commit', text: 'fix: x' },
    { date: '2026-06-01', projectId: 'p2', source: 'commit', text: 'other project' },
    { date: '2026-06-02', projectId: 'p1', source: 'commit', text: 'empty day' }
  ]
  assert.deepEqual(visible(list, true).map((e) => e.text), ['Note', 'other project', 'empty day'])
  assert.deepEqual(visible(list, false).map((e) => e.text), ['Note'])
})

test('picking a project for a loose entry teaches its repo', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'worklog-'))
  const repo = path.resolve(ws)
  const loose = (id, text) => ({ id, date: '2026-07-01', at: 1, source: 'agent', repo, projectId: null, projectName: 'ws', area: null, text, details: [] })
  const store = new Map([['entries:2026-07', [loose('a', 'First'), loose('b', 'Second')]]])
  const { orca, handlers } = fakeOrca(store, ws, null) // workspace without an Orca project
  const w = activate(orca)
  await settle()

  await handlers['worklog.update']({ id: 'a', month: '2026-07', projectId: 'p2' })
  const saved = store.get('entries:2026-07')
  assert.deepEqual(saved.map((e) => e.projectName), ['Klinik', 'Klinik'], 'other loose entry from the repo follows')
  assert.equal(store.get('meta').repoProjects[repo], 'p2')

  // Editing only the text (panel always sends projectId) keeps the rule.
  await handlers['worklog.update']({ id: 'b', month: '2026-07', projectId: 'p2', text: 'Second, edited' })
  assert.equal(store.get('meta').repoProjects[repo], 'p2')

  // A new note from that repo lands in the learned project.
  await mkdir(path.join(ws, '.worklog'))
  const note = path.join(ws, '.worklog', 'n.md')
  await writeFile(note, '# Third\n')
  const old = new Date(Date.now() - 60_000)
  await utimes(note, old, old)
  await handlers['worklog.scan']()
  const third = [...store.entries()].filter(([k]) => k.startsWith('entries:')).flatMap(([, v]) => v).find((e) => e.text === 'Third')
  assert.equal(third.projectId, 'p2')
  assert.equal(third.projectName, 'Klinik')
  w.dispose()
})

test('backup on one machine, restore on another: merges, never duplicates', async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'worklog-'))
  const thisMonth = new Date().toISOString().slice(0, 7)
  const e = (id, extra = {}) => ({ id, date: `${thisMonth}-01`, at: 1, source: 'me', projectId: 'p1', projectName: 'Shop', area: null, text: id, details: [], ...extra })
  // Machine A: data written before the month index existed (no meta), plus a commit.
  const storeA = new Map([[`entries:${thisMonth}`, [e('a1', { hours: 2 }), e('c1', { source: 'commit', hash: 'abcdef1234' })]]])
  const A = fakeOrca(storeA, ws)
  const wA = activate(A.orca)
  await settle()
  const backup = await A.handlers['worklog.backup']()
  assert.equal(backup.entries, 2)
  assert.match(backup.fileName, /^worklog-backup-\d{4}-\d{2}-\d{2}\.json$/)
  wA.dispose()

  // Machine B already has one shared entry and the same commit under its own id.
  const storeB = new Map([[`entries:${thisMonth}`, [e('a1'), e('cB', { source: 'commit', hash: 'abcdef1234' })]]])
  const B = fakeOrca(storeB, ws)
  const wB = activate(B.orca)
  await settle()
  const parsed = JSON.parse(backup.text)
  parsed.months[thisMonth].push({ id: 'bad', date: 'nope', text: 'x', source: 'me' }, e('new1'))
  parsed.seenCommits = ['abcdef1234567890']
  const r = await B.handlers['worklog.restore']({ text: JSON.stringify(parsed) })
  assert.deepEqual(r, { added: 1, skipped: 2, invalid: 1 })
  assert.deepEqual(storeB.get(`entries:${thisMonth}`).map((x) => x.id), ['a1', 'cB', 'new1'])
  assert.ok(storeB.get('meta').seenCommits.includes('abcdef1234567890'))
  assert.ok(storeB.get('meta').months.includes(thisMonth))

  // Restoring the same file again adds nothing.
  assert.equal((await B.handlers['worklog.restore']({ text: JSON.stringify(parsed) })).added, 0)
  await assert.rejects(B.handlers['worklog.restore']({ text: '{"hello":1}' }))
  await assert.rejects(B.handlers['worklog.restore']({ text: 'not json' }))
  wB.dispose()
})

test('cleanEntry drops junk and keeps known fields only', () => {
  assert.equal(cleanEntry(null), null)
  assert.equal(cleanEntry({ id: 'x', date: '2026-01-01', text: 'ok', source: 'commit' }), null, 'commit without hash')
  const c = cleanEntry({ id: 'x', date: '2026-01-01', text: ' ok ', source: 'me', hours: 99, evil: '<script>', details: ['a', 3] })
  assert.equal(c.text, 'ok')
  assert.equal(c.hours, null)
  assert.deepEqual(c.details, ['a'])
  assert.equal('evil' in c, false)
})
