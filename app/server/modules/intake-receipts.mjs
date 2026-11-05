import {all,one} from '../database.mjs';
import {intakeDestinations,intakeTypes} from '../../public/modules/intake-schema.js';

const legacyPerformance={module:'performance',label:'绩效评定',table:'performance_reviews',route:'performance'};
export function destinationFor(type) {return intakeDestinations[type]||(type==='performance_review'?legacyPerformance:null);}
export function operationDestinations(db,op,data,id) {
  const base=destinationFor(op.type);if(!base)return [];
  const make=(row,extra={})=>({...base,module_label:base.label,record_id:row?.id??id??null,record_key:String(row?.id??id??''),record_label:row?.name||row?.summary||intakeTypes[op.type]||op.type,view:base.route,...extra});
  if(op.type==='target') {
    const u=one(db,'SELECT name FROM users WHERE id=?',data.user_id);
    return [make(null,{record_id:null,record_key:`${data.user_id}/${data.quarter}`,record_label:`${u?.name||'销售'} · ${data.quarter}`,user_id:data.user_id,quarter:data.quarter})];
  }
  if(op.type==='rules')return [
    ...(data.thresholds||data.sop?[make(null,{record_id:null,record_key:'rules',record_label:'阶段规则',view:'opportunities',section:'stage_rules'})]:[]),
    ...(data.customer_levels?[make(null,{record_id:null,record_key:'rules',record_label:'客户等级规则',view:'customers',section:'customer_levels'})]:[]),
    ...(data.commission?[make(null,{record_id:null,record_key:'rules',record_label:'提成规则',view:'commissions',section:'finance_rules'})]:[]),
    ...(data.performance?[make(null,{record_id:null,record_key:'rules',record_label:'绩效规则',view:'performance',section:'performance_rules'})]:[]),
  ];
  if(base.table==='settings')return [make(null,{record_id:null,record_key:'integrations',record_label:base.label,section:op.type==='ppl_config'?'ppl':'documents'})];
  if(['ppl_snapshot','change_request','change_request_review'].includes(op.type))return [make(null,{record_label:base.label+'（历史操作已停用）',historical:true})];
  const row=id?one(db,`SELECT * FROM ${base.table} WHERE id=?`,id):null;
  if(!row)return [make(null,{record_label:(op.data?.name||op.data?.summary||intakeTypes[op.type])+'（历史记录）',historical:true})];
  const record=make(row);
  if(op.type==='customer')Object.assign(record,{detail_action:'customer',detail_id:id});
  if(op.type==='contact')Object.assign(record,{record_label:row.name,detail_action:'customer',detail_id:row.customer_id});
  if(op.type==='opportunity')Object.assign(record,{detail_action:'opportunity',detail_id:id});
  if(['activity','quote'].includes(op.type))Object.assign(record,{record_label:op.type==='quote'?'报价 #'+id:row.summary,detail_action:'opportunity',detail_id:row.opportunity_id});
  if(op.type==='contract'||op.type==='contract_archive') {
    Object.assign(record,{detail_action:'contract',detail_id:id});
    const lines=all(db,'SELECT id,name FROM contract_items WHERE contract_id=? ORDER BY id',id);
    record.related_records=lines.map(line=>({table:'contract_items',record_id:line.id,record_label:line.name}));
  }
  if(op.type==='contract_attachment')Object.assign(record,{record_label:row.filename,detail_action:'contract',detail_id:row.entity_id});
  if(['contract_item','payment','payment_receive','payment_allocation','payment_checkpoint'].includes(op.type)) {
    const contract=one(db,'SELECT name FROM contracts WHERE id=?',row.contract_id);
    Object.assign(record,{record_label:op.type==='contract_item'?row.name:`${contract?.name||'合同'} · 回款 #${id}`,detail_action:'contract',detail_id:row.contract_id});
  }
  if(['commission_confirm','commission_pay'].includes(op.type)) {
    const user=one(db,'SELECT name FROM users WHERE id=?',row.sales_id);
    record.record_label=`${user?.name||'销售'} · ${row.period} · ${row.kind==='personal'?'个人':'管理'}提成`;
  }
  if(['change_request','change_request_review'].includes(op.type))record.record_label=`${row.entity==='customer'?'客户':'商机'}骨架申请 #${id}`;
  return [record];
}
export function batchRecords(db,batch) {
  if(batch.state!=='confirmed')return [];
  return (batch.result||[]).flatMap((result,index)=>{
    const op=batch.operations.find(op=>op.ref===result.ref)||batch.operations[index]||{type:result.type,data:{}};
    let records=result.destinations;
    // Older receipts contain stable IDs but no destination snapshot. Do not invent composite keys or dates.
    if(!records) {
      const base=destinationFor(result.type);
      records=base&&result.id?operationDestinations(db,op,op.data||{},result.id):base?[{...base,module_label:base.label,view:base.route,record_id:null,record_key:'',record_label:base.label+'（历史批次未记录具体键）',historical:true}]:[];
    }
    return records.map(record=>({...record,type:result.type,action:result.action||op.action||'create',source_file:result.source_file||op.source_file||'补充说明',imported_at:batch.confirmed_at||null}));
  });
}
export function batchHistory(db,actor) {
  const rows=all(db,`SELECT b.id,b.user_id,b.source_role,b.state,b.summary,b.errors,b.created_at,b.confirmed_at,b.operations,b.result,
    (SELECT json_group_array(filename) FROM ai_uploads WHERE batch_id=b.id) filenames
    FROM ai_import_batches b ${actor.role==='admin'?'':'WHERE b.user_id=? AND b.source_role!=\'admin\''} ORDER BY b.id DESC LIMIT 50`,...(actor.role==='admin'?[]:[actor.id]));
  return rows.map(row=>{
    const batch={...row,operations:JSON.parse(row.operations),result:row.result?JSON.parse(row.result):null};
    const records=batchRecords(db,batch),groups=new Map();
    for(const record of records) {
      const key=record.module;if(!groups.has(key))groups.set(key,{module:key,label:record.module_label.split(' · ')[0],keys:new Set()});
      groups.get(key).keys.add(`${record.table}/${record.record_id??record.record_key??record.record_label}`);
    }
    return {id:row.id,user_id:row.user_id,source_role:row.source_role,state:row.state,summary:row.summary,errors:JSON.parse(row.errors),created_at:row.created_at,confirmed_at:row.confirmed_at,files:JSON.parse(row.filenames),operation_count:batch.operations.length,
      destinations:[...groups.values()].map(({keys,...group})=>({...group,count:keys.size})),planned_destinations:[...new Set(batch.operations.map(op=>destinationFor(op.type)?.label).filter(Boolean))]};
  });
}
