const routes = {
  contract_split_missing: ['contract', 'sales', 'contract-items'],
  contract_items_incomplete: ['contract', 'sales', 'contract-items'],
  source_split: ['contract', 'sales', 'contract-items'],
  margin_missing: ['contract', 'sales', 'contract-items'],
  receipt_source_claim: ['receipt', 'sales', 'payment-allocation'],
  receipt_split_missing: ['receipt', 'sales', 'payment-allocation'],
  receipt_split_exceeded: ['receipt', 'sales', 'payment-allocation'],
  receipt_date_missing: ['receipt', 'sales', 'payment-allocation'],
  receipt_date_conflict: ['receipt', 'sales', 'payment-allocation'],
  receipt_prior_incomplete: ['receipt', 'sales', 'payment-allocation'],
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

export function receiptDiagnosticDetails(receipt, {code,blocking_receipt:blocker}, signDate) {
  if(!code.startsWith('receipt_'))return {};
  const source=blocker||receipt;
  return {
    payment_id:source.payment_id, payment_amount:source.amount, payment_date:source.date, sign_date:signDate,
    ...(blocker?{blocking_code:blocker.code,affected_payment_ids:[receipt.payment_id]}:{}),
  };
}

export function createCommissionIssueRecorder(issues, salesId) {
  const positions=new Map();
  return (contract,code,message,{component=null,pending=true,...extra}={})=>{
    const value=commissionDiagnostic({contract_id:contract.id,contract_name:contract.name,code,message,display_message:`${contract.name}：${message}`,component,pending,...extra},{salesId});
    const key=value.payment_id!=null
      ? JSON.stringify([contract.id,value.blocking_code||code,value.payment_id])
      : JSON.stringify([contract.id,code,message]);
    const index=positions.get(key);
    if(index==null){
      positions.set(key,issues.length);
      issues.push(value);
    }else if(value.payment_id!=null){
      const existing=issues[index];
      const affected=[...new Set([...(existing.affected_payment_ids||[]),...(value.affected_payment_ids||[])])];
      issues[index]={...(value.blocking_code?existing:value),affected_payment_ids:affected};
    }
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
