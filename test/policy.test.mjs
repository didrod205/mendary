// Run: node test/policy.test.mjs  (no dependencies)
import { computeDecision } from '../src/policy.mjs';
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
const read = (over = {}) => ({ category: 'other', skus: [], condition: 'unknown', requested_amount: null, red_flags: [], ...over });
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
];
let pass = 0;
for (const [name, r, e, action, amount] of cases) {
  const d = computeDecision(r, e, now);
  assert.equal(d.action, action, name + ' action');
  assert.equal(d.amount, amount, name + ' amount');
  assert.ok(d.amount <= e.remaining, name + ' never above remaining');
  pass++;
}
console.log(`policy tests passed: ${pass}/${cases.length}`);
