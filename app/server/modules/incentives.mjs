import {assertContractDataAccess,canManageContractData} from '../contract-access.mjs';
import { createHash } from 'node:crypto';
import { all, one } from '../database.mjs';
import { assert, cents, choice, now, period, today, text, validDate, processScore } from '../domain.mjs';
import {salesCommissionPreviews,realtimeSalesCommissionPreviews} from './sales-commissions.mjs';
import {realtimeLegacyCommissionPreviews} from './commission-realtime-legacy.mjs';
import {performancePolicy,performanceDefaults} from '../../public/modules/performance-policy.js';
import {commissionReceiptReview} from './commission-receipts.mjs';
import {commissionInputs} from './commission-inputs.mjs';

export const managerId = (db, rules) => one(db,"SELECT id FROM users WHERE id=? AND active=1 AND role='admin' AND business_member=1 AND developer_admin=0",rules.commission.manager_id||0)?.id || one(db,"SELECT id FROM users WHERE active=1 AND role='admin' AND business_member=1 AND developer_admin=0 ORDER BY id LIMIT 1")?.id;
export function incentivePeriod(day = today(), mode = 'quarter') {
  return mode === 'month' ? day.slice(0,7) : mode === 'year' ? day.slice(0,4) : `${day.slice(0,4)}Q${Math.ceil(Number(day.slice(5,7))/3)}`;
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function commissionPreview(db, rules, actor, requested) {
  const policy = rules.commission;
  const selected = requested || (policy.sales_policy && period()>=policy.sales_policy.effective_month ? period() : incentivePeriod(today(), policy.period));
  assert(/^\d{4}(?:Q[1-4]|-(?:0[1-9]|1[0-2]))?$/.test(selected),'提成周期无效');
  const manager = managerId(db,rules);
  const monthly=/^\d{4}-\d{2}$/.test(selected)&&!!policy.sales_policy;
  const trialOnly=monthly&&selected<policy.sales_policy.effective_month;
  const legacyPeriod=/^\d{4}-\d{2}$/.test(selected)?incentivePeriod(`${selected}-01`,policy.period):selected;
  const items = all(db,`SELECT i.*,c.owner_id,c.sign_date,c.name contract_name,c.contract_no FROM contract_items i JOIN contracts c ON c.id=i.contract_id JOIN users u ON u.id=c.owner_id WHERE i.retired_at IS NULL AND u.business_member=1 AND u.developer_admin=0 AND c.retired_at IS NULL AND c.lifecycle!='草稿' AND c.commission_policy='legacy' AND i.margin IS NOT NULL AND i.rate IS NOT NULL ORDER BY i.id`)
    .filter(i=>incentivePeriod(i.sign_date,policy.period)===legacyPeriod && i.sign_date<=today());
  const batches = all(db,'SELECT b.* FROM commission_batches b JOIN users u ON u.id=b.sales_id WHERE u.business_member=1 AND u.developer_admin=0 ORDER BY b.id DESC');
  const lockedLines = all(db,`SELECT l.*,b.sales_id,b.kind,b.period FROM commission_lines l JOIN commission_batches b ON b.id=l.batch_id`);
  const eligibleUsers = all(db,"SELECT id,name,role FROM users WHERE business_member=1 AND developer_admin=0 AND (role='sales' OR id=?)",manager);
  const result = [];
  for (const user of eligibleUsers) for (const kind of user.id===manager ? ['personal','management'] : ['personal']) {
    if(monthly)continue;
    if (actor.role!=='admin' && (actor.id!==user.id || actor.role==='pm')) continue;
    const matching = items.filter(i=>kind==='personal'?i.owner_id===user.id:i.owner_id!==manager);
    let baseSum=0;
    const bases=matching.map(i=>{
      let base=i.margin;
      if(policy.unlock_by_payment) {
        const paid=one(db,"SELECT COALESCE(SUM(amount),0) n FROM payments WHERE contract_id=? AND status='已到账'",i.contract_id).n;
        const total=one(db,'SELECT amount FROM contracts WHERE id=?',i.contract_id).amount;
        base=Math.round(base*Math.min(1,paid/total));
      }
      baseSum+=base;
      return {...i,base};
    });
    const rate=baseSum>policy.threshold?policy.high_rate:policy.low_rate;
    const locked=batches.filter(b=>b.sales_id===user.id && b.kind===kind && b.period===legacyPeriod);
    const confirmed=locked.reduce((s,b)=>s+b.amount,0);
    let cumulative=0,allocated=0;
    const lines=bases.map(i=>{
      cumulative+=i.base;
      const entitlement=Math.round(cumulative*rate)-allocated;
      allocated+=entitlement;
      const prior=lockedLines.filter(l=>l.sales_id===user.id&&l.kind===kind&&l.period===legacyPeriod&&l.item_id===i.id).reduce((s,l)=>s+l.amount,0);
      return {item_id:i.id,contract_id:i.contract_id,contract_name:i.contract_name,owner_id:i.owner_id,kind:i.kind,product:i.name,base:i.base,rebate_rate:i.rate,rate,amount:entitlement-prior};
    });
    const total=Math.round(baseSum*rate), due=total-confirmed;
    const fingerprint=digest({user:user.id,kind,selected:legacyPeriod,policy,lines,confirmed});
    result.push({sales_id:user.id,name:user.name,kind,period:legacyPeriod,scheme:'legacy',base:baseSum,rate,total,confirmed,paid:locked.filter(b=>b.status==='paid').reduce((s,b)=>s+b.amount,0),due,lines,fingerprint,blocked:due<0||lines.some(l=>l.amount<0),unlock_by_payment:policy.unlock_by_payment});
  }
  if(monthly)result.unshift(...salesCommissionPreviews(db,rules,actor,selected,performanceFor,manager));
  const salesBasis=monthly?commissionInputs(db,selected).basis.filter(p=>actor.role==='admin'||actor.role==='sales'&&p.sales_id===actor.id):[];
  const prepared=result.map(p=>{
    const basis=p.kind==='personal'?salesBasis.find(b=>b.sales_id===p.sales_id):null;
    const pending=p.scheme==='legacy'&&basis?.received_amount>0&&!p.lines.length;
    return {...p,...(basis?{sales_basis:basis}:{}),...(pending?{blocked:true,amount_pending:true,issues:[...(p.issues||[]),'已按销售小二取到实际到账；个人计提合同尚未具备完整的已确认毛利规则，待核对后计算']}:{})};
  });
  const previews=trialOnly?prepared.map(p=>({...p,blocked:true,trial_only:true,issues:[...(p.issues||[]),'所选月份早于规则生效月份，仅按现行 SOP 补算试算，不可确认结算'],fingerprint:digest({fingerprint:p.fingerprint,trial_only:true})})):prepared;
  const visibleBatches=batches.filter(b=>actor.role==='admin'||(actor.role==='sales'&&b.sales_id===actor.id)).map(b=>({...b,snapshot:JSON.parse(b.snapshot)}));
  const realtimeRows=[...(monthly?realtimeSalesCommissionPreviews(db,rules,actor,selected,performanceFor,manager):[]),...realtimeLegacyCommissionPreviews(db,rules,actor,selected,previews)];
  const realtime_previews=realtimeRows.map(p=>{
    const historical=visibleBatches.filter(b=>b.sales_id===p.sales_id&&b.kind===p.kind&&b.period===p.period);
    const paid=historical.filter(b=>b.status==='paid').reduce((s,b)=>s+b.amount,0);
    const row={...p,inactive:p.active===false||p.active===0,blocked:false,historical_confirmed:historical.filter(b=>b.status==='confirmed').reduce((s,b)=>s+b.amount,0),paid,unpaid_amount:p.estimated_total==null?null:p.estimated_total-paid};
    return {...row,fingerprint:digest({row,policy,paid_batches:historical.filter(b=>b.status==='paid').map(b=>({id:b.id,amount:b.amount,paid_at:b.paid_at}))})};
  });
  return {period:selected,mode:monthly?'month':policy.period,legacy_mode:policy.period,trial_only:trialOnly,realtime:true,updated_at:now(),live_pay_enabled:false,realtime_previews,sales_basis:salesBasis,receipt_review:commissionReceiptReview(db,actor,selected),previews,batches:visibleBatches,disbursements:visibleBatches.filter(b=>b.status==='paid').map(b=>({...b,source_batch_id:b.id,note:b.paid_note}))};
}

export function performanceFor(db,rules,user,month=period(),options={}) {
  assert(/^\d{4}-(0[1-9]|1[0-2])$/.test(month),'绩效月份无效');
  const review=one(db,'SELECT * FROM performance_reviews WHERE user_id=? AND month=?',user.id,month);
  if(review?.status==='confirmed'&&!options.recalculate) return {...JSON.parse(review.snapshot),review_id:review.id,status:'confirmed'};
  const opps=all(db,'SELECT * FROM opportunities WHERE archived_at IS NULL');
  const activeOpportunityIds=new Set(opps.map(o=>o.id));
  const events=all(db,'SELECT * FROM activity_events');
  const tracked=new Set(events.map(e=>e.activity_id));
  const legacy=all(db,"SELECT * FROM activities WHERE activity_type!='系统'").filter(a=>!tracked.has(a.id));
  const activities=[...events.map(e=>({...e,user_id:e.credited_user_id})),...legacy].filter(a=>activeOpportunityIds.has(a.opportunity_id));
  const quotes=all(db,'SELECT * FROM quotes').filter(q=>activeOpportunityIds.has(q.opportunity_id));
  const p=performancePolicy(rules.performance);
  const process=processScore(opps,activities,quotes,user.id,month,p);
  const raw=Math.min(p.cap,review?.adjustment??process.raw);
  const processPoints=Math.round(raw/p.cap*p.process_weight*100)/100;
  const q=`${month.slice(0,4)}Q${Math.ceil(Number(month.slice(5,7))/3)}`;
  const quarterly=one(db,'SELECT amount FROM targets WHERE user_id=? AND quarter=?',user.id,q)?.amount||0;
  const contracts=all(db,"SELECT id,name,amount,sign_date FROM contracts WHERE retired_at IS NULL AND lifecycle!='草稿' AND owner_id=? AND substr(sign_date,1,7)=? AND sign_date<=?",user.id,month,today());
  const actual=contracts.reduce((s,c)=>s+c.amount,0);
  const achievement=quarterly?actual*3/quarterly:null;
  const resultPoints=achievement===null?null:achievement*p.result_weight;
  const automaticTotal=resultPoints===null?null:Math.round((processPoints+resultPoints)*100)/100;
  const total=quarterly?(review?.final_score??automaticTotal):null;
  const grade=total===null?null:p.grades.find(g=>total>=g.min);
  const eligible=user.role==='sales' && user.performance_enabled!==0 && user.business_member!==0 && user.developer_admin!==1;
  const priorDate=new Date(`${month}-15T12:00:00Z`);priorDate.setUTCMonth(priorDate.getUTCMonth()-1);
  const prev=one(db,"SELECT snapshot FROM performance_reviews WHERE user_id=? AND month=? AND status='confirmed'",user.id,priorDate.toISOString().slice(0,7));
  return {user_id:user.id,name:user.name,month,process,raw,processPoints,resultPoints:eligible?resultPoints:null,automatic_total:eligible?automaticTotal:null,final_score:review?.final_score??null,total:eligible?total:null,grade:eligible?grade?.grade||null:null,salary_factor:eligible?grade?.factor??null:null,eligible,quarterly_target:quarterly,monthly_target:Math.round(quarterly/3),actual,achievement,adjustment:review?.adjustment??null,adjustment_limited:review?.adjustment>p.cap,calculation_rules:Object.fromEntries(Object.keys(performanceDefaults).map(k=>[k,p[k]])),reason:review?.reason||'',status:'draft',consecutive_d:!!(eligible&&grade?.grade==='D'&&prev&&JSON.parse(prev.snapshot).grade==='D'),evidence:{contracts,meetings:activities.filter(a=>a.user_id===user.id&&a.activity_type==='线上会议'&&a.activity_date.startsWith(month)),visits:activities.filter(a=>a.user_id===user.id&&a.activity_type==='现场拜访'&&a.activity_date.startsWith(month)),opportunities:opps.filter(o=>o.owner_id===user.id&&o.created_at.slice(0,7)===month),quotes:[...quotes.filter(q=>q.user_id===user.id&&q.created_at.startsWith(month)),...activities.filter(a=>a.user_id===user.id&&a.activity_type==='对客报价'&&a.activity_date.startsWith(month)&&!quotes.some(q=>q.user_id===user.id&&q.opportunity_id===a.opportunity_id&&q.created_at.slice(0,10)===a.activity_date))]}};
}

function correctionAccess(db,contractId,context){
  if(context?.b?.data_correction!==true||!canManageContractData(context.actor))return false;
  const contract=one(db,'SELECT owner_id FROM contracts WHERE id=?',contractId);assert(contract,'合同不存在',404);
  assertContractDataAccess(context.actor,contract);text(context.b.reason,'资料修正原因',1000);return true;
}
export function assertUnsettled(db,contractId,context) {
  if(correctionAccess(db,contractId,context))return;
  assert(!one(db,'SELECT id FROM commission_lines WHERE contract_id=? LIMIT 1',contractId),'该合同已确认提成，金额、毛利及归属已锁定',409);
}
export function contractLocks(db,contractId) {
  const commissions=all(db,'SELECT DISTINCT b.id,b.period,b.status FROM commission_lines l JOIN commission_batches b ON b.id=l.batch_id WHERE l.contract_id=?',contractId);
  const performance=all(db,"SELECT DISTINCT r.month FROM performance_reviews r,json_each(r.snapshot,'$.evidence.contracts') c WHERE r.status='confirmed' AND json_extract(c.value,'$.id')=?",contractId);
  return {financial:!!one(db,'SELECT id FROM commission_lines WHERE contract_id=? LIMIT 1',contractId),ownership:commissions.length>0||performance.length>0,
    periods:commissions.map(c=>c.period),performance_months:performance.map(p=>p.month),
    message:commissions.length?'已确认提成：历史到账、金额、毛利和归属已锁定；仍可新增合法到账、维护计划及核销。':performance.length?'已确认绩效：合同归属及相关业绩字段受保护；仍可继续登记到账。':''};
}
export function assertOwnershipUnlocked(db,contractId,context) {
  if(correctionAccess(db,contractId,context))return;
  assertUnsettled(db,contractId);
  assert(!one(db,"SELECT r.id FROM performance_reviews r, json_each(r.snapshot,'$.evidence.contracts') c WHERE r.status='confirmed' AND json_extract(c.value,'$.id')=? LIMIT 1",contractId),'该合同已纳入确认绩效，归属已锁定',409);
}
export function handleIncentives(ctx) {
  const {path,method,b,actor,db,admin,insert,update,audit,getRules}=ctx;
  if(method!=='GET'&&(path==='/api/commissions/confirm'||path==='/api/commissions/disbursements'||/^\/api\/commissions\/\d+\/pay$/.test(path))) {
    admin(actor);
    assert(false,'提成已改为实时查看，不再确认结算或登记发放',410);
  }
  if(path==='/api/performance/review'&&method==='POST') {
    admin(actor);const user=one(db,"SELECT * FROM users WHERE id=? AND role='sales' AND active=1 AND performance_enabled=1 AND business_member=1 AND developer_admin=0",Number(b.user_id));assert(user,'请选择在用且参与绩效的一线销售');
    const month=b.month||period();const value=performanceFor(db,getRules(),user,month);
    assert(value.status!=='confirmed','该月绩效已确认锁定',409);
    const status=choice(b.status||'draft',['draft','confirmed'],'评定状态');
    const adjustment=b.adjustment===undefined||b.adjustment===null||b.adjustment===''?null:Number(b.adjustment);
    assert(adjustment===null||Number.isFinite(adjustment)&&adjustment>=0&&adjustment<=getRules().performance.cap,'过程调整分须在0至满分之间');
    const final_score=b.final_score===undefined||b.final_score===null||b.final_score===''?null:Number(b.final_score);
    assert(final_score===null||Number.isFinite(final_score)&&final_score>=0&&final_score<=100,'最终总分须为0至100');
    const reason=text(b.reason||'','调整原因',1000,adjustment!==null||final_score!==null);
    const existing=one(db,'SELECT id FROM performance_reviews WHERE user_id=? AND month=?',user.id,month);
    const row={user_id:user.id,month,adjustment,final_score,reason,status:'draft',reviewed_by:actor.id,updated_at:now()};
    const id=existing?.id||insert('performance_reviews',row);if(existing) update('performance_reviews',id,row);
    const calculated=performanceFor(db,getRules(),user,month);
    if(status==='confirmed') {assert(month<period(),'月份结束后才可确认绩效');assert(calculated.total!==null,'请先配置该季度合同额目标');update('performance_reviews',id,{status,snapshot:JSON.stringify(calculated)});}
    audit(actor,status==='confirmed'?'确认月度绩效':'调整过程绩效','performance',id,{user_id:user.id,month,adjustment,final_score,reason});
    return {id,message:status==='confirmed'?'月度绩效已确认锁定':'过程评分已调整'};
  }
}
