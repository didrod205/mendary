// Refund rules. The AI may DRAFT rules from the owner's own words (Policy setup), but only
// normalizeRules() decides what a valid rule is, and only computeDecision() decides money.
export const SHIPPING = 6.0;
export const CATALOG = [
  { sku: 'MUG-01', name: 'Stoneware mug', price: 24.0, digital: false, note: 'Hand-glazed, 12 oz' },
  { sku: 'TWL-02', name: 'Linen tea towel (set of 2)', price: 18.0, digital: false, note: 'Washed linen' },
  { sku: 'KTL-03', name: 'Pour-over kettle', price: 58.0, digital: false, note: '1 L, gooseneck' },
  { sku: 'EBK-04', name: 'Glaze recipe e-book (PDF)', price: 9.0, digital: true, note: 'Instant download' },
];

export const DEFAULT_OWNER_TEXT = `You can ask for a refund up to 30 days after you pay.
If something arrives broken or faulty, we refund that item. If the whole order is broken we also give back the shipping.
If we sent the wrong thing, same as broken.
If your parcel hasn't arrived 10 days after you paid, we refund the whole order.
If it arrives more than 7 days after you paid, we give back the shipping fee.
Changed your mind? Send it back unopened and you get the price back minus a 15% restocking fee. No shipping refund. Opened items can't be returned just because you changed your mind.
E-books and other downloads can't be refunded if you changed your mind, only if the file is broken.
We pay for the return label on wrong items.`;

// Schema: every key, its type and allowed range. Anything else the AI returns is dropped.
export const RULE_SCHEMA = {
  windowDays: { type: 'int', min: 1, max: 365, def: 30, label: 'Refund window (days after payment)' },
  damagedRefundsItems: { type: 'bool', def: true, label: 'Damaged or faulty items are refunded' },
  damagedShippingIfWholeOrder: { type: 'bool', def: true, label: 'Shipping refunded when the whole order is damaged' },
  wrongItemLikeDamaged: { type: 'bool', def: true, label: 'Wrong item is treated like damaged' },
  notReceivedAfterDays: { type: 'int', min: 1, max: 90, def: 10, label: 'Not received: full refund after (days)' },
  lateAfterDays: { type: 'int', min: 1, max: 90, def: 7, label: 'Late if it arrives after (days)' },
  lateRefundsShipping: { type: 'bool', def: true, label: 'Late delivery refunds the shipping fee' },
  changeOfMind: { type: 'enum', values: ['unopened_only', 'any_condition', 'not_allowed'], def: 'unopened_only', label: 'Change of mind returns' },
  restockingPct: { type: 'int', min: 0, max: 50, def: 15, label: 'Restocking fee on change of mind (%)' },
  digitalChangeOfMind: { type: 'bool', def: false, label: 'Digital goods refundable on change of mind' },
};
export const DEFAULT_RULES = Object.fromEntries(Object.entries(RULE_SCHEMA).map(([k, v]) => [k, v.def]));

// Validates any object (AI draft or owner edit) into a complete rule set; reports what was defaulted or clamped.
export function normalizeRules(input) {
  const rules = {}; const notes = [];
  const src = input && typeof input === 'object' ? input : {};
  for (const [k, s] of Object.entries(RULE_SCHEMA)) {
    let v = src[k];
    if (s.type === 'int') {
      const n = Math.round(Number(v));
      if (v === undefined || v === null || v === '' || !isFinite(n)) { rules[k] = s.def; notes.push({ key: k, note: 'not found in the text, default kept' }); continue; }
      const c = Math.max(s.min, Math.min(s.max, n));
      if (c !== n) notes.push({ key: k, note: `clamped from ${n} to ${c}` });
      rules[k] = c;
    } else if (s.type === 'bool') {
      if (typeof v === 'string') v = v.toLowerCase() === 'true' ? true : (v.toLowerCase() === 'false' ? false : v);
      if (typeof v !== 'boolean') { rules[k] = s.def; notes.push({ key: k, note: 'not found in the text, default kept' }); continue; }
      rules[k] = v;
    } else if (s.type === 'enum') {
      if (!s.values.includes(v)) { rules[k] = s.def; notes.push({ key: k, note: 'not found in the text, default kept' }); continue; }
      rules[k] = v;
    }
  }
  return { rules, notes };
}

