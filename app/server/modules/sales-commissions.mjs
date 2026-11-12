import {createHash} from 'node:crypto';
import {all} from '../database.mjs';
import {allocate,bandFor} from '../sales-policy.mjs';
import {receiptMarginLedger,RECEIPT_MARGIN_SCHEME,roundRate,isServiceItem} from './receipt-margins.mjs';
import {commissionDiagnostic,createCommissionIssueRecorder,receiptDiagnosticDetails} from './commission-diagnostics.mjs';

const sum=(rows,key)=>rows.reduce((s,r)=>s+(r[key]??0),0);
const schemeOf=batch=>{try{return JSON.parse(batch.snapshot).scheme;}catch{return null;}};
export function salesCommissionPreviews(db,rules,actor,month,performanceFor,manager){
  const policy=rules.commission.sales_policy,teamPolicy=rules.commission;
  const users=all(db,"SELECT * FROM users WHERE active=1 AND business_member=1 AND developer_admin=0 AND (role='sales' OR id=?) ORDER BY id",manager||0);
  const ledger=receiptMarginLedger(db,month),eligible=new Set(users.map(u=>u.id));
  const batches=all(db,'SELECT * FROM commission_batches ORDER BY id');
  const lockedLines=all(db,'SELECT l.*,b.sales_id,b.kind,b.period,b.snapshot FROM commission_lines l JOIN commission_batches b ON b.id=l.batch_id');
  const result=[];
  for(const user of users)for(const kind of user.id===manager?['personal','management']:['personal']){
    if(actor.role!=='admin'&&(actor.role!=='sales'||actor.id!==user.id))continue;
    const management=kind==='management',fixedGrade=!management&&user.id===manager;
    const performance=management?null:fixedGrade?{grade:'A',status:'fixed',review_id:null}:performanceFor(db,rules,user,month);
    const grade=performance?.grade??null,issues=[];
    const belongs=id=>management?eligible.has(id)&&id!==manager:id===user.id;
    const receipts=ledger.rows.filter(r=>belongs(r.sales_id));
    const claims=ledger.claims.filter(r=>belongs(r.sales_id));
    const evidence=receipts.map(({items,...row})=>row);
    const bases=[],cash=sum(receipts.filter(r=>r.date),'amount');
    for(const claim of claims)issues.push(`${claim.contract_name}：${claim.reason}`);
    for(const r of receipts){
      const prefix=`${r.contract_name} · 到账 ${r.date||'日期缺失'}：`;
      // Service margin is needed for management, while personal service uses cash.
      const relevant=r.issues.filter(v=>management||!v.startsWith('服务毛利或服务金额缺失'));
      issues.push(...relevant.map(v=>prefix+v));
      if(r.source_basis)issues.push(prefix+'合同明细尚待补齐，来源字段仅供核对，不可确认结算');
      if(!r.allocation_valid)continue;
      const append=(component,base,rows)=>{
        if(base===null||base<=0)return;
        for(const item of allocate(base,rows))bases.push({...item,item_id:item.id,base:item.base,component,owner_id:r.sales_id,contract_name:r.contract_name});
      };
      append('product',r.product_gross_margin,r.items.filter(i=>i.kind==='标品'));
      if(r.service_classification_confirmed)append('service',management?r.service_gross_margin:r.service_received,r.items.filter(isServiceItem));
    }
    // Aggregate a component/item before subtracting previous confirmations once.
    const groups=new Map();
    for(const row of bases){const key=`${row.component}:${row.item_id}:${row.contract_id}`;const prior=groups.get(key);if(prior)prior.base+=row.base;else groups.set(key,{...row});}
    const productBase=sum(bases.filter(l=>l.component==='product'),'base'),serviceBase=sum(bases.filter(l=>l.component==='service'),'base');
    if(!management&&serviceBase>0&&(!policy.service_scope_confirmed||policy.service_aggregation!=='month'))issues.push('开发运维须确认按当月实际服务回款合计选档，当前规则范围尚未对齐');
    if(!management&&!fixedGrade&&cash>0){
      if(!grade)issues.push('当月绩效等级尚未确定');
      if(performance.status!=='confirmed')issues.push('当月绩效尚未确认锁定，当前仅供试算');
    }
    const productBand=bandFor(policy.product,productBase),serviceBand=bandFor(policy.service,serviceBase);
    const teamRate=productBase+serviceBase>teamPolicy.threshold?teamPolicy.high_rate:teamPolicy.low_rate;
    const productRate=management?teamRate:productBase===0?0:productBand.rates[grade]??null;
    const serviceRate=management?teamRate:serviceBase===0?0:serviceBand.rates[grade]??null;
    if(productBase>0&&grade&&productRate===null)issues.push(`产品回款毛利 ${productBand.min/1000000} 万元起档的 ${grade} 级比例待核实`);
    if(serviceBase>0&&grade&&serviceRate===null)issues.push(`开发运维 ${serviceBand.min/1000000} 万元起档的 ${grade} 级比例待核实`);
    const locked=batches.filter(b=>b.sales_id===user.id&&b.kind===kind&&b.period===month),confirmed=sum(locked,'amount');
    if(locked.some(b=>schemeOf(b)!==RECEIPT_MARGIN_SCHEME))issues.push('同月已有其他算法的结算，须先核对历史快照');
    const contractIds=new Set(receipts.map(r=>r.contract_id));
    if(lockedLines.some(l=>l.kind===kind&&l.sales_id===user.id&&contractIds.has(l.contract_id)&&schemeOf(l)!==RECEIPT_MARGIN_SCHEME))issues.push('到账合同已有其他算法的历史结算，须核对避免重复计提');
    const lines=[];
    const teamProductTotal=management?roundRate(productBase,teamRate):0;
    for(const component of ['product','service']){
      const rate=component==='product'?productRate:serviceRate;
      let cumulative=management&&component==='service'?productBase:0,allocated=management&&component==='service'?teamProductTotal:0;
      for(const row of [...groups.values()].filter(r=>r.component===component)){
        cumulative+=row.base;const entitlement=rate===null?0:roundRate(cumulative,rate)-allocated;allocated+=entitlement;
        const prior=sum(lockedLines.filter(l=>l.sales_id===user.id&&l.kind===kind&&l.period===month&&l.component===component&&l.item_id===row.item_id),'amount');
        if(row.item_id==null)issues.push(`${row.contract_name}：缺少可锁定的合同明细`);
        lines.push({item_id:row.item_id,contract_id:row.contract_id,contract_name:row.contract_name,owner_id:row.owner_id,kind:row.kind,product:row.name,component,base:row.base,rebate_rate:row.rate??0,rate,entitlement,amount:entitlement-prior,
          basis:component==='product'||management?'receipt_gross_margin':'service_receipts'});
      }
    }
    // Each snapshot carries each receipt's commission and exact contract rate.
    for(const component of ['product','service']){
      const rate=component==='product'?productRate:serviceRate;
      let cumulative=management&&component==='service'?productBase:0,allocated=management&&component==='service'?teamProductTotal:0;
      for(const row of evidence){const base=component==='product'?row.product_gross_margin:management?row.service_gross_margin:row.service_classification_confirmed?row.service_received:null;
        if(!row.allocation_valid||base===null||rate===null){row[component+'_commission']=null;continue;}
        cumulative+=base;const next=roundRate(cumulative,rate);row[component+'_commission']=next-allocated;allocated=next;
      }
    }
    const productTotal=management?teamProductTotal:productRate===null?0:roundRate(productBase,productRate);
    const serviceTotal=management?roundRate(productBase+serviceBase,teamRate)-teamProductTotal:serviceRate===null?0:roundRate(serviceBase,serviceRate);
    const total=productTotal+serviceTotal,due=total-confirmed;
    if(due<0||lines.some(l=>l.amount<0))issues.push('当前应计低于已确认金额，请核对差额');
    const components=[{type:'product',label:'产品回款毛利',basis:management?'其他销售当月产品实际到账 × 各合同有效产品毛利率':'当月产品实际到账 × 各合同有效产品毛利率，按毛利合计选档',received_amount:sum(receipts,'product_amount'),gross_margin:sum(receipts,'product_gross_margin'),base:productBase,rate:productRate,total:productTotal},
      {type:'service',label:management?'开发运维回款毛利':'开发运维回款',basis:management?'其他销售当月服务实际到账 × 合同服务毛利率':'当月定开、运维实际服务回款合计选档并计提',received_amount:sum(receipts,'service_received'),gross_margin:sum(receipts,'service_gross_margin'),base:serviceBase,rate:serviceRate,total:serviceTotal}];
    const rates=[...new Set(receipts.filter(r=>r.product_amount>0).map(r=>r.product_margin_rate))];
    const amountPending=claims.length>0||receipts.some(r=>!r.allocation_valid||r.product_gross_margin===null||r.service_received>0&&(!r.service_classification_confirmed||management&&r.service_gross_margin===null))||productRate===null||serviceRate===null;
    const input={sales_id:user.id,kind,period:month,scheme:RECEIPT_MARGIN_SCHEME,policy_version:policy.version,policy,team_policy:management?{threshold:teamPolicy.threshold,low_rate:teamPolicy.low_rate,high_rate:teamPolicy.high_rate}:null,grade,grade_source:fixedGrade?'fixed_A':management?'not_applicable':'performance',performance_status:performance?.status??null,review_id:performance?.review_id??null,components,lines,evidence,source_claims:claims,confirmed,issues:[...new Set(issues)]};
    const scenarios=management||fixedGrade?null:['D','C','B','A'].map(g=>({grade:g,product:productBase===0?0:productBand.rates[g]==null?null:roundRate(productBase,productBand.rates[g]),service:serviceBase===0?0:serviceBand.rates[g]==null?null:roundRate(serviceBase,serviceBand.rates[g])}));
    result.push({...input,name:user.name,base:productBase+serviceBase,base_is_composite:!management,rate:management?teamRate:0,received_amount:cash,product_margin_rate:rates.length===1?rates[0]:null,product_margin_rates_multiple:rates.length>1,total,paid:sum(locked.filter(b=>b.status==='paid'),'amount'),due,blocked:issues.length>0,scenarios,amount_pending:amountPending,fingerprint:createHash('sha256').update(JSON.stringify(input)).digest('hex')});
  }
  return result;
}

