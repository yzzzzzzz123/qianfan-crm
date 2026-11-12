const finite = value => typeof value === 'number' && Number.isFinite(value);
const text = value => String(value ?? '').trim();
const normalize = value => text(value).normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/g, ' ');
const valueOf = (object, key, fallback) => Object.hasOwn(object, key) ? object[key] : fallback;
const money = value => finite(value) ? value / 100 : '';
const estimated = row => valueOf(row, 'estimated_total', row.total);
const userFor = (S, id) => (S.users || []).find(user => Number(user.id) === Number(id));
const userName = (S, id) => userFor(S, id)?.name || (Number(S.actor?.id) === Number(id) ? S.actor.name : '未明确');
const actualContract = (S, id) => (S.contracts || []).find(contract => Number(contract.id) === Number(id));
export const isMonthlyManagement = row => row.kind === 'management' && /^\d{4}-\d{2}$/.test(row.period) &&
  (row.calculation_scope === 'monthly-team-receipt-margin' || row.scheme === 'sales-receipt-margin-v2');
const messageOf = issue => typeof issue === 'string' ? issue : issue.message || issue.reason || '信息待完善';

const issueActions = {
  receipt_split_missing: ['payment-allocation', 'sales'], receipt_split_exceeded: ['payment-allocation', 'sales'],
  receipt_date_missing: ['payment-allocation', 'sales'], receipt_source_claim: ['payment-allocation', 'sales'],
  receipt_date_conflict: ['payment-allocation', 'sales'], receipt_prior_incomplete: ['payment-allocation', 'sales'],
  product_basis_incomplete: ['payment-allocation', 'sales'], contract_split_missing: ['contract-items', 'sales'],
  source_split: ['contract-items', 'sales'], contract_items_incomplete: ['contract-items', 'sales'], margin_missing: ['contract-items', 'sales'],
  performance_missing: ['performance', 'admin'], rate_missing: ['sales-policy', 'admin'],
  service_scope_unconfirmed: ['sales-policy', 'admin'], commission_policy_pending: ['manager-policy', 'admin'],
  legacy_rate_pending: ['manager-policy', 'admin'], legacy_settlement: ['contract', 'admin'],
  contract_terminated: ['contract', 'admin'],
};
const actionLabels = {
  'payment-allocation': '核对到账', 'contract-items': '补充合同明细', performance: '设置当月绩效',
  'sales-policy': '设置提成比例', 'manager-policy': '核对合同规则', contract: '查看合同',
};
const receiptActionLabels = {
  receipt_date_missing: '补到账日期',
  receipt_date_conflict: '核对这笔到账',
  receipt_split_missing: '补产品回款分配',
  receipt_split_exceeded: '核对这笔分配',
};
const ordinaryMessage = message => /按当前绩效等级实时计算|已停用.*仍列示|存在其他算法的历史记录|早于规则生效月份|当前累计毛利为负|历史已登记发放高于|当前实时提成低于已登记发放/.test(message);

