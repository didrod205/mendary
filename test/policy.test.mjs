// Run: node test/policy.test.mjs  (no dependencies)
import { computeDecision, normalizeRules, DEFAULT_RULES } from '../src/policy.mjs';
import assert from 'node:assert/strict';

const now = new Date('2026-11-04T12:00:00Z');
const ev = (over = {}) => ({
  currency: 'USD', captured: 97, refunded: 0, remaining: 97, shipping: 6, capturedAt: '2026-11-04T03:00:00Z',
  items: [
    { sku: 'MUG-01', name: 'Stoneware mug', quantity: 1, unit: 24, digital: false },
    { sku: 'KTL-03', name: 'Pour-over kettle', quantity: 1, unit: 58, digital: false },
    { sku: 'EBK-04', name: 'Glaze recipe e-book', quantity: 1, unit: 9, digital: true },
  ], ...over,
});
const read = (over = {}) => ({ category: 'other', skus: [], condition: 'not_stated', requested_amount: null, claimed_days_to_arrival: null, red_flags: [], ...over });
const cases = [
  ['damaged mug only', read({ category: 'damaged', skus: ['MUG-01'] }), ev(), 'partial', 24],
  ['damaged whole order adds shipping', read({ category: 'damaged' }), ev(), 'full', 97],
  ['changed mind sealed kettle minus 15%', read({ category: 'changed_mind', skus: ['KTL-03'], condition: 'unopened' }), ev(), 'partial', 49.3],
  ['changed mind opened kettle', read({ category: 'changed_mind', skus: ['KTL-03'], condition: 'opened' }), ev(), 'deny', 0],
  ['changed mind e-book', read({ category: 'changed_mind', skus: ['EBK-04'] }), ev(), 'deny', 0],
  ['late: shipping only even if 500 asked', read({ category: 'late', requested_amount: 500 }), ev(), 'partial', 6],
  ['not received too early', read({ category: 'not_received' }), ev(), 'need_info', 0],
  ['not received after 12 days', read({ category: 'not_received' }), ev({ capturedAt: '2026-10-23T00:00:00Z' }), 'full', 97],
  ['outside 30 days', read({ category: 'damaged' }), ev({ capturedAt: '2026-09-01T00:00:00Z' }), 'deny', 0],
  ['cap by remaining after earlier refunds', read({ category: 'damaged' }), ev({ refunded: 80, remaining: 17 }), 'full', 17],
  ['unknown category proposes nothing', read({ category: 'other', requested_amount: 50 }), ev(), 'need_info', 0],
  ['late claim conflicts with payment time', read({ category: 'late', claimed_days_to_arrival: 9 }), ev(), 'need_info', 0],
  ['late but within promise', read({ category: 'late', claimed_days_to_arrival: 5 }), ev({ capturedAt: '2026-10-20T00:00:00Z' }), 'deny', 0],
  ['late and plausible needs owner confirm', read({ category: 'late', claimed_days_to_arrival: 9 }), ev({ capturedAt: '2026-10-20T00:00:00Z' }), 'partial', 6],
];
let pass = 0;
for (const [name, r, e, action, amount] of cases) {
  const d = computeDecision(r, e, now);
  assert.equal(d.action, action, name + ' action');
  assert.equal(d.amount, amount, name + ' amount');
  assert.ok(d.amount <= e.remaining, name + ' never above remaining');
  pass++;
}
// confirmation is required whenever the money depends on an unverified delivery fact
assert.ok(computeDecision(read({ category: 'late', claimed_days_to_arrival: 9 }), ev({ capturedAt: '2026-10-20T00:00:00Z' }), now).confirm);
assert.ok(computeDecision(read({ category: 'not_received' }), ev({ capturedAt: '2026-10-20T00:00:00Z' }), now).confirm);
// owner rules change the outcome
const strict = { ...DEFAULT_RULES, changeOfMind: 'not_allowed' };
assert.equal(computeDecision(read({ category: 'changed_mind', skus: ['KTL-03'], condition: 'unopened' }), ev(), now, strict).action, 'deny');
const fee30 = { ...DEFAULT_RULES, restockingPct: 30 };
assert.equal(computeDecision(read({ category: 'changed_mind', skus: ['KTL-03'], condition: 'unopened' }), ev(), now, fee30).amount, 40.6);
// schema guard: AI drafts are clamped and defaulted, extra keys dropped
const n = normalizeRules({ windowDays: 9999, restockingPct: -5, changeOfMind: 'refund everything', maxRefund: 1e9 });
assert.equal(n.rules.windowDays, 365); assert.equal(n.rules.restockingPct, 0); assert.equal(n.rules.changeOfMind, 'unopened_only'); assert.equal(n.rules.maxRefund, undefined);
pass += 6;
console.log(`policy tests passed: ${pass}/${cases.length + 6}`);