export function realtimeTeamCommissionPreview(preview) {
  const contractIssues=[],notices=[];
  const issue=createCommissionIssueRecorder(contractIssues,preview.sales_id);
  const record=(row,code,message,details)=>issue({id:row.contract_id,name:row.contract_name},code,message,{responsible_id:row.sales_id,...details});
  for(const claim of preview.source_claims)record(claim,'receipt_source_claim',claim.reason);
  const evidence=preview.evidence.map(({diagnostics,...receipt})=>{
    for(const diagnostic of diagnostics){
      const code=diagnostic.code==='team_service_margin_missing'?'margin_missing':diagnostic.code;
      record(receipt,code,diagnostic.message,receiptDiagnosticDetails(receipt,diagnostic,receipt.sign_date));
    }
    if(receipt.source_basis)record(receipt,'source_split','合同明细尚待补齐，当前仅按已核验来源暂算');
    if(receipt.terminated_at)record(receipt,'contract_terminated','合同已终止，仍按保留的实际到账核对提成',{pending:false});
    return receipt;
  });
  const pendingContracts=new Set(contractIssues.filter(i=>i.pending).map(i=>i.contract_id));
  const partial=preview.amount_pending||pendingContracts.size>0;
  const lines=preview.lines.map(line=>({...line,amount:line.entitlement,known:!partial,amount_pending:false,provisional:partial}));
  const estimatedTotal=lines.length||!partial?preview.total:null;
  const unpaid=estimatedTotal===null?null:estimatedTotal-preview.paid;
  const components=preview.components.map(component=>{
    const total=estimatedTotal===null?null:component.total;
    return {...component,base:total===null?null:component.base,total,estimated_total:total,calculated_total:partial?null:total,
      rate:estimatedTotal===null?null:component.rate,partial,amount_pending:total===null};
  });
  if(partial&&lines.length)notices.push(commissionDiagnostic({
    code:'team_basis_incomplete',message:'部分回款毛利待补齐，当前金额按已知毛利暂算，补齐后可能调整档位',pending:false,
  },{salesId:preview.sales_id}));
  const issues=[...new Set([...contractIssues.map(i=>i.display_message),...notices.map(i=>i.message)])];
  return {
    ...preview,components,evidence,lines,contract_issues:contractIssues,notices,issues,
    realtime:true,calculation_scope:'monthly-team-receipt-margin',blocked:false,partial,provisional:partial&&lines.length>0,
    rate:estimatedTotal===null?null:preview.rate,total:estimatedTotal,estimated_total:estimatedTotal,calculated_total:partial?null:estimatedTotal,
    historical_due:estimatedTotal===null?null:estimatedTotal-preview.confirmed,due:unpaid,unpaid_amount:unpaid,
    pending_count:pendingContracts.size,issue_count:contractIssues.length+notices.length,rate_pending:partial,
  };
}

export {realtimeSalesCommissionPreviews} from './realtime-sales-commissions.mjs';
