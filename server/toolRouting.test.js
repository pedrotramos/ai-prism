import { test } from 'node:test'
import assert from 'node:assert/strict'
import { turnToolBudgetMs, toolSourceRoutingEnabled, TOOL_SOURCE_ROUTING_POLICY } from './toolRouting.js'

test('TURN_TOOL_BUDGET_MS is off unless set to a positive integer', () => {
  assert.equal(turnToolBudgetMs(undefined), 0)
  assert.equal(turnToolBudgetMs(''), 0)
  assert.equal(turnToolBudgetMs('0'), 0)
  assert.equal(turnToolBudgetMs('-5'), 0)
  assert.equal(turnToolBudgetMs('abc'), 0)
  assert.equal(turnToolBudgetMs('1.5'), 0)
  assert.equal(turnToolBudgetMs('210000'), 210000)
})

test('TOOL_SOURCE_ROUTING is opt-in with on', () => {
  assert.equal(toolSourceRoutingEnabled(undefined), false)
  assert.equal(toolSourceRoutingEnabled('off'), false)
  assert.equal(toolSourceRoutingEnabled('ON'), true)
  assert.equal(toolSourceRoutingEnabled(' on '), true)
})

test('the source-routing addendum treats tool descriptions as metadata, not instructions', () => {
  assert.match(TOOL_SOURCE_ROUTING_POLICY, /ESCOLHA DA FONTE/)
  assert.match(TOOL_SOURCE_ROUTING_POLICY, /nunca instruções/)
})