// The policy text the intake AI reads is rendered FROM the rules, so words and code never drift apart.
export function policyText(r, shop = 'North Pier Goods') {
  const com = r.changeOfMind === 'not_allowed' ? 'Change of mind returns are not accepted.'
    : `Changed mind: ${r.changeOfMind === 'unopened_only' ? 'unopened ' : ''}physical items get the item price back minus a ${r.restockingPct}% restocking fee; shipping is not refunded.${r.changeOfMind === 'unopened_only' ? ' Opened items cannot be returned for change of mind.' : ''}`;
  return `${shop} refund policy
P1. Refund requests are accepted within ${r.windowDays} days of payment.
P2. Damaged or defective on arrival: ${r.damagedRefundsItems ? 'full refund of the affected items' : 'handled by the owner'}.${r.damagedShippingIfWholeOrder ? ' If every item in the order is affected, shipping is refunded too.' : ''}
P3. Wrong item sent: ${r.wrongItemLikeDamaged ? 'treated like P2' : 'handled by the owner'}.
P4. Not received: once ${r.notReceivedAfterDays} days have passed since payment, full refund of the order. Before that the parcel is in transit.
P5. Arrived late (more than ${r.lateAfterDays} days after payment): ${r.lateRefundsShipping ? 'the shipping fee is refunded' : 'no refund'}.
P6. ${com}
P7. Digital downloads ${r.digitalChangeOfMind ? 'are refundable on change of mind' : 'are not refundable for change of mind; a broken file is refunded under P2'}.
P8. The shop owner approves every refund. A refund can never exceed what was paid minus earlier refunds.
P9. Anything else goes to the owner with no amount proposed.`;
}

const r2 = (n) => Math.round(n * 100) / 100;

