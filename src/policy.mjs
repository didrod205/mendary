// The shop policy, written twice on purpose:
// POLICY_TEXT is what the AI reads; computeDecision() is what actually decides the money.
export const SHIPPING = 6.0;
export const CATALOG = [
  { sku: 'MUG-01', name: 'Stoneware mug', price: 24.0, digital: false, note: 'Hand-glazed, 12 oz' },
  { sku: 'TWL-02', name: 'Linen tea towel (set of 2)', price: 18.0, digital: false, note: 'Washed linen' },
  { sku: 'KTL-03', name: 'Pour-over kettle', price: 58.0, digital: false, note: '1 L, gooseneck' },
  { sku: 'EBK-04', name: 'Glaze recipe e-book (PDF)', price: 9.0, digital: true, note: 'Instant download' },
];

export const RULES = { windowDays: 30, notReceivedAfterDays: 10, restockingPct: 15 };

export const POLICY_TEXT = `North Pier Goods refund policy (demo shop)
P1. Refund requests are accepted within ${RULES.windowDays} days of payment.
P2. Damaged or defective on arrival: full refund of the affected items. If every item in the order is affected, shipping is refunded too.
P3. Wrong item sent: treated like P2.
P4. Not received: once ${RULES.notReceivedAfterDays} days have passed since payment, full refund of the order. Before that the parcel is still in transit and we ask the customer to wait.
P5. Arrived late (after 7 days): the shipping fee is refunded.
P6. Changed mind: unopened physical items get the item price back minus a ${RULES.restockingPct}% restocking fee; shipping is not refunded. Opened items cannot be returned for change of mind.
P7. Digital downloads are not refundable for change of mind. A broken or unreadable file is refunded in full under P2.
P8. The shop owner approves every refund. A refund can never exceed what was paid minus earlier refunds.
P9. Anything else goes to the owner with no amount proposed.`;

const r2 = (n) => Math.round(n * 100) / 100;

export function computeDecision(read, ev, now) {
  const lines = [];
  const capturedAt = ev.capturedAt ? new Date(ev.capturedAt) : now;
  const days = (now - capturedAt) / 86400000;
  lines.push(`Paid ${ev.currency} ${ev.captured.toFixed(2)} on ${capturedAt.toISOString().slice(0, 10)} (${days.toFixed(1)} days ago); already refunded ${ev.refunded.toFixed(2)}; refundable now ${ev.remaining.toFixed(2)}.`);
  const all = ev.items;
  const chosen = read.skus && read.skus.length ? all.filter((i) => read.skus.includes(i.sku)) : all;
  const wholeOrder = chosen.length === all.length;
  const itemSum = r2(chosen.reduce((s, i) => s + i.unit * i.quantity, 0));
  const physical = chosen.filter((i) => !i.digital);
  const physicalSum = r2(physical.reduce((s, i) => s + i.unit * i.quantity, 0));
  let action = 'need_info', amount = 0, clause = 'P9', reason = 'This request needs the owner to look at it.';

  if (days > RULES.windowDays) {
    action = 'deny'; clause = 'P1'; reason = `The order was paid more than ${RULES.windowDays} days ago, so it is outside the refund window.`;
  } else if (read.category === 'damaged' || read.category === 'wrong_item') {
    clause = read.category === 'damaged' ? 'P2' : 'P3';
    amount = itemSum + (wholeOrder ? ev.shipping : 0);
    lines.push(`Items: ${chosen.map((i) => `${i.sku} ${i.quantity} x ${i.unit.toFixed(2)}`).join(', ')} = ${itemSum.toFixed(2)}` + (wholeOrder && ev.shipping ? ` + shipping ${ev.shipping.toFixed(2)} (whole order affected)` : ''));
    action = 'refund'; reason = clause === 'P2' ? 'Items arrived damaged or defective.' : 'The wrong item was sent.';
  } else if (read.category === 'not_received') {
    clause = 'P4';
    if (days >= RULES.notReceivedAfterDays) { amount = ev.remaining; action = 'refund'; reason = 'The parcel has not arrived after the delivery window.'; lines.push('Full order refund (P4).'); }
    else { action = 'need_info'; reason = `It has been ${Math.floor(days)} day(s) since payment; parcels are treated as in transit until day ${RULES.notReceivedAfterDays}.`; }
  } else if (read.category === 'late') {
    clause = 'P5'; amount = ev.shipping; action = amount > 0 ? 'refund' : 'deny';
    reason = amount > 0 ? 'The parcel arrived late, so shipping is refunded.' : 'This order had no shipping fee to refund.';
    lines.push(`Shipping fee ${ev.shipping.toFixed(2)}.`);
  } else if (read.category === 'changed_mind') {
    clause = 'P6';
    const digital = chosen.filter((i) => i.digital);
    if (digital.length && !physical.length) { action = 'deny'; clause = 'P7'; reason = 'Digital downloads are not refundable for change of mind.'; }
    else if (read.condition === 'opened' || read.condition === 'damaged') { action = 'deny'; reason = 'Opened items cannot be returned for change of mind.'; }
    else {
      amount = physicalSum * (1 - RULES.restockingPct / 100); action = 'refund';
      reason = 'Unopened items returned for change of mind, minus the restocking fee.';
      lines.push(`Physical items ${physicalSum.toFixed(2)} - ${RULES.restockingPct}% restocking fee = ${r2(amount).toFixed(2)}; shipping not refunded` + (digital.length ? '; digital items excluded (P7)' : '') + '.');
    }
  }

  amount = r2(Math.max(0, amount));
  const cap = r2(Math.min(amount, ev.remaining));
  if (cap < amount) lines.push(`Capped at what is still refundable: ${ev.remaining.toFixed(2)} (P8).`);
  amount = cap;
  if (action === 'refund' && amount <= 0) { action = 'deny'; reason = 'Nothing is left to refund on this order.'; }
  const requested = read.requested_amount;
  const requestedAboveCap = requested != null && requested > amount + 0.0001;
  if (requestedAboveCap) lines.push(`Customer asked for ${requested.toFixed(2)}; the policy allows ${amount.toFixed(2)}. Code keeps ${amount.toFixed(2)}.`);
  if (action === 'refund') action = amount >= ev.remaining - 0.0001 ? 'full' : 'partial';
  return { action, amount, cap: amount, clause, reason, lines, requestedAboveCap, daysSincePayment: r2(days) };
}