// Structured diagnostics are authoritative. Flat issues are retained only when
// they have no structured counterpart, so a notice never becomes a second task.
export function commissionIssues(row) {
  const result = [], seen = new Set(), aliases = new Set();
  const append = (source, notice = false) => {
    const message = messageOf(source);
    const issue = typeof source === 'string' ? { message } : { ...source, message };
    const key = `${issue.contract_id ?? ''}\u0000${issue.code || ''}\u0000${issue.payment_id ?? ''}\u0000${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    const fallback = issueActions[issue.code] || [];
    issue.pending = issue.pending === undefined ? !(notice || ordinaryMessage(message)) : !!issue.pending;
    issue.action = Object.hasOwn(issue, 'action') ? issue.action : fallback[0] || null;
    issue.responsibility = Object.hasOwn(issue, 'responsibility') ? issue.responsibility : fallback[1] || null;
    result.push(issue);
    aliases.add(message);
    aliases.add(issue.display_message || `${issue.contract_name || ''}：${message}`);
  };
  for (const issue of row.contract_issues || []) append(issue);
  for (const issue of row.notices || []) {
    if (!aliases.has(messageOf(issue))) append(issue, true);
  }
  for (const issue of row.issues || []) {
    if (!aliases.has(messageOf(issue))) append(issue);
  }
  return result;
}

export function isCommissionPending(row) {
  return !!(!finite(estimated(row)) || row.amount_pending || row.partial || row.provisional || row.rate_pending || row.pending_count || commissionIssues(row).some(issue => issue.pending));
}

export function commissionAmountStatus(row) {
  if (!finite(estimated(row))) return '待完善信息';
  return isCommissionPending(row) ? '暂算 / 待完善' : '已计算';
}

function roleVisible(S, row) {
  if (!S.actor || !['admin', 'sales'].includes(S.actor.role)) return false;
  const member = userFor(S, row.sales_id);
  if (member && (member.business_member === 0 || member.business_member === false || member.developer_admin === 1 || member.developer_admin === true)) return false;
  return S.actor.role === 'admin' || row.kind === 'personal' && Number(row.sales_id) === Number(S.actor.id);
}

function searchText(S, row, historical = false) {
  const lines = historical ? row.snapshot?.lines || [] : row.lines || [];
  const issues = historical ? row.snapshot?.contract_issues || [] : row.contract_issues || [];
  const messages = commissionIssues(historical ? row.snapshot || {} : row).flatMap(issue => [issue.message, issue.display_message]);
  const ids = new Set([...lines, ...issues, ...(row.evidence || [])].map(line => line.contract_id).filter(id => id != null));
  const contracts = [...ids].map(id => actualContract(S, id)).filter(Boolean);
  return normalize([row.name || userName(S, row.sales_id), row.period, ...lines.flatMap(line => [line.contract_name, line.contract_no, line.product]), ...issues.map(issue => issue.contract_name), ...messages, ...contracts.flatMap(contract => [contract.name, contract.contract_no, contract.code])].filter(Boolean).join(' '));
}

function matchesSearch(S, row, query, historical = false) {
  return !query || normalize(query).split(' ').filter(Boolean).every(word => searchText(S, row, historical).includes(word));
}

export function selectCommissionRows(S, P = {}) {
  const data = S.commission || {}, selected = text(data.period || S.today?.slice(0, 7));
  const previews = data.realtime_previews || data.previews || [];
  return previews.filter(row => {
    if (!roleVisible(S, row)) return false;
    if (S.actor.role === 'admin' && P.owner && Number(row.sales_id) !== Number(P.owner)) return false;
    if (selected && row.period !== selected) return false;
    if (P.commissionStatus === 'pending' && !isCommissionPending(row)) return false;
    if (P.commissionStatus === 'calculated' && isCommissionPending(row)) return false;
    return matchesSearch(S, row, P.commissionQ);
  }).sort((a, b) => Number(a.sales_id) - Number(b.sales_id) || Number(a.kind === 'management') - Number(b.kind === 'management'));
}

export function selectCommissionHistory(S, P = {}) {
  const selected = text(P.commissionHistoryPeriod || S.commission?.period);
  return (S.commission?.batches || []).filter(row => roleVisible(S, row)
    && (S.actor?.role !== 'admin' || !P.owner || Number(row.sales_id) === Number(P.owner))
    && (!selected || row.period === selected)
    && matchesSearch(S, row, P.commissionQ, true));
}

function contractsForIssue(S, row, issue) {
  const listed = [...(issue.contracts || [])].map(contract => ({ id: contract.id ?? contract.contract_id, name: contract.name || contract.contract_name || '' }));
  if (issue.contract_id != null) listed.unshift({ id: issue.contract_id, name: issue.contract_name || actualContract(S, issue.contract_id)?.name || '查看合同' });
  return listed.filter((contract, index, all) => contract.id != null && all.findIndex(other => Number(other.id) === Number(contract.id)) === index);
}

// Global rule/performance tasks are grouped per beneficiary and actual period;
// contract tasks retain every source instead of repeating one item per line.
export function commissionIssueRows(S, P = {}) {
  const tasks = new Map();
  for (const row of selectCommissionRows(S, P)) {
    const issues = commissionIssues(row).filter(issue => issue.pending);
    for (const issue of issues) {
      if (issue.code === 'product_basis_incomplete' && issues.some(other => other.code?.startsWith('receipt_'))) continue;
      const global = ['performance', 'sales-policy', 'manager-policy'].includes(issue.action);
      const key = [row.sales_id, row.period, row.kind, global ? '' : issue.contract_id || '', issue.code || issue.message, issue.payment_id ?? ''].join(':');
      const contracts = contractsForIssue(S, row, issue);
      const contract = actualContract(S, issue.contract_id);
      const responsibleId = issue.responsible_id ?? issue.owner_id ?? contract?.owner_id ?? issue.sales_id ?? row.sales_id;
      const responsible = issue.responsibility === 'admin' ? '管理员' : issue.responsibility === 'sales' ? userName(S, responsibleId) : '待明确';
      const task = tasks.get(key);
      if (task) {
        if (!task.messages.includes(issue.message)) task.messages.push(issue.message);
        for (const source of contracts) if (!task.contracts.some(existing => Number(existing.id) === Number(source.id))) task.contracts.push(source);
        task.message = task.messages.join('；');
      } else {
        tasks.set(key, {
          ...issue, key, sales_id: row.sales_id, sales_name: row.name || userName(S, row.sales_id), period: row.period, kind: row.kind,
          contract_id: contracts[0]?.id ?? null, contract_name: contracts[0]?.name || '', contracts,
          messages: [issue.message], responsible_id: issue.responsibility === 'sales' ? responsibleId : null,
          responsible_label: responsible, action_label: (issue.payment_id && receiptActionLabels[issue.blocking_code || issue.code]) || (issue.code === 'margin_missing' ? '补充毛利' : actionLabels[issue.action] || '查看合同'),
          can_handle: S.actor?.role === 'admin' || issue.responsibility === 'sales' && Number(responsibleId) === Number(S.actor?.id),
        });
      }
    }
  }
  return [...tasks.values()].map(task => ({...task,...commissionIssuePresentation(S,task)}));
}

// Describe the missing input and its effect without inventing missing amounts.
export function commissionIssuePresentation(S, task) {
  const scope = task.kind === 'management' ? `${task.sales_name}的团队管理提成` : `${task.sales_name}的个人提成`;
  const blockingField = {
    receipt_date_missing:'缺少实际到账日期',
    receipt_date_conflict:'实际到账日期早于合同签约日',
    receipt_split_missing:'缺少有效的产品回款分配',
  }[task.blocking_code];
  const priorDetail = blockingField ? `原流水${blockingField}，请打开这笔流水核对。` : '请核对前序流水的到账日期和回款分配。';
  const copy = {
    margin_missing:['缺少合同毛利','请补充合同明细中的毛利金额或毛利率。','未计入提成',`缺失毛利对应的部分尚未计入${scope}。`],
    receipt_source_claim:['缺少到账明细','来源只标记了结清，缺少足额的到账记录，请核对实际到账金额和日期。','未计入提成',`缺少到账依据的部分尚未计入${scope}。`],
    receipt_date_missing:['缺少到账日期','这笔款已登记到账，请补充实际到账日期。系统按到账月份计算提成。','未计入提成',`缺少日期的到账尚未计入${scope}。`],
    receipt_date_conflict:['到账早于签约','这笔款已登记到账，请核对实际到账日期与合同签约日。','暂缓计提',`日期待核对的到账尚未计入${scope}。`],
    receipt_prior_incomplete:['前序到账资料待补',priorDetail,'暂缓计提',`相关流水已登记到账，前序资料补齐后会重新计算${scope}。`],
    receipt_split_missing:['缺少产品回款分配','请填写这笔到账中有多少属于产品，其余金额为服务回款。','未计入提成',`无法区分产品与服务的到账尚未计入${scope}，其他产品金额可能仍为暂算。`],
    receipt_split_exceeded:['回款分配超过合同金额','请核对产品与服务的累计到账分配，修正超出合同金额的部分。','未计入提成',`存在冲突的到账尚未计入${scope}。`],
    performance_missing:['缺少当月绩效等级','请设置对应月份的绩效等级，系统据此选择个人提成比例。','未计入提成','依赖该等级的个人提成尚未计算。'],
    rate_missing:['当前档位缺少提成比例','请在个人提成规则中填写当前档位、对应等级的提成比例。','未计入提成','缺少比例的部分尚未计入个人提成，其他明确金额继续计算。'],
    service_scope_unconfirmed:['开发运维选档范围未确认','请确认开发运维按当月合计还是按单份合同选档。','当前为暂算','开发运维提成按现有配置暂算，范围确认后可能调整。'],
    source_split:['合同明细需核对','当前使用已核验的来源资料，请补齐对应合同明细。','当前为暂算','该合同已按现有依据暂算，补齐资料后金额可能调整。'],
    legacy_settlement:['合同有历史提成记录','请核对原提成记录及适用规则，避免同一合同重复计提。','未计入提成','该合同暂未纳入当前个人月度计算，历史金额保持原样。'],
    commission_policy_pending:['合同适用规则需核对','请核对该合同原有提成约定；调整全局比例不会修改合同的历史规则标记。','当前为暂算','该合同按原累计规则暂算，适用规则尚待核对。'],
    legacy_rate_pending:['合同原提成依据需核对','请核对该合同原有提成约定及明细。','当前为暂算','该合同按原累计规则暂算，原依据尚待核对。'],
  }[task.code];
  const details=(task.contracts||[]).map(source=>{
    const contract=actualContract(S,source.id);
    return {...source,number:contract?.contract_no||contract?.code||'',title:[source.name,contract?.contract_no||contract?.code].filter(Boolean).join(' · ')};
  });
  const hasKnown=(S.commission?.realtime_previews||S.commission?.previews||[]).some(row=>row.sales_id===task.sales_id&&row.kind===task.kind&&row.period===task.period&&(row.lines||[]).some(line=>details.some(c=>Number(c.id)===Number(line.contract_id))&&finite(line.entitlement??line.amount)));
  return {title:copy?.[0]||'合同资料需补充',detail:copy?.[1]||task.message,impact:copy?.[2]||(hasKnown?'当前为暂算':'未计入提成'),impact_message:copy?.[3]||(hasKnown?`该合同已按现有依据暂算，补齐资料后${scope}可能调整。`:`缺失依据的部分尚未计入${scope}。`),contracts:details};
}

function componentBase(component) {
  if (!component) return '';
  if (component.base === 0 && !finite(valueOf(component, 'estimated_total', component.total)) && component.amount_pending) return '';
  return money(component.base);
}

function gradeFor(S, row) {
  if (row.kind !== 'personal') return '';
  return row.grade || (row.grade_source === 'fixed_A' ? 'A' : '');
}

function kindName(S, row) {
  return row.kind === 'management' ? '团队管理提成' : '个人提成';
}

function lineAmount(line) {
  return valueOf(line, 'entitlement', finite(line.base) && finite(line.rate) ? Math.round(line.base * line.rate) : null);
}

export function commissionBasisLabel(row, line) {
  if (line.component === 'product') return '产品实际回款毛利';
  if (line.component === 'service') return isMonthlyManagement(row) ? '开发运维实际回款毛利' : '开发运维实际回款';
  if (line.component === 'legacy') return '合同毛利（原口径）';
  return '计提依据待明确';
}

export function buildCommissionExport(S, P = {}) {
  const selected = selectCommissionRows(S, P), tasks = commissionIssueRows(S, P);
  const summaryRows = [['销售', '实际计算周期', '类型', '实时提成预估(元)', '明确可算金额(元)', '金额状态', '绩效等级', '产品回款毛利基数(元)', '产品提成预估(元)', '开发运维实际回款基数(元)', '服务提成预估(元)', '毛利基数(元)', '需完善事项', '信息提示']];
  const detailRows = [['销售', '实际计算周期', '类型', '合同编号', '合同名称', '明细内容', '计提口径', '计提基数(元)', '比例', '当前应计(元)', '金额状态', '信息提示']];
  const issueRows = [['提成人', '实际计算周期', '类型', '资料负责人', '合同编号', '关联合同', '缺少内容及金额影响', '处理方式']];
  for (const row of selected) {
    const personalComponents = row.kind === 'personal' ? row.components : null;
    const product = personalComponents?.find(component => component.type === 'product');
    const service = personalComponents?.find(component => component.type === 'service');
    const actionable = tasks.filter(task => Number(task.sales_id) === Number(row.sales_id) && task.kind === row.kind && task.period === row.period);
    const margin = !personalComponents && !(row.base === 0 && estimated(row) == null) ? money(row.base) : '';
    summaryRows.push([row.name || userName(S, row.sales_id), row.period, kindName(S, row), money(estimated(row)), money(row.calculated_total), commissionAmountStatus(row), gradeFor(S, row), componentBase(product), money(valueOf(product || {}, 'estimated_total', product?.total)), componentBase(service), money(valueOf(service || {}, 'estimated_total', service?.total)), margin, actionable.length, commissionIssues(row).map(issue => issue.display_message || (issue.contract_name ? `${issue.contract_name}：${issue.message}` : issue.message)).join('；')]);
    for (const line of row.lines || []) {
      const contract = actualContract(S, line.contract_id), amount = lineAmount(line);
      const reasons = commissionIssues(row).filter(issue => issue.pending && (issue.contract_id === line.contract_id || !issue.contract_id) && (!issue.component || issue.component === line.component || issue.component === 'performance')).map(issue => issue.message);
      if (line.pending_reason) reasons.unshift(line.pending_reason);
      if (line.provisional && !reasons.length) reasons.push('依据待完善，金额为暂算');
      detailRows.push([row.name || userName(S, row.sales_id), row.period, kindName(S, row), contract?.contract_no || contract?.code || line.contract_no || '', line.contract_name || contract?.name || '', line.product || '', commissionBasisLabel(row, line), line.component === 'unknown' ? '' : money(line.base), finite(line.rate) ? line.rate : '', money(amount), !finite(amount) ? '待完善信息' : line.provisional ? '暂算' : '已计算', [...new Set(reasons)].join('；')]);
    }
  }
  for (const task of tasks) {
    const sources = task.contracts.map(source => ({ ...source, record: actualContract(S, source.id) }));
    issueRows.push([task.sales_name, task.period, kindName(S, task), task.responsible_label, sources.map(source => source.record?.contract_no || source.record?.code || '').filter(Boolean).join('；'), sources.map(source => source.name).join('；'), `${task.title}：${task.detail} ${task.impact}：${task.impact_message}`, S.actor?.role !== 'admin' && task.responsibility === 'admin' ? `需管理员处理：${task.action_label}` : task.action_label]);
  }
  return { summaryRows, detailRows, issueRows };
}
