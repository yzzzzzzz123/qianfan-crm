import {expenseDetailCounts} from './contract-expenses.mjs';
import { all, one } from '../database.mjs';
import { code, risk, period, quarter, today, STAGES } from '../domain.mjs';
import { publicUser } from './auth.mjs';
import { commissionPreview, performanceFor, managerId,contractLocks } from './incentives.mjs';
import {ledgerPayments} from '../collection-ledger.mjs';
import { integrationSettings } from './setup.mjs';
import {batchHistory} from './intake-receipts.mjs';
import {businessTableCatalog} from './intake-fields.mjs';
import {deriveQuoteTotals} from '../quote-values.mjs';
import {contractFinancials,effectiveContractFinancials} from '../contract-financials.mjs';
import {qfcrmSourceFields,contractSourceFields,importedCollections} from '../qfcrm-source-fields.mjs';
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
  const month=context.month||period();
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
  const allActivities=all(db,'SELECT * FROM activities ORDER BY activity_date DESC,id DESC');
  const events=all(db,'SELECT * FROM activity_events ORDER BY activity_date DESC,id DESC');
  const contactsRaw=all(db,'SELECT * FROM contacts');
  const rawQuotes=all(db,'SELECT * FROM quotes ORDER BY id DESC');
  const opportunities=visibleOpps.map(o=>{
    const activity=allActivities.find(a=>a.opportunity_id===o.id&&a.activity_type!=='系统');
    const status=risk(o,rules);
    const inactive=elapsed(activity?.activity_date||o.created_at);
    const contacts=contactsRaw.filter(p=>p.customer_id===o.customer_id&&!p.archived_at);
    const expired=rawQuotes.some(q=>q.opportunity_id===o.id&&q.valid_until<today());
    if(!['赢单','输单','搁置'].includes(o.stage)) {
      if(inactive>=rules.inactivity_days) Object.assign(status,{level:'critical',label:'长期未互动'});
      else if(status.level==='normal'&&status.days>=status.threshold*rules.attention_ratio)Object.assign(status,{level:'attention',label:'接近停滞阈值'});
      if(expired&&status.level==='normal')Object.assign(status,{level:'attention',label:'报价已过期'});
    }
    const keyStale=contacts.some(p=>['决策人','影响者'].includes(p.role)&&p.last_contact&&elapsed(p.last_contact)>=rules.contact_days);
    if(!['赢单','输单','搁置'].includes(o.stage)&&keyStale&&status.level==='normal')Object.assign(status,{level:'attention',label:'关键人待触达'});
    const result={...o,code:o.reference||(importedSources.opportunities.get(o.id)?.source_reference_missing?'编号待补充':code('SJ',o.id,o.created_at)),risk:status,last_interaction:activity?.activity_date||null,inactive_days:inactive,aiAnalysis:{kind:'rules',nextActions:[rules.sop[o.stage],o.next_action].filter(Boolean),risks:[status.level!=='normal'?status.label:null,expired?'存在过期报价':null,keyStale?'关键联系人长期未触达':null].filter(Boolean),pricingTrigger:o.stage==='方案'&&!!activity,keyPersonInsights:contacts.some(p=>p.role==='决策人')?'已登记决策人，请核对近期触达情况':'尚未登记决策人，建议补齐决策链'}};
    if(isPm) {delete result.initial_amount;}
    return {...result,...(!o.owner_id&&importedSources.opportunities.has(o.id)?{owner_label:importedSources.opportunities.get(o.id).sales_names.join('、')}:{}),sources:sources('opportunity',o.id),can_read_sources:true};
  });
  const pmCustomers=new Set(visibleOpps.map(o=>o.customer_id));
  const customers=all(db,'SELECT * FROM customers ORDER BY id DESC').filter(c=>!isPm||pmCustomers.has(c.id)||linkedCustomers.has(c.id)).map(c=>{
    const full=isAdmin||isPm||c.owner_id===actor.id;
    const base=full?c:{id:c.id,name:c.name,short_name:c.short_name,industry:c.industry,region:c.region,manual_level:c.manual_level,owner_id:c.owner_id,status:c.status,parent_company:c.parent_company,group_name:c.group_name,shared:true};
    return {...base,sources:full?sources('customer',c.id):[],can_read_sources:isAdmin||actor.role==='sales'&&c.owner_id===actor.id,collaborators:full?collaborators.filter(x=>x.customer_id===c.id).map(x=>x.user_id):[],last_interaction:allActivities.find(a=>oppIds.has(a.opportunity_id)&&rawOpps.some(o=>o.id===a.opportunity_id&&o.customer_id===c.id))?.activity_date||null};
  });
  const customerIds=new Set(customers.filter(c=>!c.shared).map(c=>c.id));
  const ownMinutes=new Set(isAdmin||isPm?[]:all(db,'SELECT r.id FROM minutes_records r JOIN minutes_sources s ON s.id=r.source_id WHERE s.member_id=?',actor.id).map(r=>r.id));
  const activities=allActivities.filter(a=>oppIds.has(a.opportunity_id)&&(!a.minutes_record_id||isAdmin||!isPm&&ownMinutes.has(a.minutes_record_id))).map(a=>({...a,sources:[...new Set(events.filter(e=>e.activity_id===a.id).map(e=>e.source))].concat(events.some(e=>e.activity_id===a.id)?[]:[a.source])}));
  const quotes=isPm?[]:rawQuotes.filter(q=>oppIds.has(q.opportunity_id)).map(q=>({...q,...deriveQuoteTotals(q.items),items:JSON.parse(q.items||'[]'),code:code('BJ',q.id,q.created_at)}));
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
  const performance=isPm?[]:all(db,"SELECT * FROM users WHERE role='sales' AND active=1 AND business_member=1 AND developer_admin=0").filter(u=>isAdmin||u.id===actor.id).map(u=>performanceFor(db,rules,u,month));
  const team=users.filter(u=>u.active&&(u.role==='sales'||u.id===managerId(db,rules))&&(isAdmin||u.id===actor.id)).map(u=>{
    const o=opportunities.filter(o=>o.owner_id===u.id),c=contracts.filter(c=>c.owner_id===u.id&&c.lifecycle!=='草稿');
    const review=performance.find(p=>p.user_id===u.id);
    return {...u,process:review?.process||{raw:0,weighted:0,meeting:0,visit:0,quote:0,funnelCount:0},performance:review||null,pipeline:sum(o.filter(o=>!['赢单','输单','搁置'].includes(o.stage)),o=>o.amount),activeCount:o.filter(o=>!['赢单','输单','搁置'].includes(o.stage)).length,riskCount:o.filter(o=>o.risk.level!=='normal').length,followCount:activities.filter(a=>o.some(o=>o.id===a.opportunity_id)&&elapsed(a.activity_date)<=7&&a.activity_type!=='系统').length,signed:sum(c.filter(c=>c.sign_date.startsWith(month)),c=>c.amount),collected:sum(c.flatMap(c=>c.payments).filter(p=>p.status==='已到账'&&p.pay_date?.startsWith(month)),p=>p.amount),target:one(db,'SELECT amount FROM targets WHERE user_id=? AND quarter=?',u.id,quarter())?.amount||0,sourceCoverage:[...new Set(events.filter(e=>o.some(o=>o.id===e.opportunity_id)&&elapsed(e.activity_date)<=7).map(e=>e.source))]};
  });
  const commission=isPm?{previews:[],batches:[]}:commissionPreview(db,rules,actor,context.commissionPeriod);
  const imported=importHistory(db,actor,{customer:customers.filter(c=>!c.shared),contact:contactsRaw.filter(c=>customerIds.has(c.customer_id)),opportunity:opportunities,activity:activities,quote:quotes,contract:contracts,contract_item:contracts.flatMap(c=>c.items),payment:contracts.flatMap(c=>c.payments),attachment:contracts.flatMap(c=>c.attachments),commission:commission.batches});
  const confirmedMonths=isAdmin?all(db,"SELECT user_id,month FROM performance_reviews WHERE status='confirmed'"):[];
  const targets=isAdmin?all(db,"SELECT t.* FROM targets t JOIN users u ON u.id=t.user_id WHERE u.role='sales' AND u.active=1 AND u.business_member=1 AND u.developer_admin=0 ORDER BY t.quarter DESC,t.user_id").map(t=>{
    const locked_months=confirmedMonths.filter(r=>r.user_id===t.user_id&&`${r.month.slice(0,4)}Q${Math.ceil(Number(r.month.slice(5,7))/3)}`===t.quarter).map(r=>r.month);
    return {...t,locked:locked_months.length>0,locked_months};
  }):[];
  return {actor:publicUser(actor),demo,today:today(),period:month,quarter:quarter(),rules:isAdmin?rules:{thresholds:rules.thresholds,sop:rules.sop,commission_visible:true,result_visible:true,performance:rules.performance},stages:STAGES,users:isAdmin?users:users.map(u=>({id:u.id,name:u.name,role:u.role,active:u.active})),customers,opportunities,activities,activityEvents:events.filter(e=>oppIds.has(e.opportunity_id)),quotes,contracts,contacts:contactsRaw.filter(c=>customerIds.has(c.customer_id)),team,performance,commission,
    targets,contractDashboard:contractDashboard(contracts,month),collections:importedCollections(contracts,importedSources.collections,{hideMargin:isPm,maintainedFields}),
    stageHistory:all(db,'SELECT * FROM stage_history ORDER BY id').filter(h=>oppIds.has(h.opportunity_id)),
    refresh:{enabled:false,schedule:null,missedRunPolicy:null,lastRun:one(db,'SELECT created_at FROM daily_reports ORDER BY day DESC LIMIT 1')?.created_at||null},
    audit:isAdmin?all(db,"SELECT a.*,u.name user_name,op.name operator_name,target.name acting_as_name FROM audit a LEFT JOIN users u ON u.id=a.user_id LEFT JOIN users op ON op.id=CASE WHEN json_valid(a.detail) THEN json_extract(a.detail,'$.operator_user_id') END LEFT JOIN users target ON target.id=CASE WHEN json_valid(a.detail) THEN json_extract(a.detail,'$.acting_as_user_id') END ORDER BY a.id DESC LIMIT 200"):[],
    ...(isAdmin?{integrationSettings:integrationSettings(db)}:{}),
    ai:{configured:!!ai.configured,model:ai.model||'deepseek-v4-1-flash',batches:batchHistory(db,actor),importHistory:imported,businessTables:businessTableCatalog(db,actor.role)},
    integrations:[{id:'dingtalk',name:'钉钉身份登录',status:ding.loginConfigured?'服务端已配置':'待配置企业应用',description:'企业身份校验后映射到本地角色；成员本人扫码需实际验收。'},{id:'minutes',name:'钉钉听记',status:context.minutes?.enabled?'接口连接可用':'待配置连接器',description:'成员本人授权后从连接时起采集新听记；总结、逐字稿及录音分别记录实际读取状态。'},{id:'templates',name:'报价与合同文件',status:integrationSettings(db).documents.confirmed?'公司模板已确认':'内部核对稿可导出',description:'公司报价与合同模板统一通过AI接收维护；未确认时文件明确标注内部核对稿。'},{id:'llm',name:'AI资料接收',status:ai.configured?'紫猫云 DeepSeek已配置':'待配置AI凭据',description:'统一接收资料，校验并经确认后入库；商机 AI 分析仅在手动点击后结合当前客户资料、售卖产品及跟进记录生成，原阶段规则建议继续保留；合同附件提取仅形成核对提案。'}]};
}
