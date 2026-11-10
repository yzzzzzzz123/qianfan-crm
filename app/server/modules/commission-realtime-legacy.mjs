import { createHash } from 'node:crypto';
import { all, one } from '../database.mjs';
import { today } from '../domain.mjs';
import { commissionDiagnostic } from './commission-diagnostics.mjs';

const periodFor = (day, mode) => mode === 'month' ? day.slice(0, 7) : mode === 'year' ? day.slice(0, 4) : `${day.slice(0, 4)}Q${Math.ceil(Number(day.slice(5, 7)) / 3)}`;
const amountKnown = value => Number.isSafeInteger(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// This is a read model. It does not adopt a pending commission policy, create a
// settlement, lock a contract or change an existing settlement snapshot.
export function realtimeLegacyCommissionPreviews(db, rules, actor, requested, legacyPreviews = []) {
  if (!actor || actor.role === 'pm') return [];
  const policy = rules.commission;
  const selected = requested || periodFor(today(), policy.period);
  const monthly = /^\d{4}-\d{2}$/.test(selected) && !!policy.sales_policy;
  const actualPeriod = /^\d{4}-\d{2}$/.test(selected) ? periodFor(`${selected}-01`, policy.period) : selected;
  const manager = one(db, "SELECT id FROM users WHERE id=? AND active=1 AND role='admin' AND business_member=1 AND developer_admin=0", policy.manager_id || 0)?.id
    || one(db, "SELECT id FROM users WHERE active=1 AND role='admin' AND business_member=1 AND developer_admin=0 ORDER BY id LIMIT 1")?.id;
  const users = all(db, "SELECT id,name,role,active FROM users WHERE business_member=1 AND developer_admin=0 AND (role='sales' OR id=?) ORDER BY id", manager || 0);
  const contracts = all(db, `SELECT c.* FROM contracts c JOIN users u ON u.id=c.owner_id
    WHERE c.retired_at IS NULL AND c.lifecycle!='草稿' AND u.business_member=1 AND u.developer_admin=0 AND c.sign_date<=? ORDER BY c.id`, today())
    .filter(c => periodFor(c.sign_date, policy.period) === actualPeriod);
  const items = all(db, 'SELECT * FROM contract_items WHERE retired_at IS NULL ORDER BY id');
  const receipts = policy.unlock_by_payment ? all(db, "SELECT * FROM payments WHERE status='已到账' ORDER BY id") : [];
  const batches = all(db, 'SELECT id,sales_id,kind,period,amount,status FROM commission_batches WHERE period=? ORDER BY id', actualPeriod);
  const result = [];

  for (const user of users) {
    if (monthly && user.id !== manager) continue;
    if (actor.role !== 'admin' && actor.id !== user.id) continue;
    for (const kind of user.id === manager ? ['personal', 'management'] : ['personal']) {
      // Personal orders share the monthly sales policy, including the manager's
      // own orders. Only team management keeps its separate cumulative period.
      if (monthly && kind === 'personal') continue;
      const matching = contracts.filter(c => kind === 'personal' ? c.owner_id === user.id : c.owner_id !== manager);
      const contractIssues = new Map();
      const addIssue = (contract, code, message, pending = true) => {
        const value = commissionDiagnostic({ contract_id: contract.id, contract_name: contract.name, code, message, pending, component: 'legacy' }, { salesId: contract.owner_id });
        contractIssues.set(`${contract.id}:${code}`, value);
      };
      const inputs = [];
      let unknownBase = false;

      for (const contract of matching) {
        const rows = items.filter(item => item.contract_id === contract.id);
        // The confirmed team rule is independent of a contract's historical
        // personal-policy marker and item rebate. Preserve those markers.
        const strategyPending = kind !== 'management' && contract.commission_policy !== 'legacy';
        const missingRate = kind !== 'management' && rows.some(item => item.rate == null);
        const structurePending = rows.length === 0 || rows.reduce((sum, item) => sum + item.amount, 0) !== contract.amount;
        if (strategyPending) addIssue(contract, 'commission_policy_pending', '该合同的管理计提口径待确定，已知毛利暂按现有累计毛利规则试算');
        if (missingRate && !strategyPending) addIssue(contract, 'legacy_rate_pending', '合同原提成比例未明确，管理计提暂按现有累计毛利比例试算');
        if (structurePending) {
          addIssue(contract, 'contract_items_incomplete', '合同明细或金额不完整，已知毛利仅供暂算');
          unknownBase = true;
        }
        if (contract.terminated_at) addIssue(contract, 'contract_terminated', '合同已终止，当前仍按保留的合同账务计算，请核对提成处理', false);

        let received = 0;
        let receiptPending = false;
        if (policy.unlock_by_payment) {
          const paid = receipts.filter(payment => payment.contract_id === contract.id);
          receiptPending = paid.some(payment => !payment.pay_date);
          received = paid.filter(payment => payment.pay_date && payment.pay_date <= today()).reduce((sum, payment) => sum + payment.amount, 0);
          if (receiptPending) addIssue(contract, 'receipt_date_missing', '已到账流水缺少到账日期，毛利解锁比例仅按有明确日期的回款暂算');
        }
        const factor = policy.unlock_by_payment ? Math.max(0, Math.min(1, received / contract.amount)) : 1;
        for (const item of rows) {
          const known = amountKnown(item.margin);
          if (!known) {
            unknownBase = true;
            addIssue(contract, 'margin_missing', '合同明细毛利尚未明确，该部分金额待完善信息');
          }
          inputs.push({
            item_id: item.id, contract_id: contract.id, contract_name: contract.name,
            owner_id: contract.owner_id, kind: item.kind, product: item.name, component: 'legacy',
            base: known ? Math.round(item.margin * factor) : null,
            rebate_rate: item.rate, policy_pending: strategyPending || missingRate,
            source_pending: structurePending || receiptPending,
          });
        }
        if (!rows.length) inputs.push({
          item_id: null, contract_id: contract.id, contract_name: contract.name,
          owner_id: contract.owner_id, kind: null, product: '合同明细待完善', component: 'legacy',
          base: null, rebate_rate: null, policy_pending: strategyPending, source_pending: true,
        });
      }

      const numericInputs = inputs.filter(line => line.base != null);
      const base = numericInputs.reduce((sum, line) => sum + line.base, 0);
      const definitiveBase = numericInputs.filter(line => !line.policy_pending && !line.source_pending).reduce((sum, line) => sum + line.base, 0);
      const rateFor = value => value > policy.threshold ? policy.high_rate : policy.low_rate;
      const rate = rateFor(base);
      // The pool uses a whole-base band. Missing or provisionally included base
      // can change the rate of otherwise complete rows; label those rows too.
      const ratePending = unknownBase || inputs.some(line => line.source_pending) || rateFor(definitiveBase) !== rate;
      let cumulative = 0;
      let allocated = 0;
      const lines = inputs.map(line => {
        const known = line.base != null;
        let entitlement = null;
        if (known) {
          cumulative += line.base;
          entitlement = Math.round(cumulative * rate) - allocated;
          allocated += entitlement;
        }
        return {
          ...line, rate, entitlement, amount: entitlement, known,
          amount_pending: !known,
          provisional: !known || line.policy_pending || line.source_pending || ratePending,
        };
      });
      const hasPendingAmount = inputs.some(line => line.base == null) || unknownBase;
      const estimated = numericInputs.length || !inputs.length ? Math.round(base * rate) : null;
      const definitiveLines = lines.filter(line => line.known && !line.provisional);
      const calculated = definitiveLines.length || !inputs.length ? definitiveLines.reduce((sum, line) => sum + line.entitlement, 0) : null;
      const ownBatches = batches.filter(batch => batch.sales_id === user.id && batch.kind === kind);
      const historicalConfirmed = ownBatches.reduce((sum, batch) => sum + batch.amount, 0);
      const paid = ownBatches.filter(batch => batch.status === 'paid').reduce((sum, batch) => sum + batch.amount, 0);
      const unpaid = estimated == null ? null : estimated - paid;
      const notices=[];
      const notice=(code,message)=>notices.push(commissionDiagnostic({code,message,pending:false},{salesId:user.id,defaultPending:false}));
      if (!user.active) notice('inactive_member','该成员账号已停用，历史业务及发放记录仍列示');
      if (estimated != null && estimated < 0) notice('negative_margin','当前累计毛利为负，提成为负值参考');
      if (paid > 0 && unpaid != null && unpaid < 0) notice('paid_above_current','当前实时提成低于已登记发放金额，请核对历史发放与资料变化');
      const issues = [...contractIssues.values()].map(issue => `${issue.contract_name}：${issue.message}`).concat(notices.map(issue=>issue.message));
      const previous = legacyPreviews.find(preview => preview.sales_id === user.id && preview.kind === kind && preview.period === actualPeriod);
      const pendingCount = new Set([...contractIssues.values()].filter(issue=>issue.pending).map(issue => issue.contract_id)).size;
      const input = {
        sales_id: user.id, kind, period: actualPeriod, scheme: 'legacy-realtime',
        base, rate, calculated_total: calculated, estimated_total: estimated,
        lines, contract_issues: [...contractIssues.values()], notices, paid,
        unlock_by_payment: !!policy.unlock_by_payment,
      };
      result.push({
        ...input, name: user.name, active: user.active, inactive: user.active === 0, total: estimated,
        confirmed: historicalConfirmed, historical_confirmed: historicalConfirmed,
        historical_due: previous?.due ?? (estimated == null ? null : estimated - historicalConfirmed),
        unpaid_amount: unpaid, due: unpaid, amount_pending: hasPendingAmount,
        partial: hasPendingAmount || lines.some(line => line.provisional),
        provisional: lines.some(line => line.provisional), rate_pending: ratePending,
        pending_count: pendingCount, issues: [...new Set(issues)], blocked: false,
        fingerprint: digest({ ...input, batches: ownBatches, policy }),
      });
    }
  }
  return result;
}
