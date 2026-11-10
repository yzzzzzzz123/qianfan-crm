const routes = {
  contract_split_missing: ['contract', 'sales', 'contract-items'],
  contract_items_incomplete: ['contract', 'sales', 'contract-items'],
  source_split: ['contract', 'sales', 'contract-items'],
  margin_missing: ['contract', 'sales', 'contract-items'],
  receipt_source_claim: ['receipt', 'sales', 'payment-allocation'],
  receipt_split_missing: ['receipt', 'sales', 'payment-allocation'],
  receipt_split_exceeded: ['receipt', 'sales', 'payment-allocation'],
  receipt_date_missing: ['receipt', 'sales', 'payment-allocation'],
  product_basis_incomplete: ['receipt', 'sales', 'payment-allocation'],
  performance_missing: ['performance', 'admin', 'performance'],
  rate_missing: ['policy', 'admin', 'sales-policy'],
  service_scope_unconfirmed: ['policy', 'admin', 'sales-policy'],
  commission_policy_pending: ['policy', 'admin', 'manager-policy'],
  legacy_rate_pending: ['policy', 'admin', 'manager-policy'],
  legacy_settlement: ['history', 'admin', 'contract'],
  contract_terminated: ['contract', 'admin', 'contract'],
};

// Routing is descriptive only. Permissions and business writes remain with the
// destination module; a diagnostic never grants access or changes a policy.
export function commissionDiagnostic(issue, { salesId = null, defaultPending = true } = {}) {
  const route = routes[issue.code];
  return {
    ...issue,
    pending: issue.pending ?? defaultPending,
    category: issue.category || route?.[0] || 'information',
    responsibility: issue.responsibility ?? route?.[1] ?? null,
    action: issue.action ?? route?.[2] ?? null,
    sales_id: issue.sales_id ?? salesId,
  };
}

// All money values are integer cents. A next tier is an explanation of the
// current complete basis, not a promise based on missing receipts or rates.
export function commissionTier(bands, base, {
  grade = null, basisComplete = true, scope = 'month', ruleConfirmed = true,
} = {}) {
  const index = bands.findLastIndex(band => base >= band.min);
  const current = bands[index], next = bands[index + 1];
  const rate = grade && current ? current.rates[grade] ?? null : null;
  const status = !ruleConfirmed ? 'scope-unconfirmed' : !basisComplete ? 'basis-incomplete' : !grade ? 'grade-missing' : rate == null ? 'rate-missing' : 'ready';
  const ready = status === 'ready';
  const nextRate = grade && next ? next.rates[grade] ?? null : null;
  const canExplainNext = ready && !!next && nextRate != null;
  return {
    scope, grade, known_base: base, basis_complete: basisComplete,
    rule_confirmed: ruleConfirmed, status,
    current_threshold: ready ? current.min : null,
    rate: ready ? rate : null,
    next_threshold: canExplainNext ? next.min : null,
    next_rate: canExplainNext ? nextRate : null,
    distance_to_next: canExplainNext ? Math.max(0, next.min - base) : null,
    at_maximum: ready && !next,
    next_rate_pending: ready && !!next && nextRate == null,
    whole_base: true,
  };
}
