// W2-4 item 4 (Q4-B): "Share" moves the chat into a project and opens the members. planShare decides which step
// applies to the open chat; the Shell acts on it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planShare } from './shareChat.ts'

const ME = 'ana@example.com'
const projects = [{ id: 3, name: 'Alpha' }]

test('a chat already in a project goes straight to that project’s members', () => {
  const r = planShare({ session: { id: '25', project_id: 3 }, projects, email: ME })
  assert.deepEqual(r, { kind: 'open-members', projectId: '3' })
})

test('a chat in a project keeps its members step even when the project is not in the caller’s list', () => {
  const r = planShare({ session: { id: '25', project_id: 99 }, projects, email: ME })
  assert.deepEqual(r, { kind: 'open-members', projectId: '99' })
})

test('a personal chat asks which project to move it to', () => {
  assert.deepEqual(planShare({ session: { id: '25', project_id: null }, projects, email: ME }), { kind: 'choose-project' })
  assert.deepEqual(planShare({ session: { id: '25' }, projects, email: ME }), { kind: 'choose-project' })
})

test('with no project yet the user is sent to create one (Projects screen)', () => {
  assert.deepEqual(planShare({ session: { id: '25', project_id: null }, projects: [], email: ME }), { kind: 'no-projects' })
})

test('a temporary chat can never join a project', () => {
  assert.deepEqual(planShare({ session: { id: '25', ephemeral: true }, projects, email: ME }), { kind: 'unavailable', reason: 'temporary' })
})

test('without a saved chat there is nothing to share', () => {
  assert.deepEqual(planShare({ session: null, projects, email: ME }), { kind: 'unavailable', reason: 'no-chat' })
})

test('a personal chat of someone else is not movable', () => {
  assert.deepEqual(planShare({ session: { id: '25', project_id: null, owner_email: 'bruno@example.com' }, projects, email: ME }), { kind: 'unavailable', reason: 'foreign' })
  assert.deepEqual(planShare({ session: { id: '25', project_id: null, owner_email: 'ANA@example.com' }, projects, email: ME }), { kind: 'choose-project' })
})
