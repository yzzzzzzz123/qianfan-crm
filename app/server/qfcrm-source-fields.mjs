import {createHash} from 'node:crypto';

export const QFCRM_SOURCE_FORMAT='qfcrm-three-table-v1';
const signature=(rows,keys)=>createHash('sha256').update(JSON.stringify(rows.map(row=>keys.map(key=>row[key]??null)).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex');
export const itemSignature=rows=>signature(rows,['name','kind','amount','margin']);
export const paymentSignature=rows=>signature(rows,['id','amount','status','pay_date','promise_date','product_amount']);
const moneyKeys=['product_amount','product_margin','service_amount','service_margin','total_margin'];
const validMoney=v=>v===null||Number.isSafeInteger(v)&&v>=0;
const validDate=v=>v===null||typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v));
const strings=v=>Array.isArray(v)&&v.every(s=>typeof s==='string'&&s.length<=500);

export function qfcrmSourceFields(db){
 const contracts=new Map(),opportunities=new Map(),collections=[];
 for(const source of db.prepare("SELECT id,entity_id,payload,imported_at FROM source_records WHERE source='QFCRM' AND status='imported' ORDER BY id").all()){
  let payload;try{payload=JSON.parse(source.payload);}catch{continue;}
  if(payload?.format!==QFCRM_SOURCE_FORMAT)continue;
  if(payload.opportunity&&strings(payload.opportunity.sales_names))opportunities.set(source.entity_id,payload.opportunity);
  if(payload.contract){
   const facts=payload.contract;
   if(!moneyKeys.every(k=>validMoney(facts[k]))||!validDate(facts.received_at)||!strings(facts.product_names)||!strings(facts.product_types)||!strings(facts.issues))continue;
   if(facts.product_margin_rate!==null&&(!Number.isFinite(facts.product_margin_rate)||facts.product_margin_rate<0||facts.product_margin_rate>1))continue;
   contracts.set(source.entity_id,{...facts,source_record_id:source.id});
  }
  if(payload.collection&&Number.isSafeInteger(source.entity_id))collections.push({...payload.collection,contract_id:source.entity_id,source_record_id:source.id});
 }
 return {contracts,opportunities,collections};
}

// Source totals and empty values are business facts from the reviewed import.
// A later item/payment edit invalidates the corresponding source projection.
export function contractSourceFields(c,items,payments,facts,{hideMargin=false}={}){
 if(!facts||facts.contract_no!==c.contract_no||facts.amount!==c.amount)return {};
 const result={source_items_edited:itemSignature(items)!==facts.item_signature,...(!c.owner_id&&strings(facts.sales_names)?{owner_label:facts.sales_names.join('、')}:{} )};
 if(itemSignature(items)===facts.item_signature){
  for(const key of moneyKeys)result[key]=hideMargin&&key.includes('margin')?null:facts[key];
  result.product_margin_rate=hideMargin?null:facts.product_margin_rate;
  result.product_names=facts.product_names;result.product_types=facts.product_types;
  result.import_issues=facts.issues;
 }
 if(paymentSignature(payments)===facts.payment_signature){
  if(['未回款','部分回款','已结清'].includes(facts.collection_status))result.collection_status=facts.collection_status;
  result.last_received_at=facts.received_at;
 }
 return result;
}

export function importedCollections(contracts,records,{hideMargin=false,maintainedFields=new Map()}={}){
 if(!records.length)return undefined;
 const groups=new Map();
 for(const row of records){if(!groups.has(row.contract_id))groups.set(row.contract_id,[]);groups.get(row.contract_id).push(row);}
 const sumKnown=(rows,key)=>rows.every(r=>validMoney(r[key])&&r[key]!==null)?rows.reduce((sum,r)=>sum+r[key],0):null;
 const union=(rows,key)=>[...new Set(rows.flatMap(r=>strings(r[key])?r[key]:[]))];
 return contracts.filter(c=>c.lifecycle!=='草稿'&&(groups.has(c.id)||c.payments.length)).map(c=>{
  const rows=groups.get(c.id);if(!rows)return c;
  const dates=rows.map(r=>r.created_at).filter(d=>typeof d==='string'&&Number.isFinite(Date.parse(d))).sort((a,b)=>Date.parse(a)-Date.parse(b));
  const actual=rows.map(r=>r.received_at).filter(d=>validDate(d)&&d).sort();
  const expected=rows.filter(r=>r.paid_amount===null||r.paid_amount<r.amount).map(r=>r.expected_at).filter(d=>validDate(d)&&d).sort();
  const statuses=union(rows,'project_statuses');
  const collected=sumKnown(rows,'paid_amount');
  const margins={product_margin:sumKnown(rows,'product_margin'),service_margin:sumKnown(rows,'service_margin'),total_margin:sumKnown(rows,'total_margin')};
  const originalPayments=rows.flatMap(r=>Array.isArray(r.payment_ids)?r.payment_ids:[]);
  const paymentEdited=c.payments.some(p=>!originalPayments.includes(p.id))||rows.some(r=>r.payment_signature!==paymentSignature(c.payments.filter(p=>(r.payment_ids||[]).includes(p.id))));
  const changed=maintainedFields.get(c.id)||new Set();
  return {...c,...Object.fromEntries(Object.entries(margins).map(([k,v])=>[k,hideMargin?null:c.source_items_edited?c[k]:v])),
   product_names:c.source_items_edited?c.product_names:union(rows,'product_names'),collection_created_at:changed.has('created_at')?c.created_at:dates[0]||null,
   project_status:changed.has('project_status')?c.project_status:c.project_status||(statuses.length===1?statuses[0]:null),
   project_note:changed.has('project_note')?c.project_note:c.project_note||rows.map(r=>r.note).filter(Boolean).join('\n'),
   collection_sales_names:changed.has('owner_id')?[]:union(rows,'sales_names'),collection_manager_names:changed.has('collaborator_pm')?[]:union(rows,'manager_names'),
   delivery_staff:changed.has('delivery_staff')?c.delivery_staff:c.delivery_staff||union(rows,'delivery_names').join('、')||null,
   collected:paymentEdited?c.collected:collected,outstanding:paymentEdited?c.outstanding:collected===null?null:c.amount-collected,
   received_status:paymentEdited?c.received_status:collected===null?'待核对':collected<=0?'否':collected<c.amount?'部分回款':'是',
   next_expected_at:paymentEdited?c.next_expected_at:expected[0]||null,last_received_at:paymentEdited?c.last_received_at:actual.at(-1)||null,
   collection_source_count:rows.length};
 });
}