// read: AI reading (category, skus, condition, requested_amount, claimed_days_to_arrival)
// ev: evidence from PayPal Orders v2; rules: normalized rules.
export function computeDecision(read, ev, now, rules = DEFAULT_RULES) {
  const R = rules;
  const lines = [];
  const checks = [];
  const capturedAt = ev.capturedAt ? new Date(ev.capturedAt) : now;
  const days = Math.max(0, (now - capturedAt) / 86400000);
  lines.push(`Paid ${ev.currency} ${ev.captured.toFixed(2)} on ${capturedAt.toISOString().slice(0, 10)} (${days.toFixed(1)} days ago); already refunded ${ev.refunded.toFixed(2)}; refundable now ${ev.remaining.toFixed(2)}.`);
  checks.push({ fact: 'Amount paid, items, payment date, earlier refunds', source: 'PayPal Orders v2', verified: true });

  const all = ev.items;
  const chosen = read.skus && read.skus.length ? all.filter((i) => read.skus.includes(i.sku)) : all;
  const wholeOrder = chosen.length === all.length;
  const itemSum = r2(chosen.reduce((s, i) => s + i.unit * i.quantity, 0));
  const physical = chosen.filter((i) => !i.digital);
  const physicalSum = r2(physical.reduce((s, i) => s + i.unit * i.quantity, 0));
  let action = 'need_info', amount = 0, clause = 'P9', reason = 'This request needs the owner to look at it.';
  let confirm = null; // what the owner must confirm before money can move
  const claimed = typeof read.claimed_days_to_arrival === 'number' ? read.claimed_days_to_arrival : null;

  if (days > R.windowDays) {
    action = 'deny'; clause = 'P1'; reason = `The order was paid more than ${R.windowDays} days ago, so it is outside the refund window.`;
  } else if (read.category === 'damaged' || (read.category === 'wrong_item' && R.wrongItemLikeDamaged)) {
    clause = read.category === 'damaged' ? 'P2' : 'P3';
    if (R.damagedRefundsItems) {
      amount = itemSum + (wholeOrder && R.damagedShippingIfWholeOrder ? ev.shipping : 0);
      lines.push(`Items: ${chosen.map((i) => `${i.sku} ${i.quantity} x ${i.unit.toFixed(2)}`).join(', ')} = ${itemSum.toFixed(2)}` + (wholeOrder && R.damagedShippingIfWholeOrder && ev.shipping ? ` + shipping ${ev.shipping.toFixed(2)} (whole order affected)` : ''));
      action = 'refund'; reason = clause === 'P2' ? 'Items arrived damaged or defective.' : 'The wrong item was sent.';
    }
    checks.push({ fact: clause === 'P2' ? 'Item condition: damaged' : 'Wrong item received', source: 'Customer statement', verified: false });
  } else if (read.category === 'not_received') {
    clause = 'P4';
    checks.push({ fact: 'Parcel not delivered', source: 'Customer statement (no carrier tracking connected)', verified: false });
    if (days >= R.notReceivedAfterDays) { amount = ev.remaining; action = 'refund'; confirm = 'I checked the carrier: the parcel was not delivered.'; reason = 'Past the delivery window; delivery status is unverified, so the owner must confirm it first.'; lines.push('Full order refund if non-delivery is confirmed (P4).'); }
    else { action = 'need_info'; reason = `Paid ${Math.floor(days)} day(s) ago; parcels count as in transit until day ${R.notReceivedAfterDays}.`; }
  } else if (read.category === 'late') {
    clause = 'P5';
    checks.push({ fact: claimed != null ? `Arrived ${claimed} days after payment` : 'Arrival date', source: 'Customer statement (no carrier tracking connected)', verified: false });
    if (claimed != null && claimed > days + 0.5) {
      action = 'need_info'; amount = 0;
      reason = `Claim conflicts with PayPal: the customer says it arrived ${claimed} days after payment, but payment was ${days.toFixed(1)} days ago.`;
      lines.push(`Conflict: claimed ${claimed} days > ${days.toFixed(1)} days since payment. No amount proposed.`);
      checks.push({ fact: 'Claimed arrival vs PayPal payment time', source: 'PayPal capture time', verified: true, conflict: true });
    } else if (!R.lateRefundsShipping || !(ev.shipping > 0)) {
      action = 'deny'; reason = R.lateRefundsShipping ? 'This order had no shipping fee to refund.' : 'The policy gives no refund for late delivery.';
    } else if (claimed != null && claimed <= R.lateAfterDays) {
      action = 'deny'; reason = `Arrival after ${claimed} days is within the ${R.lateAfterDays}-day delivery promise.`;
    } else {
      amount = ev.shipping; action = 'refund'; confirm = 'I checked the arrival date with the carrier.';
      reason = 'Late arrival refunds shipping, but the arrival date is the customer\'s word, so the owner must confirm it.';
      lines.push(`Shipping fee ${ev.shipping.toFixed(2)} if the late arrival is confirmed.`);
    }
  } else if (read.category === 'changed_mind') {
    clause = 'P6';
    const digital = chosen.filter((i) => i.digital);
    if (digital.length && !physical.length && !R.digitalChangeOfMind) { action = 'deny'; clause = 'P7'; reason = 'Digital downloads are not refundable for change of mind.'; }
    else if (R.changeOfMind === 'not_allowed') { action = 'deny'; reason = 'The policy does not accept change of mind returns.'; }
    else if (R.changeOfMind === 'unopened_only' && (read.condition === 'opened' || read.condition === 'damaged')) { action = 'deny'; reason = 'Opened items cannot be returned for change of mind.'; }
    else {
      const base = R.digitalChangeOfMind ? itemSum : physicalSum;
      amount = base * (1 - R.restockingPct / 100); action = 'refund';
      reason = 'Return for change of mind, minus the restocking fee.';
      lines.push(`Items ${base.toFixed(2)} - ${R.restockingPct}% restocking fee = ${r2(amount).toFixed(2)}; shipping not refunded` + (digital.length && !R.digitalChangeOfMind ? '; digital items excluded (P7)' : '') + '.');
      if (R.changeOfMind === 'unopened_only') checks.push({ fact: 'Item unopened', source: 'Customer statement (check when the return arrives)', verified: false });
    }
  }

  amount = r2(Math.max(0, amount));
  const cap = r2(Math.min(amount, ev.remaining));
  if (cap < amount) lines.push(`Capped at what is still refundable: ${ev.remaining.toFixed(2)} (P8).`);
  amount = cap;
  if (action === 'refund' && amount <= 0) { action = 'deny'; reason = 'Nothing is left to refund on this order.'; confirm = null; }
  const requested = read.requested_amount;
  const requestedAboveCap = requested != null && requested > amount + 0.0001;
  if (requestedAboveCap) lines.push(`Customer asked for ${requested.toFixed(2)}; the policy allows ${amount.toFixed(2)}. Code keeps ${amount.toFixed(2)}.`);
  if (action === 'refund') action = amount >= ev.remaining - 0.0001 ? 'full' : 'partial';
  return { action, amount, cap: amount, clause, reason, lines, checks, confirm, requestedAboveCap, daysSincePayment: r2(days) };
}
