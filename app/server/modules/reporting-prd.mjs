import {expenseDetailCounts} from './contract-expenses.mjs';
import { all, one } from '../database.mjs';
import { code, risk, period, quarter, today, now, STAGES } from '../domain.mjs';
import { publicUser } from './auth.mjs';
import { commissionPreview, performanceFor, managerId,contractLocks } from './incentives.mjs';
import {ledgerPayments} from '../collection-ledger.mjs';
import { integrationSettings } from './setup.mjs';
import {batchHistory} from './intake-receipts.mjs';
import {businessTableCatalog} from './intake-fields.mjs';
import {deriveQuoteTotals} from '../quote-values.mjs';
import {contractFinancials,effectiveContractFinancials} from '../contract-financials.mjs';
import {qfcrmSourceFields,contractSourceFields,importedCollections} from '../qfcrm-source-fields.mjs';
import {performanceInputs} from '../performance-inputs.mjs';
import {processLedger} from '../performance-ledger.mjs';
import {canCorrectActivityEvent,activityLegacyVersion} from './activity-corrections.mjs';
import {minutesActivityStatus,minutesSummarySources} from './minutes/followup.mjs';
import {signedOpportunitySummary,opportunityForecast,currentQuoteIds,quoteVersion,opportunityDiagnostics,addSignedDiagnostics} from './opportunity-summary.mjs';
const sum=(a,fn)=>a.reduce((s,x)=>s+fn(x),0);
const elapsed=(d)=>d?Math.max(0,Math.floor((new Date(today())-new Date(d.slice(0,10)))/86400000)):0;
export {contractFinancials} from '../contract-financials.mjs';
export function contractDashboard(contracts,month,asOf=today()) {
  const included=contracts.filter(c=>!c.retired_at&&c.lifecycle!=='草稿');
  return {month,
    signed_amount:sum(included.filter(c=>c.sign_date?.startsWith(month+'-')),c=>c.amount),
    received_amount:sum(included.flatMap(c=>c.payments).filter(p=>p.status==='已到账'&&p.pay_date?.startsWith(month+'-')),p=>p.amount),
    outstanding_amount:sum(included,c=>c.outstanding),
    expiring_amount:sum(included.filter(c=>c.valid_until?.startsWith(month+'-')),c=>c.amount),
    overdue_amount:sum(included.filter(c=>c.outstanding>0),c=>Math.min(c.outstanding,sum(c.payments.filter(p=>['待到账','逾期'].includes(p.status)&&p.promise_date&&p.promise_date<asOf),p=>p.remaining_amount??p.amount))),
    outstanding_basis:'全部非草稿合同金额减累计实际到账，不限制签约月份',
  };
}
function importHistory(db,actor,records) {
  const visible=Object.fromEntries(Object.entries(records).map(([entity,rows])=>[entity,new Map(rows.map(row=>[row.id,row]))]));
  const latest=new Map();
  const add=(type,at)=>{
    const time=Date.parse(at);
    if(!Number.isFinite(time))return;
    if(!latest.has(type)||time>Date.parse(latest.get(type)))latest.set(type,at);
  };
  for(const source of all(db,"SELECT entity,entity_id,imported_at,CASE WHEN json_type(payload,'$.related')='array' THEN json_extract(payload,'$.related') ELSE '[]' END related FROM source_records WHERE status='imported' AND entity_id IS NOT NULL")){
    if(!visible[source.entity]?.has(source.entity_id))continue;
    const parsed=source.related?JSON.parse(source.related):[];
    const related=Array.isArray(parsed)?parsed:[];
    // Payment-plan source rows point at their parent contract; only their
    // explicitly created payment IDs establish a payment import timestamp.
    const paymentSource=source.entity==='contract'&&related.some(row=>row?.entity==='payment');
    if(!paymentSource)add(source.entity==='attachment'?'contract_attachment':source.entity,source.imported_at);
    const parentFields={contact:['customer','customer_id'],contract_item:['contract','contract_id'],payment:['contract','contract_id']};
    for(const item of related){
      const parent=parentFields[item?.entity],record=visible[item?.entity]?.get(item?.id);
      if(parent&&record&&source.entity===parent[0]&&record[parent[1]]===source.entity_id)add(item.entity,source.imported_at);
    }
  }
  const aliases={contract_attachment:'attachment',contract_archive:'contract',payment_receive:'payment',payment_checkpoint:'payment',commission_confirm:'commission',commission_pay:'commission'};
  const administrative=new Set(['member','document_template','document_template_approve','rules']);
  for(const row of all(db,`SELECT operation_type,record_id,imported_at FROM ai_import_records ${actor.role==='admin'?'':'WHERE user_id=? AND source_role!=\'admin\''}`,...(actor.role==='admin'?[]:[actor.id]))){
    if(administrative.has(row.operation_type)?actor.role==='admin':visible[aliases[row.operation_type]||row.operation_type]?.has(row.record_id))add(row.operation_type,row.imported_at);
  }
  return [...latest].map(([type,imported_at])=>({type,imported_at}));
}
export function buildState(context,actor) {
  const {db,getRules,demo,ding={},ai={}}=context,rules=getRules(),isAdmin=actor.role==='admin',isPm=actor.role==='pm';
  const month=context.month||period(),scoringInputs=performanceInputs(db);
  const importedSources=qfcrmSourceFields(db);
  const maintainedFields=new Map();
  for(const row of all(db,"SELECT entity_id,detail FROM audit WHERE entity='contract' AND action='更新合同' AND json_valid(detail)")){
    const detail=JSON.parse(row.detail),fields=maintainedFields.get(row.entity_id)||new Set();
    for(const key of ['owner_id','collaborator_pm','project_status','project_note','delivery_staff','created_at'])if(Object.hasOwn(detail,key))fields.add(key);
    maintainedFields.set(row.entity_id,fields);
  }
  const users=all(db,'SELECT * FROM users WHERE business_member=1 AND developer_admin=0').map(u=>({...publicUser(u),...(isAdmin?{ding_union_id:one(db,'SELECT union_id FROM ding_identities WHERE user_id=?',u.id)?.union_id||''}:{})}));
  const collaborators=all(db,'SELECT * FROM customer_collaborators');
  const sourceRefs=new Map();
  for(const source of all(db,'SELECT id,entity,entity_id,source_file,sheet_name,row_number,imported_at,status,reason FROM source_records WHERE entity_id IS NOT NULL ORDER BY id DESC')){
    const key=source.entity+':'+source.entity_id;
    if(!sourceRefs.has(key))sourceRefs.set(key,[]);
    sourceRefs.get(key).push(source);
  }
  const sources=(entity,id)=>sourceRefs.get(entity+':'+id)||[];
  const linkedCustomers=new Set(collaborators.filter(c=>c.user_id===actor.id).map(c=>c.customer_id));
  const rawOpps=all(db,'SELECT * FROM opportunities WHERE archived_at IS NULL ORDER BY updated_at DESC');
  const visibleOpps=rawOpps.filter(o=>isAdmin || (isPm ? o.collaborator_pm===actor.id||linkedCustomers.has(o.customer_id) : o.owner_id===actor.id));
  const oppIds=new Set(visibleOpps.map(o=>o.id));
  const summarySources=minutesSummarySources(db);
  const storedActivities=all(db,'SELECT * FROM activities ORDER BY activity_date DESC,id DESC').map(a=>a.minutes_record_id?{...a,...minutesActivityStatus(a,summarySources.get(a.minutes_record_id))}:a);
  const events=all(db,'SELECT * FROM activity_events ORDER BY activity_date DESC,id DESC');
  const activeParents=new Set(events.filter(e=>!e.voided_at).map(e=>e.activity_id));
  const allActivities=storedActivities.filter(a=>!a.event_managed||activeParents.has(a.id));
  // A failed summary read does not undo a recording that already happened.
  // Only withdrawn projections cease to establish a business contact date.
  const effectiveActivities=allActivities.filter(a=>a.source_withdrawn!==true);
  const contactsRaw=all(db,'SELECT * FROM contacts');
  const rawQuotes=all(db,'SELECT * FROM quotes ORDER BY id DESC');
  const currentQuotes=currentQuoteIds(rawQuotes),quotesById=new Map(rawQuotes.map(q=>[q.id,q]));
  const opportunities=visibleOpps.map(o=>{
    const activity=effectiveActivities.find(a=>a.opportunity_id===o.id&&a.activity_type!=='系统');
    const status=risk(o,rules);
    const inactive=elapsed(activity?.activity_date||o.created_at);
    const contacts=contactsRaw.filter(p=>p.customer_id===o.customer_id&&!p.archived_at);
    const currentQuote=quotesById.get(currentQuotes.get(o.id));
    const keyStale=contacts.some(p=>['决策人','影响者'].includes(p.role)&&p.last_contact&&elapsed(p.last_contact)>=rules.contact_days);
    const management=opportunityDiagnostics(o,status,{asOf:today(),rules,inactive,currentQuote,keyContactStale:keyStale});
    const result={...o,...opportunityForecast({...o,...(isPm?{initial_amount:undefined}:{})}),...management,current_quote_id:isPm?null:currentQuote?.id||null,code:o.reference||(importedSources.opportunities.get(o.id)?.source_reference_missing?'编号待补充':code('SJ',o.id,o.created_at)),last_interaction:activity?.activity_date||null,inactive_days:inactive,aiAnalysis:{kind:'rules',nextActions:[rules.sop[o.stage],o.next_action].filter(Boolean),risks:[...management.risk_reasons],pricingTrigger:o.stage==='方案'&&!!activity,keyPersonInsights:contacts.some(p=>p.role==='决策人')?'已登记决策人，请核对近期触达情况':'尚未登记决策人，建议补齐决策链'}};
    if(isPm) {delete result.initial_amount;}
    return {...result,...(!o.owner_id&&importedSources.opportunities.has(o.id)?{owner_label:importedSources.opportunities.get(o.id).sales_names.join('、')}:{}),sources:sources('opportunity',o.id),can_read_sources:true};
  });
  const pmCustomers=new Set(visibleOpps.map(o=>o.customer_id));
  const cooperatingCustomers=new Set(all(db,"SELECT DISTINCT customer_id FROM contracts WHERE retired_at IS NULL AND terminated_at IS NULL AND lifecycle!='草稿'").map(c=>c.customer_id));
  const customers=all(db,'SELECT * FROM customers ORDER BY id DESC').filter(c=>!isPm||pmCustomers.has(c.id)||linkedCustomers.has(c.id)).map(c=>{
    const full=isAdmin||isPm||c.owner_id===actor.id;
    const base=full?c:{id:c.id,name:c.name,short_name:c.short_name,industry:c.industry,region:c.region,manual_level:c.manual_level,owner_id:c.owner_id,status:c.status,parent_company:c.parent_company,group_name:c.group_name,shared:true};
    return {...base,management_status:['冻结','流失'].includes(c.status)?c.status:'正常',relationship_status:cooperatingCustomers.has(c.id)?'已合作':'未合作',sources:full?sources('customer',c.id):[],can_read_sources:isAdmin||actor.role==='sales'&&c.owner_id===actor.id,collaborators:full?collaborators.filter(x=>x.customer_id===c.id).map(x=>x.user_id):[],last_interaction:effectiveActivities.find(a=>!['系统','系统里程碑'].includes(a.activity_type)&&oppIds.has(a.opportunity_id)&&rawOpps.some(o=>o.id===a.opportunity_id&&o.customer_id===c.id))?.activity_date||null};
  });
  const customerIds=new Set(customers.filter(c=>!c.shared).map(c=>c.id));
  const ownMinutes=new Set(isAdmin||isPm?[]:all(db,'SELECT r.id FROM minutes_records r JOIN minutes_sources s ON s.id=r.source_id WHERE s.member_id=?',actor.id).map(r=>r.id));
  const activityParents=new Map(storedActivities.map(a=>[a.id,a]));
  const mayReadMinutes=a=>!a?.minutes_record_id||isAdmin||!isPm&&ownMinutes.has(a.minutes_record_id);
  const visibleEvents=events.filter(e=>{
    const parent=activityParents.get(e.activity_id);
    return mayReadMinutes(parent)&&(isAdmin||oppIds.has(e.opportunity_id)||!isPm&&(e.user_id===actor.id||e.credited_user_id===actor.id));
  });
  const activeEventParents=new Set(events.filter(e=>!e.voided_at).map(e=>e.activity_id));
  const activities=allActivities.filter(a=>oppIds.has(a.opportunity_id)&&mayReadMinutes(a)&&(!a.event_managed||activeEventParents.has(a.id))).map(a=>({...a,sources:[...new Set(visibleEvents.filter(e=>e.activity_id===a.id&&!e.voided_at).map(e=>e.source))].concat(events.some(e=>e.activity_id===a.id)?[]:[a.source])}));
  const historicGroups=new Map(),scoringOpps=new Map(scoringInputs.opportunities.map(o=>[o.id,o]));
  for(const event of visibleEvents)if(!oppIds.has(event.opportunity_id)&&!event.voided_at){
    if(!historicGroups.has(event.activity_id))historicGroups.set(event.activity_id,[]);
    historicGroups.get(event.activity_id).push(event);
  }
  // A former owner can read their own contributions, not the new owner's later notes.
  for(const [id,rows] of historicGroups){
    const parent=activityParents.get(id),o=scoringOpps.get(rows[0].opportunity_id);
    if(parent)activities.push({...parent,historical_only:true,opportunity_name:o?.name||'历史商机',customer_name:o?.customer_name||'',opportunity_archived:!!o?.archived_at,summary:rows.map(e=>e.summary).join('\n'),action:rows.map(e=>e.action||'').filter(Boolean).join('\n'),sources:[...new Set(rows.map(e=>e.source))]});
  }
  for(const a of allActivities)if(!oppIds.has(a.opportunity_id)&&!a.event_managed&&!events.some(e=>e.activity_id===a.id)&&mayReadMinutes(a)&&(isAdmin||!isPm&&a.user_id===actor.id)){
    const o=scoringOpps.get(a.opportunity_id);
    activities.push({...a,historical_only:true,opportunity_name:o?.name||'历史商机',customer_name:o?.customer_name||'',opportunity_archived:!!o?.archived_at,sources:[a.source]});
  }
  activities.sort((a,b)=>b.activity_date.localeCompare(a.activity_date)||b.id-a.id);
  const frozenActivity=(snapshot,event,legacy=false)=>{
    if(!snapshot)return undefined;
    if(Array.isArray(snapshot.score_ledger))return snapshot.score_ledger.find(row=>row.kind==='activity'&&(legacy?!row.event_id&&row.activity_id===event.id:row.event_id===event.id));
    for(const [key,type] of [['meetings','线上会议'],['visits','现场拜访'],['quotes','对客报价']]){
      const row=(snapshot.evidence?.[key]||[]).find(row=>row.activity_type===type&&row.opportunity_id===event.opportunity_id&&row.activity_date===event.activity_date&&(legacy?!row.activity_id&&row.id===event.id:!!row.activity_id&&(row.event_id??row.id)===event.id));
      if(row)return {...row,snapshot_category:key};
    }
  };
  const snapshotActivityScore=(snapshot,row,month)=>{
    if(!row)return {counted:false,points:0,reason:'该月绩效已锁定，本记录未纳入锁定评分',month,locked:true};
    if(Object.hasOwn(row,'counted'))return {counted:row.counted,points:row.points??null,reason:row.counted?'已纳入锁定绩效，后续纠错不改变原快照':row.reason||'锁定时未计分',month,locked:true};
    const key={meetings:'meeting',visits:'visit'}[row.snapshot_category];
    // Old quote evidence can include same-day duplicates; its presence alone
    // does not prove that this particular entry contributed a point.
    const known=!!key&&snapshot.process?.[key]===snapshot.evidence?.[row.snapshot_category]?.length;
    return {counted:known?true:null,points:known?snapshot.calculation_rules?.[key]??null:null,reason:known?'已纳入锁定绩效，后续纠错不改变原快照':'已纳入历史依据，单条分值未保存',month,locked:true};
  };
  const lockedReviews=all(db,"SELECT user_id,month,snapshot FROM performance_reviews WHERE status='confirmed'");
  const lockMap=new Map(lockedReviews.map(r=>[`${r.user_id}:${r.month}`,JSON.parse(r.snapshot)])),eventScores=new Map(),legacyScores=new Map(),scoredGroups=new Set();
  const scoreGroup=(userId,month)=>{
    const key=`${userId}:${month}`;
    if(scoredGroups.has(key))return;
    scoredGroups.add(key);
    const scored=processLedger(scoringInputs.opportunities,scoringInputs.activities,scoringInputs.quotes,userId,month,rules.performance);
    for(const row of scored.score_ledger)if(row.event_id)eventScores.set(row.event_id,row);else if(row.kind==='activity')legacyScores.set(row.activity_id,row);
  };
  for(const event of visibleEvents)scoreGroup(event.credited_user_id,event.activity_date.slice(0,7));
  const trackedActivityIds=new Set(events.map(e=>e.activity_id));
  for(const a of activities)if(!a.event_managed&&!trackedActivityIds.has(a.id)){
    const credited=a.user_id??scoringOpps.get(a.opportunity_id)?.owner_id,month=a.activity_date.slice(0,7);
    scoreGroup(credited,month);
    const score=legacyScores.get(a.id),snapshot=lockMap.get(`${credited}:${month}`),locked=!!snapshot;
    const frozen=frozenActivity(snapshot,a,true);
    a.credited_user_id=credited;
    a.legacy_version=activityLegacyVersion(a);
    const canCorrect=canCorrectActivityEvent(actor,{...a,credited_user_id:credited},a);
    a.can_edit=canCorrect;a.can_void=canCorrect;
    a.score=locked?snapshotActivityScore(snapshot,frozen,month):{counted:!!score?.counted,points:score?.points??0,reason:score?.reason||'该行为类型不计入过程分',month,locked:false};
  }
  const activityEvents=visibleEvents.map(e=>{
    const o=scoringOpps.get(e.opportunity_id),score=eventScores.get(e.id),month=e.activity_date.slice(0,7),snapshot=lockMap.get(`${e.credited_user_id}:${month}`),locked=!!snapshot;
    const frozen=frozenActivity(snapshot,e);
    const canCorrect=canCorrectActivityEvent(actor,e,activityParents.get(e.activity_id));
    return {...e,opportunity_name:o?.name||'历史商机',customer_name:o?.customer_name||'',opportunity_archived:!!o?.archived_at,can_edit:canCorrect&&!e.voided_at,can_void:canCorrect&&!e.voided_at,score:locked?snapshotActivityScore(snapshot,frozen,month):{counted:!!score?.counted,points:score?.points??0,reason:score?.reason||'该行为类型不计入过程分',month,locked:false}};
  });
  const lockUsers=new Set([actor.id,...visibleOpps.map(o=>o.owner_id),...visibleEvents.map(e=>e.credited_user_id)]);
  const performanceLocks=lockedReviews.filter(r=>isAdmin||lockUsers.has(r.user_id)).map(({user_id,month})=>({user_id,month}));

  const quotes=isPm?[]:rawQuotes.filter(q=>oppIds.has(q.opportunity_id)).map(q=>({
    ...q,...quoteVersion(q,currentQuotes.get(q.opportunity_id),today()),...deriveQuoteTotals(q.items),
    items:JSON.parse(q.items||'[]'),code:code('BJ',q.id,q.created_at),
    attachments:all(db,"SELECT id,filename,mime_type,size,created_at,created_by FROM attachments WHERE entity='quote' AND entity_id=? ORDER BY id",q.id),
  }));
  const contracts=all(db,'SELECT c.*,customer.name AS customer_name FROM contracts c JOIN customers customer ON customer.id=c.customer_id WHERE c.retired_at IS NULL ORDER BY c.id DESC').filter(c=>isAdmin||(isPm?c.collaborator_pm===actor.id||linkedCustomers.has(c.customer_id):c.owner_id===actor.id)).map(c=>{
    const payments=ledgerPayments(db,c.id);
    const collected=sum(payments.filter(p=>p.status==='已到账'),p=>p.amount);
    const rawItems=all(db,'SELECT * FROM contract_items WHERE retired_at IS NULL AND contract_id=?',c.id);
    const expenseCounts=expenseDetailCounts(db,c.id);
    const items=rawItems.map(i=>{if(!isPm)return {...i,expense_detail_count:expenseCounts.get(i.id)||0};const {rate,margin,margin_before_expense,business_expense,...safe}=i;return safe;});
    const financials=effectiveContractFinancials(c,rawItems,payments,importedSources.contracts.get(c.id),{hideMargin:isPm});
    const days=c.valid_until?Math.floor((new Date(c.valid_until)-new Date(today()))/86400000):null;
    const marginUnknown=financials.total_margin===null;
    const attachments=all(db,"SELECT id,filename,mime_type,size,sha256,source_path,created_at,created_by FROM attachments WHERE entity='contract' AND entity_id=? ORDER BY id",c.id);
    const receivedDates=payments.filter(p=>p.status==='已到账'&&p.pay_date).map(p=>p.pay_date).sort();
    const plans=payments.filter(p=>p.record_type==='plan'),planned=plans.reduce((s,p)=>s+p.remaining_amount,0);
    const expectedDates=plans.filter(p=>p.remaining_amount>0&&p.promise_date).map(p=>p.promise_date).sort();
    const history=all(db,'SELECT a.id,a.action,a.detail,a.created_at,u.name user_name FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE a.entity=\'contract\' AND a.entity_id=? ORDER BY a.id DESC LIMIT 30',c.id).map(({detail,...row})=>({...row,...(!isPm?{detail:JSON.parse(detail||'{}')}:{})}));
    return {...c,...financials,sources:sources('contract',c.id),attachments,can_read_sources:!isPm,can_download_attachments:!isPm,code:c.contract_no||code('HT',c.id,c.created_at),items,payments,plans,collected,collection_status:collected===0?'未回款':collected<c.amount?'部分回款':'已结清',received_status:collected===0?'否':collected<c.amount?'部分回款':'是',outstanding:c.amount-collected,last_received_at:receivedDates.at(-1)||null,next_expected_at:expectedDates[0]||null,renewal_days:days,renewal_due:days!==null&&days<=30,margin_unknown:marginUnknown,margin:financials.total_margin,...contractSourceFields(c,rawItems,payments,importedSources.contracts.get(c.id),{hideMargin:isPm}),
      retired_items:!isPm?all(db,'SELECT * FROM contract_items WHERE contract_id=? AND retired_at IS NOT NULL',c.id):[],locks:contractLocks(db,c.id),history,termination_request:one(db,'SELECT r.*,u.name requested_by_name FROM contract_exit_requests r LEFT JOIN users u ON u.id=r.requested_by WHERE r.contract_id=? ORDER BY r.id DESC LIMIT 1',c.id)||null,
      planned_remaining:planned,unplanned_amount:Math.max(0,c.amount-collected-planned),needs_plan_review:planned>c.amount-collected,
    };
  });
  for(const opportunity of opportunities){
    opportunity.signed_summary=signedOpportunitySummary(opportunity.id,contracts);
    addSignedDiagnostics(opportunity);
  }
  const performance=isPm?[]:all(db,"SELECT * FROM users WHERE role='sales' AND business_member=1 AND developer_admin=0").filter(u=>isAdmin||u.id===actor.id).map(u=>performanceFor(db,rules,u,month,{inputs:scoringInputs})).filter(p=>!p.inactive||month<period()&&(p.review_id||p.score_ledger?.length||p.actual>0));
  const team=users.filter(u=>u.active&&(u.role==='sales'||u.id===managerId(db,rules))&&(isAdmin||u.id===actor.id)).map(u=>{
    const o=opportunities.filter(o=>o.owner_id===u.id),c=contracts.filter(c=>c.owner_id===u.id&&c.lifecycle!=='草稿');
    const review=performance.find(p=>p.user_id===u.id);
    return {...u,process:review?.process||{raw:0,weighted:0,meeting:0,visit:0,quote:0,funnelCount:0},performance:review||null,pipeline:sum(o.filter(o=>!['赢单','输单','搁置'].includes(o.stage)),o=>o.amount),activeCount:o.filter(o=>!['赢单','输单','搁置'].includes(o.stage)).length,riskCount:o.filter(o=>o.risk.level!=='normal').length,followCount:activities.filter(a=>a.source_withdrawn!==true&&o.some(o=>o.id===a.opportunity_id)&&elapsed(a.activity_date)<=7&&a.activity_type!=='系统').length,signed:sum(c.filter(c=>c.sign_date.startsWith(month)),c=>c.amount),collected:sum(c.flatMap(c=>c.payments).filter(p=>p.status==='已到账'&&p.pay_date?.startsWith(month)),p=>p.amount),target:one(db,'SELECT amount FROM targets WHERE user_id=? AND quarter=?',u.id,quarter())?.amount||0,sourceCoverage:[...new Set(events.filter(e=>o.some(o=>o.id===e.opportunity_id)&&elapsed(e.activity_date)<=7).map(e=>e.source))]};
  });
  const commission=isPm?{previews:[],batches:[]}:commissionPreview(db,rules,actor,context.commissionPeriod);
  const imported=importHistory(db,actor,{customer:customers.filter(c=>!c.shared),contact:contactsRaw.filter(c=>customerIds.has(c.customer_id)),opportunity:opportunities,activity:activities,quote:quotes,contract:contracts,contract_item:contracts.flatMap(c=>c.items),payment:contracts.flatMap(c=>c.payments),attachment:contracts.flatMap(c=>c.attachments),commission:commission.batches});
  const confirmedMonths=isAdmin?all(db,"SELECT user_id,month FROM performance_reviews WHERE status='confirmed'"):[];
  const targets=isAdmin?all(db,"SELECT t.* FROM targets t JOIN users u ON u.id=t.user_id WHERE u.role='sales' AND u.active=1 AND u.business_member=1 AND u.developer_admin=0 ORDER BY t.quarter DESC,t.user_id").map(t=>{
    const locked_months=confirmedMonths.filter(r=>r.user_id===t.user_id&&`${r.month.slice(0,4)}Q${Math.ceil(Number(r.month.slice(5,7))/3)}`===t.quarter).map(r=>r.month);
    return {...t,locked:locked_months.length>0,locked_months};
  }):[];
  return {actor:publicUser(actor),demo,today:today(),period:month,quarter:quarter(),rules:isAdmin?rules:{thresholds:rules.thresholds,sop:rules.sop,commission_visible:true,result_visible:true,performance:rules.performance},stages:STAGES,users:isAdmin?users:users.map(u=>({id:u.id,name:u.name,role:u.role,active:u.active})),customers,opportunities,activities,activityEvents,performanceLocks,performance_updated_at:now(),quotes,contracts,contacts:contactsRaw.filter(c=>customerIds.has(c.customer_id)),team,performance,commission,
    targets,contractDashboard:contractDashboard(contracts,month),collections:importedCollections(contracts,importedSources.collections,{hideMargin:isPm,maintainedFields}),
    stageHistory:all(db,'SELECT * FROM stage_history ORDER BY id').filter(h=>oppIds.has(h.opportunity_id)),
    refresh:{enabled:false,schedule:null,missedRunPolicy:null,lastRun:one(db,'SELECT created_at FROM daily_reports ORDER BY day DESC LIMIT 1')?.created_at||null},
    audit:isAdmin?all(db,"SELECT a.*,u.name user_name,op.name operator_name,target.name acting_as_name FROM audit a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN users op ON op.id=CASE WHEN json_valid(a.detail) THEN json_extract(a.detail,'$.operator_user_id') END LEFT JOIN users target ON target.id=CASE WHEN json_valid(a.detail) THEN json_extract(a.detail,'$.acting_as_user_id') END ORDER BY a.id DESC LIMIT 200"):[],
    ...(isAdmin?{integrationSettings:integrationSettings(db)}:{}),
    ai:{configured:!!ai.configured,model:ai.model||'deepseek-v4-1-flash',batches:batchHistory(db,actor),importHistory:imported,businessTables:businessTableCatalog(db,actor.role)},
    integrations:[{id:'dingtalk',name:'钉钉身份登录',status:ding.loginConfigured?'服务端已配置':'待配置企业应用',description:'企业身份校验后映射到本地角色；成员本人扫码需实际验收。'},{id:'minutes',name:'钉钉听记',status:context.minutes?.enabled?'接口连接可用':'待配置连接器',description:'成员本人授权后从连接时起采集新听记；总结、逐字稿及录音分别记录实际读取状态。'},{id:'templates',name:'报价与合同文件',status:integrationSettings(db).documents.confirmed?'公司模板已确认':'内部核对稿可导出',description:'公司报价与合同模板统一通过AI接收维护；未确认时文件明确标注内部核对稿。'},{id:'llm',name:'AI资料接收',status:ai.configured?'紫猫云 DeepSeek已配置':'待配置AI凭据',description:'统一接收资料，校验并经确认后入库；商机 AI 分析仅在手动点击后结合当前客户资料、售卖产品及跟进记录生成，原阶段规则建议继续保留；合同附件提取仅形成核对提案。'}]};
}
