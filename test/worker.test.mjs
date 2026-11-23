// Run: node --test test/*.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, utimes, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import activate, { parseNote, areaFromBranch, areaFromPaths } from '../worker/main.mjs'

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
function fakeOrca(store, wsPath) {
  const handlers = {}
  const state = { failSave: false }
  const orca = {
    log: () => {},
    commands: { register: () => {} },
    panels: { handle: (n, fn) => { handlers[n] = fn }, post: () => {} },
    host: {
      call: async (method, p) => {
        if (method === 'settings.get') return { settings: { includeCommits: false, hideFromGit: false, language: 'en' } }
        if (method === 'workspace.list') return { workspaces: [{ hostId: 'local', path: wsPath, projectId: 'p1', name: 'ws' }] }
        if (method === 'project.list') return { projects: [{ id: 'p1', name: 'Shop' }] }
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
