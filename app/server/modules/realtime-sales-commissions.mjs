import {createHash} from 'node:crypto';
import {all} from '../database.mjs';
import {today} from '../domain.mjs';
import {allocate,bandFor} from '../sales-policy.mjs';
import {commissionInputs} from './commission-inputs.mjs';
import {receiptMarginLedger,RECEIPT_MARGIN_SCHEME,roundRate,isServiceItem} from './receipt-margins.mjs';
import {commissionDiagnostic,commissionTier} from './commission-diagnostics.mjs';

// This is a read model. Historical confirmation snapshots deliberately remain
// untouched, and do not reduce the current entitlement shown on this page.
export function realtimeSalesCommissionPreviews(db,rules,actor,month,performanceFor,manager) {
  const policy=rules.commission.sales_policy;
  if(!policy)return [];
  const day=today();
  const users=all(db,"SELECT * FROM users WHERE (role='sales' OR id=?) AND business_member=1 AND developer_admin=0 ORDER BY id",manager||0);
  const contracts=all(db,"SELECT * FROM contracts WHERE retired_at IS NULL AND lifecycle!='草稿' AND sign_date<=? ORDER BY id",day);
  const receipts=all(db,"SELECT * FROM payments WHERE status='已到账' ORDER BY pay_date,id");
  const inputs=commissionInputs(db,month),ledger=receiptMarginLedger(db,month);
  const batches=all(db,"SELECT * FROM commission_batches WHERE kind='personal' AND period=?",month);
  const legacySettled=new Set(all(db,"SELECT DISTINCT contract_id FROM commission_lines l JOIN commission_batches b ON b.id=l.batch_id WHERE b.kind='personal' AND l.component='legacy'").map(l=>l.contract_id));
  const relevant=u=>u.active!==0||batches.some(b=>b.sales_id===u.id)||inputs.claims.some(p=>p.sales_id===u.id)||contracts.some(c=>c.owner_id===u.id&&(c.sign_date.startsWith(month)||receipts.some(p=>p.contract_id===c.id&&(p.pay_date?.startsWith(month)||!p.pay_date&&p.created_at?.startsWith(month)))));
  return users.filter(u=>relevant(u)&&(actor.role==='admin'||actor.role==='sales'&&actor.id===u.id)).map(user=>{
    const fixedGrade=user.id===manager;
    const performance=fixedGrade?{grade:'A',status:'fixed',review_id:null}:performanceFor(db,rules,user,month),grade=performance.grade;
    const contractIssues=[],notices=[],productBases=[],serviceBases=[],evidence=[],unresolved=[],excludedContracts=[];
    const owned=contracts.filter(c=>c.owner_id===user.id);
    let productIncomplete=false,serviceIncomplete=false;
    function issue(contract,code,message,{component=null,pending=true,...extra}={}) {
      const value=commissionDiagnostic({contract_id:contract.id,contract_name:contract.name,code,message,display_message:`${contract.name}：${message}`,component,pending,...extra},{salesId:user.id});
      if(!contractIssues.some(i=>i.contract_id===value.contract_id&&i.code===code&&i.message===message))contractIssues.push(value);
    }
    function unresolvedLine(contract,component,message,base=null) {
      unresolved.push({item_id:null,contract_id:contract.id,contract_name:contract.name,owner_id:user.id,product:'待完善依据',component,base,rate:null,entitlement:null,amount:null,known:false,amount_pending:true,provisional:true,pending_reason:message});
    }
    for(const contract of owned) {
      const actual=ledger.rows.filter(r=>r.contract_id===contract.id);
      const claims=ledger.claims.filter(r=>r.contract_id===contract.id);
      if(!actual.length&&!claims.length)continue;
      if(legacySettled.has(contract.id)) {
        const reason='该合同存在旧口径个人提成记录，尚未确定是否切换月度口径，请管理员核对历史依据';
        issue(contract,'legacy_settlement',reason);
        excludedContracts.push({contract_id:contract.id,contract_name:contract.name,reason,scheme:'legacy-history'});
        productIncomplete=true;serviceIncomplete=true;unresolvedLine(contract,'unknown',reason);continue;
      }
      for(const claim of claims){issue(contract,'receipt_source_claim',claim.reason);unresolvedLine(contract,'unknown',claim.reason);productIncomplete=true;serviceIncomplete=true;}
      for(const receipt of actual){
        const {items,...proof}=receipt;evidence.push(proof);
        const diagnostics=receipt.issues.filter(v=>!v.startsWith('服务毛利或服务金额缺失'));
        for(const message of diagnostics){
          const code=/日期/.test(message)?'receipt_date_missing':/分配/.test(message)?'receipt_split_missing':/超过/.test(message)?'receipt_split_exceeded':/分类|明细/.test(message)?'contract_items_incomplete':'margin_missing';
          issue(contract,code,message,{payment_id:receipt.payment_id});
        }
        if(receipt.source_basis)issue(contract,'source_split','合同明细尚待补齐，当前仅按已核验来源暂算');
        const append=(component,base,rows)=>{
          if(base===null){const reason=component==='product'?'产品回款毛利依据待补齐':'开发运维实际回款依据待补齐';unresolvedLine(contract,component,reason);if(component==='product')productIncomplete=true;else serviceIncomplete=true;return;}
          if(base===0)return;
          const result=allocate(base,rows).map(i=>({...i,contract_name:contract.name,owner_id:user.id,component,provisional:!!receipt.source_basis}));
          (component==='product'?productBases:serviceBases).push(...result);
        };
        if(!receipt.allocation_valid){unresolvedLine(contract,'unknown',diagnostics.join('；')||'本笔到账依据待补齐');productIncomplete=true;serviceIncomplete=true;continue;}
        append('product',receipt.product_gross_margin,items.filter(i=>i.kind==='标品'));
        if(receipt.service_received>0&&!receipt.service_classification_confirmed){unresolvedLine(contract,'service','服务分类待核对，仅定开、运维属于开发运维');serviceIncomplete=true;}
        else append('service',receipt.service_received,items.filter(isServiceItem));
      }
      if(contract.terminated_at)issue(contract,'contract_terminated','合同已终止，仍按保留的实际到账核对提成',{pending:false});
    }
    const productBase=productBases.reduce((s,i)=>s+i.base,0),serviceBase=serviceBases.reduce((s,i)=>s+i.base,0);
    const activeContractIds=new Set([...productBases,...serviceBases,...unresolved].map(l=>l.contract_id));
    if(activeContractIds.size&&!grade)for(const c of owned.filter(c=>activeContractIds.has(c.id)))issue(c,'performance_missing','当月绩效等级尚未确定，相关金额待完善',{component:'performance'});
    if(activeContractIds.size&&grade&&!fixedGrade&&performance.status!=='confirmed')notices.push({code:'performance_live',message:'按当前绩效等级实时计算，绩效变化后金额自动更新',pending:false});
    if(month<policy.effective_month)notices.push({code:'before_policy_effective',message:`所选月份早于规则生效月份 ${policy.effective_month}，本页仅按现行规则参考计算，历史记录保持不变`,pending:false});
    if(serviceBase>0&&!policy.service_scope_confirmed)for(const c of owned.filter(c=>serviceBases.some(l=>l.contract_id===c.id)))issue(c,'service_scope_unconfirmed','项目服务选档范围尚待确定，当前按现有配置暂算',{component:'service'});
    // A missing monthly product allocation can alter the tier of every known
    // product receipt. Keep those numbers visible, but label them provisional.
    const productProvisional=productIncomplete||productBases.some(i=>i.provisional);
    if(productIncomplete&&productBases.length)notices.push({code:'product_basis_incomplete',message:'部分产品依据尚未明确，已知金额按当前基数暂算，补齐后可能调整档位',pending:false});
    const serviceMonthlyProvisional=policy.service_aggregation==='month'&&(serviceIncomplete||serviceBases.some(i=>i.provisional));
    const productBand=bandFor(policy.product,productBase),productRate=productBase===0?0:productBand?.rates[grade]??null;
    const serviceGroups=new Map();
    for(const line of serviceBases) {
      const key=policy.service_aggregation==='month'?'month':line.contract_id;
      if(!serviceGroups.has(key))serviceGroups.set(key,[]);
      serviceGroups.get(key).push(line);
    }
    const lines=[];
    function price(rows,rate,component,provisional=false,tier=null) {
      let base=0,allocated=0;
      for(const i of rows) {
        base+=i.base;
        const entitlement=rate===null?null:roundRate(base,rate)-allocated;
        if(entitlement!==null)allocated+=entitlement;
        const pendingReason=rate!==null?null:!grade?'当月绩效等级尚未确定，相关金额待完善':'当前档位提成比例待核实';
        if(pendingReason)issue({id:i.contract_id,name:i.contract_name},rate===null&&!grade?'performance_missing':'rate_missing',pendingReason,{component});
        lines.push({item_id:i.id,contract_id:i.contract_id,contract_name:i.contract_name,owner_id:user.id,kind:i.kind,product:i.name,component,base:i.base,rebate_rate:i.rate,rate,entitlement,amount:entitlement,known:rate!==null&&!provisional&&!i.provisional,amount_pending:rate===null,provisional:provisional||!!i.provisional,...(tier?{tier,tier_scope:tier.scope}:{}),...(pendingReason?{pending_reason:pendingReason}:{})});
      }
      return rows.length&&rate===null?null:allocated;
    }
    const productTier=commissionTier(policy.product,productBase,{grade,basisComplete:!productProvisional});
    price(productBases,productRate,'product',productProvisional,productTier);
    for(const group of serviceGroups.values()) {
      const base=group.reduce((s,i)=>s+i.base,0),rate=bandFor(policy.service,base)?.rates[grade]??null;
      const tier=commissionTier(policy.service,base,{grade,basisComplete:!serviceMonthlyProvisional&&!group.some(i=>i.provisional),scope:policy.service_aggregation,ruleConfirmed:policy.service_scope_confirmed});
      price(group,rate,'service',!policy.service_scope_confirmed||serviceMonthlyProvisional,tier);
    }
    lines.push(...unresolved);
    const numeric=lines.filter(l=>l.amount!==null),known=lines.filter(l=>l.known&&l.amount!==null);
    const estimatedTotal=numeric.length?numeric.reduce((s,l)=>s+l.amount,0):lines.length?null:0;
    const calculatedTotal=known.length?known.reduce((s,l)=>s+l.amount,0):lines.length?null:0;
    const locked=batches.filter(b=>b.sales_id===user.id),confirmed=locked.reduce((s,b)=>s+b.amount,0),paid=locked.filter(b=>b.status==='paid').reduce((s,b)=>s+b.amount,0);
    if(locked.some(b=>{try{return JSON.parse(b.snapshot).scheme!==RECEIPT_MARGIN_SCHEME;}catch{return true;}}))notices.push({code:'historical_scheme',message:'存在其他算法的历史记录，实时金额与历史账单分开展示',pending:false});
    if(estimatedTotal!==null&&paid>estimatedTotal)notices.push({code:'paid_above_current',message:'历史已登记发放高于当前实时金额，请核对资料修正或发放记录',pending:false});
    if(user.active===0)notices.push({code:'inactive_member',message:'该成员账号已停用，当期业务和历史记录仍可查阅',pending:false});
    for(let i=0;i<notices.length;i++)notices[i]=commissionDiagnostic(notices[i],{salesId:user.id,defaultPending:false});
    const components=['product','service'].map(type=>{
      const part=lines.filter(l=>l.component===type),numbers=part.filter(l=>l.amount!==null),determinate=part.filter(l=>l.known&&l.amount!==null);
      const basisPending=type==='product'?productIncomplete:serviceIncomplete;
      const total=numbers.length?numbers.reduce((s,l)=>s+l.amount,0):part.length||basisPending?null:0;
      return {type,label:type==='product'?'产品回款毛利':'开发运维回款',basis:type==='product'?'当月产品实际回款 × 合同有效产品毛利率，按毛利合计选档':policy.service_aggregation==='contract'?'每份合同的定开、运维实际回款选档':'当月定开、运维实际回款合计选档',base:type==='product'?productBase:serviceBase,rate:type==='product'?productBase===0&&basisPending?null:productRate:!serviceGroups.size&&!basisPending?0:serviceGroups.size===1?part.find(l=>l.kind)?.rate??null:null,total,estimated_total:total,calculated_total:determinate.length?determinate.reduce((s,l)=>s+l.amount,0):part.length||basisPending?null:0,amount_pending:basisPending||part.some(l=>l.amount===null),partial:basisPending||part.some(l=>l.amount===null||l.provisional),provisional:part.some(l=>l.provisional)};
    });
    const issues=[...new Set([...contractIssues.map(i=>`${i.contract_name}：${i.message}`),...notices.map(i=>i.message)])];
    const pendingContracts=new Set(contractIssues.filter(i=>i.pending).map(i=>i.contract_id));
    const amountPending=lines.some(l=>l.amount===null),partial=amountPending||lines.some(l=>l.provisional);
    const input={sales_id:user.id,kind:'personal',period:month,scheme:RECEIPT_MARGIN_SCHEME,policy_version:policy.version,policy,grade,grade_source:fixedGrade?'fixed_A':'performance',performance_status:performance.status,review_id:performance.review_id,components,lines,evidence,confirmed,paid,contract_issues:contractIssues,notices,issues,product_tier:productTier,calculation_scope:'monthly-policy-only',excluded_contracts:excludedContracts};
    const scenarios=fixedGrade?null:['D','C','B','A'].map(g=>{
      const pr=productBase?productBand?.rates[g]:0;
      const services=[...serviceGroups.values()].map(group=>{const base=group.reduce((s,i)=>s+i.base,0),rate=bandFor(policy.service,base)?.rates[g];return rate==null?null:Math.round(base*rate);});
      return {grade:g,product:pr==null?null:Math.round(productBase*pr),service:services.some(v=>v===null)?null:services.reduce((s,v)=>s+v,0)};
    });
    return {...input,name:user.name,active:user.active!==0,realtime:true,base:productBase+serviceBase,rate:estimatedTotal===null?null:productBase+serviceBase?estimatedTotal/(productBase+serviceBase):0,total:estimatedTotal,estimated_total:estimatedTotal,calculated_total:calculatedTotal,known_line_count:known.length,amount_pending:amountPending,partial,pending_count:pendingContracts.size,issue_count:contractIssues.length+notices.length,confirmed,paid,historical_due:estimatedTotal===null?null:estimatedTotal-confirmed,unpaid_amount:estimatedTotal===null?null:estimatedTotal-paid,due:estimatedTotal===null?null:estimatedTotal-paid,blocked:false,scenarios,fingerprint:createHash('sha256').update(JSON.stringify(input)).digest('hex')};
  });
}
