import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {openDatabase} from '../server/database.mjs';
import {normalize} from '../server/domain.mjs';
import {parseSourceMoney} from './import-qfcrm.mjs';
import {QFCRM_SOURCE_FORMAT,itemSignature,paymentSignature} from '../server/qfcrm-source-fields.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const check=(yes,message)=>{if(!yes)throw Error(message);};
const text=value=>typeof value==='string'?value.trim():'';
const first=value=>Array.isArray(value)&&value.length===1?text(value[0]):'';
const date=value=>{const v=text(value).replaceAll('/','-').slice(0,10),d=new Date(v+'T12:00:00Z');return /^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(d.valueOf())&&d.toISOString().slice(0,10)===v?v:null;};
const money=value=>{const n=parseSourceMoney(value);return Number.isSafeInteger(n)&&n>=0?n:null;};
const orderedTypes=new Set(['代销','经销','千帆']);
const stages={'线索阶段':'线索','需求阶段':'需求','方案阶段':'方案','商务阶段':'商务','赢单':'赢单','输单':'输单','搁置':'搁置'};
const saleTypes={'新签（自建）':'新签自建','新签（分发）':'新签分发','续费':'续费','增购':'增购'};
const renewal=value=>['新签（自建）','新签（分发）','经销品'].includes(value)?value:/^续签[一二三四五六七八九十\d]*$/.test(value||'')?'续费':value==='续费'?'续费':null;
const quote=value=>'"'+value.replaceAll('"','""')+'"';
const encode=value=>JSON.stringify(value,(_key,item)=>item instanceof Uint8Array?{bytes:item.length,sha256:hash(item)}:item);
const ownedPath=filename=>{const full=fs.realpathSync(filename),relative=path.relative(root,full);check(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&!/^(?:\\\\|\/\/)/.test(full),'仅允许本项目的本地数据库和资料路径');return full;};

export function importQfcrmThreeTables({database,snapshotPath,attachmentsPath,apply=false,deployment,expectedCounts,expectedSnapshotHash}={}){
 check(deployment==='local'&&process.env.CRM_RUNTIME_ENVIRONMENT!=='server'&&process.env.NODE_ENV!=='production','仅允许本地离线导入');
 const dbFile=ownedPath(database);check(/\.(sqlite|db)$/.test(dbFile)&&!/(?:^|[\\/])(?:production|releases|server)[\\/]/i.test(path.relative(root,dbFile)),'数据库必须位于本项目本地 data/runtime');
 check(['app/data','runtime'].some(part=>{const relative=path.relative(path.join(root,part),dbFile);return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative); }),'数据库仅允许 app/data 或 runtime，不允许操作备份原件');
 const raw=fs.readFileSync(snapshotPath),snapshotHash=hash(raw),snapshot=JSON.parse(raw);
 check(!expectedSnapshotHash||snapshotHash===expectedSnapshotHash,'来源快照指纹已变化');
 check(snapshot.format===QFCRM_SOURCE_FORMAT&&snapshot.base_id==='EpGBa2Lm8amK9zQLhZrdY5aG8gN7R35y','来源格式或QFCRM表身份不一致');
 check(snapshot.cutoff==='2026-10-01T00:00:00+08:00','创建时间边界必须明确为北京时间2026-10-01');
 const tables=new Map(snapshot.tables.map(t=>[t.name,t.records]));
 check(tables.size===3&&['PPL总表','合同总表','项目回款计划'].every(n=>tables.has(n)),'必须且只能包含指定三张主表');
 for(const records of tables.values()){
  check(new Set(records.map(r=>r.record_id)).size===records.length,'来源表存在重复记录ID');
  for(const r of records)check(typeof r.created_at==='string'&&Number.isFinite(Date.parse(r.created_at))&&Date.parse(r.created_at)>=Date.parse(snapshot.cutoff),'存在创建时间缺失或范围外记录');
 }
 const attachments=JSON.parse(fs.readFileSync(attachmentsPath,'utf8'));
 check(attachments.archive_sha256===snapshot.archive.sha256,'ZIP附件包与主表快照不一致');
 for(const adjustment of snapshot.adjustments||[]){
  const record=tables.get('项目回款计划').find(r=>r.record_id===adjustment.record_id);
  check(record&&['合同金额','未回款金额'].includes(adjustment.field)&&record.values[adjustment.field]===adjustment.import_value&&record.corrections?.some(c=>JSON.stringify(c)===JSON.stringify(adjustment))&&attachments.files.some(f=>f.contract_no===adjustment.contract_no&&f.sha256===adjustment.evidence_sha256),'本地原件核对修正缺少逐字段记录或附件依据');
 }
 const report={format:QFCRM_SOURCE_FORMAT,snapshot_sha256:snapshotHash,cutoff:snapshot.cutoff,source_read_only:true,source_counts:Object.fromEntries([...tables].map(([k,v])=>[k,v.length])),verified_adjustments:snapshot.adjustments||[],created:{},updated:{},imported:{},pending:[],field_issues:[],attachment_issues:[]};
 if(!apply)return {...report,mode:'preview',status:'source-validated'};
 const db=openDatabase(dbFile),all=(sql,...args)=>db.prepare(sql).all(...args),one=(sql,...args)=>db.prepare(sql).get(...args);
 const run=(sql,...args)=>db.prepare(sql).run(...args),inc=(group,key)=>{report[group][key]=(report[group][key]||0)+1;};
 const insert=(table,row)=>Number(run(`INSERT INTO ${quote(table)} (${Object.keys(row).map(quote).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`,...Object.values(row)).lastInsertRowid);
 const update=(table,id,row)=>run(`UPDATE ${quote(table)} SET ${Object.keys(row).map(k=>quote(k)+'=?').join(',')} WHERE id=?`,...Object.values(row),id);
 const marker='qfcrm-three-table-import:'+snapshotHash;
 const saved=one('SELECT value FROM settings WHERE key=?',marker);if(saved){
  try{for(const [table,records] of tables)for(const r of records){const fp=hash(JSON.stringify([snapshotHash,table,r.record_id])),source=one('SELECT entity,entity_id,status FROM source_records WHERE fingerprint=?',fp);check(source,'已导入快照的来源证据缺失');if(source.status==='imported'){const target={opportunity:'opportunities',contract:'contracts'}[source.entity];check(target&&one('SELECT 1 FROM '+quote(target)+' WHERE id=?',source.entity_id),'已导入来源对应的业务记录缺失，禁止误报重复导入成功');}}return {...JSON.parse(saved.value),status:'already-imported'};}
  finally{db.close();}
 }
 const at=new Date().toISOString(),sourceUrl='https://alidocs.dingtalk.com/i/nodes/'+snapshot.base_id;
 const users=all("SELECT * FROM users WHERE active=1 AND business_member=1 AND developer_admin=0 AND role IN('sales','admin')");
 const allUsers=all('SELECT * FROM users');
 const actor=one("SELECT id FROM users WHERE developer_admin=1 AND active=1 ORDER BY id LIMIT 1")?.id??null;
 const owner=descriptors=>{
  if(!Array.isArray(descriptors)||descriptors.length!==1)return null;
  const d=descriptors[0],name=d.name==='暮雪'?'米粒':d.name;
  const matches=users.filter(u=>d.id?u.ding_user_id===d.id:u.name===name);
  return matches.length===1?matches[0].id:null;
 };
 const nonBusiness=descriptors=>Array.isArray(descriptors)&&descriptors.some(d=>allUsers.some(u=>(d.id?u.ding_user_id===d.id:u.name===d.name)&&(u.business_member!==1||u.developer_admin===1||u.active!==1)));
 const people=descriptors=>Array.isArray(descriptors)?descriptors.map(d=>d.name).filter(v=>typeof v==='string'&&v):[];
 const preservedTables=['customers','contacts','users','sessions','settings','ding_identities','customer_profiles','activities','activity_events','minutes_records','minutes_artifacts','minutes_sources','performance_reviews','commission_batches','commission_lines','targets','daily_reports'];
 const before=new Map(preservedTables.map(t=>[t,all('SELECT * FROM '+quote(t))]));
 const guards=all("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN ('opportunities_required_cash_insert','opportunities_required_cash_update','opportunities_required_classification_insert','opportunities_required_classification_update','customers_required_owner_insert','opportunities_required_owner_insert','opportunities_required_owner_update','contracts_required_owner_insert','contracts_required_owner_update')");
 check(guards.length===9,'缺少预期新增/维护约束，不允许历史例外导入');
 const triggerSql=all("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name");
 const sourceRow=(table,r,entity,id,extra={},status='imported',reason='')=>{
  const payload={format:QFCRM_SOURCE_FORMAT,base_id:snapshot.base_id,record_id:r.record_id,created_at:r.created_at,values:r.values,links:r.links,raw:r.raw,...(r.corrections?{verified_adjustments:r.corrections}:{}),...extra};
  const fingerprint=hash(JSON.stringify([snapshotHash,table,r.record_id]));
  return insert('source_records',{source:'QFCRM',source_table:table,source_id:r.record_id,entity,entity_id:id,payload:JSON.stringify(payload),source_file:sourceUrl,sheet_name:table,row_number:null,imported_at:at,fingerprint,status,reason});
 };
 const pending=(table,r,reason)=>{report.pending.push({table,record_id:r.record_id,reference:r.values['商机编号']||r.values['合同编号']||r.values['项目名称'],reason});sourceRow(table,r,null,null,{},'pending',reason);};
 const issues=(table,r,messages)=>{if(messages.length)report.field_issues.push({table,record_id:r.record_id,reference:r.values['商机编号']||r.values['合同编号']||r.values['项目名称'],issues:messages});};
 const customers=new Map(all('SELECT * FROM customers').map(c=>[c.normalized,c]));
 const customerOwnerSets=new Map();
 for(const table of ['PPL总表','合同总表'])for(const r of tables.get(table)){
  const name=first(r.values['客户名称']),uid=owner(r.values['销售小二']);if(!name||!uid)continue;
  const key=normalize(name);if(!customerOwnerSets.has(key))customerOwnerSets.set(key,new Set());customerOwnerSets.get(key).add(uid);
 }
 const customer=(names,uid,origin)=>{
  const name=first(names);check(name,'客户名称必须能唯一解析');const key=normalize(name);let row=customers.get(key);
  if(!row){const owners=customerOwnerSets.get(key)||new Set([uid]);const id=insert('customers',{name,normalized:key,owner_id:owners.size===1?[...owners][0]:null,note:'三表历史资料导入的真实客户引用；未补造原始建档日期。',created_at:at,updated_at:at});row=one('SELECT * FROM customers WHERE id=?',id);customers.set(key,row);inc('created','customers');sourceRow('客户引用',origin,'customer',id,{},'imported',row.owner_id===null?'来源无法唯一确定在用业务负责人，保留NULL，原客户名称及引用保留':'来源三表的真实客户引用');run("UPDATE company_profile_jobs SET manual_only=1,status='failed',error_code='MANUAL_REQUIRED',reason='三表历史导入客户的企业资料需手动查询',next_retry_at=NULL WHERE customer_id=?",id);}
  if(uid)run('INSERT OR IGNORE INTO customer_collaborators(customer_id,user_id) VALUES(?,?)',row.id,uid);
  return row.id;
 };
 let transaction=false;
 try{
  db.exec('BEGIN IMMEDIATE');transaction=true;
  for(const [table,count] of Object.entries(expectedCounts||{}))check(one('SELECT count(*) n FROM '+quote(table)).n===count,'本地数据计数已变化：'+table);
  check(one('SELECT count(*) n FROM contracts').n===0&&one('SELECT count(*) n FROM payments').n===0,'本地合同/回款已存在，须先审查替换范围，禁止混入第二套数据');
  check(one("SELECT count(*) n FROM commission_batches WHERE status!='draft'").n===0,'存在已确认提成，不允许覆盖本地测试业务');
  for(const g of guards)db.exec('DROP TRIGGER '+quote(g.name));
  report.archived_opportunities=Number(run('UPDATE opportunities SET archived_at=? WHERE archived_at IS NULL',at).changes);
  run("UPDATE source_records SET status='archived',reason=CASE WHEN reason='' THEN '本地三表重导前的历史来源，原文保留' ELSE reason END WHERE entity='opportunity' AND status='imported'");
  for(const r of tables.get('PPL总表')){
   const v=r.values,uid=owner(v['销售小二']),amount=money(v['合同金额']),name=text(v['售卖产品']),ref=text(v['商机编号']);
   if(!first(v['客户名称'])||!name||amount===null||!stages[v['商机阶段']]||!ref){pending('PPL总表',r,'缺客户、售卖产品、有效金额或阶段');continue;}
   const warnings=[],cash=money(v['cash金额']);let product=cash;
   if(!uid)warnings.push(nonBusiness(v['销售小二'])?'原归属为非业务账号，姓名保留但不计入该账号业绩':'原销售姓名保留，负责人待分配；未创建占位成员');
   if(cash!==null&&cash>amount){product=null;warnings.push('cash金额大于合同金额；原值保留，业务金额待核对');}
   if(product===null)warnings.push('cash金额缺失或冲突，保留NULL');
   const sale=saleTypes[v['产品类型']]||null,order=orderedTypes.has(v['订单类型'])?v['订单类型']:null;
   if(!sale)warnings.push('销售分类未提供或无法唯一映射');if(!order)warnings.push('订单类型未提供或不在既定分类内');
   const cid=customer(v['客户名称'],uid,r),row={customer_id:cid,name,owner_id:uid,stage:stages[v['商机阶段']],amount,initial_amount:amount,product_amount:product,sale_type:sale,order_type:order,next_action:'',follow_date:null,expected_date:date(v['预计到单时间']),stage_at:r.created_at,lost_reason:'',created_at:r.created_at,updated_at:v['最后更新时间']||r.created_at,reference:ref,collaborator_pm:null,archived_at:null};
   const old=one('SELECT id FROM opportunities WHERE reference=?',ref);let id;
   if(old){id=old.id;update('opportunities',id,row);inc('updated','opportunities');}else{id=insert('opportunities',row);inc('created','opportunities');}
   sourceRow('PPL总表',r,'opportunity',id,{opportunity:{sales_names:people(v['销售小二'])}},'imported',uid?'':'原销售姓名保留，尚未映射到在用业务成员；不创建占位账号');inc('imported','PPL总表');issues('PPL总表',r,warnings);
  }
  const contractMap=new Map(),contractFacts=new Map();
  for(const r of tables.get('合同总表')){
   const v=r.values,uid=owner(v['销售小二']),amount=money(v['合同金额']),ref=text(v['合同编号']);
   if(!first(v['客户名称'])||amount===null||amount<=0||!ref){pending('合同总表',r,'缺客户、合同编号或有效合同金额');continue;}
   const warnings=[],names=(v['售卖产品']||[]).filter(n=>typeof n==='string'&&n),types=Array.isArray(v['产品类型'])?v['产品类型']:[];
   if(!uid)warnings.push(nonBusiness(v['销售小二'])?'原归属为非业务账号，姓名保留但不计入该账号业绩':'原销售姓名保留，负责人待分配；未创建占位成员');
   const prod=money(v['产品金额']),service=money(v['项目/服务金额']),pm=money(v['产品毛利']),sm=money(v['项目/服务毛利']);
   if(prod!==null&&service!==null&&prod+service!==amount)warnings.push('产品金额与项目/服务金额合计不等于合同金额；保留原值');
   if(!date(v['合同签订时间']))warnings.push('合同签订时间缺失，未补造日期');
   if(types.some(t=>!['标品','交付','定开','运维'].includes(t)))warnings.push('原产品类型含规范以外选项，保留原文待核对');
   const tag=renewal(v['产品续签标签']),order=orderedTypes.has(v['订单类型'])?v['订单类型']:null;
   if(!tag&&v['产品续签标签'])warnings.push('续签标签未能唯一归入既定分类');if(!order)warnings.push('订单类型缺失或不属于代销/经销/千帆');
   const cid=customer(v['客户名称'],uid,r),id=insert('contracts',{customer_id:cid,opportunity_id:null,owner_id:uid,name:names.join('、')||ref,contract_no:ref,amount,sign_date:date(v['合同签订时间'])||'',valid_until:date(v['产品最新到期时间']),scope:text(v['合同关键信息摘取']),created_at:r.created_at,renewal_tag:tag,payment_type:['客户直付天元','千帆收款'].includes(v['付款类型'])?v['付款类型']:null,order_type:order,sale_type:tag==='续费'?'续费':saleTypes[tag]||null,lifecycle:'历史登记',commission_policy:'pending'});inc('created','contracts');
   const title=names.join('、')||ref;
   if(prod!==null&&prod>0)insert('contract_items',{contract_id:id,name:title,kind:'标品',amount:prod,rate:null,margin:pm!==null&&pm<=prod?pm:null,payment_date:null,valid_until:date(v['产品最新到期时间']),man_days:0}),inc('created','contract_items');
   if(service!==null&&service>0){const kinds=types.filter(t=>['交付','定开','运维'].includes(t));insert('contract_items',{contract_id:id,name:title,kind:kinds.length===1?kinds[0]:'未分类',amount:service,rate:null,margin:sm!==null&&sm<=service?sm:null,payment_date:null,valid_until:date(v['产品最新到期时间']),man_days:0});inc('created','contract_items');}
   let rate=v['产品毛利率']===null||v['产品毛利率']===undefined?null:Number(v['产品毛利率']);if(rate!==null&&(!Number.isFinite(rate)||rate<0||rate>1)){rate=null;warnings.push('产品毛利率格式无效，原值保留');}
   contractMap.set(r.record_id,{id,ref,amount,customer_id:cid,owner_id:uid,product:prod,service});
   contractFacts.set(id,{record:r,facts:{contract_no:ref,amount,sales_names:people(v['销售小二']),product_names:names,product_types:types,product_amount:prod,service_amount:service,product_margin:pm,service_margin:sm,total_margin:money(v['总毛利']),product_margin_rate:rate,received_at:date(v['回款时间']),collection_status:v['回款状态']||null,issues:warnings}});
   inc('imported','合同总表');issues('合同总表',r,warnings);
  }
  const collectionCandidates=[];
  for(const r of tables.get('项目回款计划')){
   const refs=r.links['合同总表 4']||[],parent=refs.length===1?contractMap.get(refs[0]):null;
   if(!parent){pending('项目回款计划',r,refs.length!==1?'缺少唯一关联合同':'关联合同在创建时间范围之外，或合同自身缺关键资料未入库');continue;}
   const v=r.values,expectedCustomer=first(v['客户']);
   if(!expectedCustomer||normalize(expectedCustomer)!==one('SELECT normalized FROM customers WHERE id=?',parent.customer_id).normalized){pending('项目回款计划',r,'回款客户与关联合同客户不一致');continue;}
   const amount=money(v['合同金额']),rawPaid=money(v['已回款金额']),paid=rawPaid===null&&v['是否回款']==='否'?0:rawPaid,unpaid=money(v['未回款金额']);
   if(amount===null||paid!==null&&paid>amount){pending('项目回款计划',r,'项目金额无效或已回款超过项目金额');continue;}
   const warnings=[];if(paid===null)warnings.push('已回款金额缺失，未从“是否回款”猜造金额');if(paid>0&&!date(v['实际回款时间']))warnings.push('已回款金额有值但实际回款日期缺失，未生成到账流水');
   if(paid!==null&&unpaid!==null&&paid+unpaid!==amount)warnings.push('已回款与未回款合计不等于原项目金额');
   const collection={record_id:r.record_id,created_at:r.created_at,amount,paid_amount:paid,source_outstanding:unpaid,product_names:(v['产品']||[]).filter(Boolean),project_statuses:v['项目状态']?[v['项目状态']]:[],received_at:date(v['实际回款时间']),expected_at:date(v['预计回款时间']),product_margin:money(v['产品毛利']),service_margin:money(v['服务毛利']),total_margin:money(v['总毛利']),sales_names:people(v['销售经理']),manager_names:people(v['项目经理']),delivery_names:people(v['研发\\交付人员']),note:text(v['备注']),payment_ids:[],issues:warnings};
   collectionCandidates.push({r,parent,collection,unpaid});issues('项目回款计划',r,warnings);
  }
  const receivedTotals=new Map(),plannedTotals=new Map();
  for(const x of collectionCandidates){receivedTotals.set(x.parent.id,(receivedTotals.get(x.parent.id)||0)+(x.collection.paid_amount>0&&x.collection.received_at?x.collection.paid_amount:0));plannedTotals.set(x.parent.id,(plannedTotals.get(x.parent.id)||0)+(x.unpaid||0));}
  for(const x of collectionCandidates){
   const {r,parent,collection:c,unpaid}=x;
   if(receivedTotals.get(parent.id)>parent.amount){pending('项目回款计划',r,'同合同的已到账金额合计超过合同金额，未生成重复到账流水');continue;}
   const overplanned=receivedTotals.get(parent.id)+plannedTotals.get(parent.id)>parent.amount;
   if(overplanned){c.issues.push('同合同的原计划合计超额，原项目字段保留，未重复生成待到账计划');issues('项目回款计划',r,[c.issues.at(-1)]);}
   const productAmount=amount=>parent.product===parent.amount&&parent.service===0?amount:parent.product===0&&parent.service===parent.amount?0:null;
   if(c.paid_amount>0&&c.received_at){const id=insert('payments',{contract_id:parent.id,amount:c.paid_amount,status:'已到账',pay_date:c.received_at,promise_date:c.expected_at,note:text(r.values['项目名称']),created_at:r.created_at,product_amount:productAmount(c.paid_amount)});c.payment_ids.push(id);inc('created','received_payments');}
   if(unpaid>0&&!overplanned){const id=insert('payments',{contract_id:parent.id,amount:unpaid,status:c.expected_at&&c.expected_at<at.slice(0,10)?'逾期':'待到账',pay_date:null,promise_date:c.expected_at,checkpoint_date:c.expected_at,note:text(r.values['项目名称']),created_at:r.created_at,product_amount:null});c.payment_ids.push(id);inc('created','planned_payments');}
   c.payment_signature=paymentSignature(all('SELECT * FROM payments WHERE contract_id=?',parent.id).filter(p=>c.payment_ids.includes(p.id)));
   sourceRow('项目回款计划',r,'contract',parent.id,{collection:c});inc('imported','项目回款计划');
  }
  for(const [id,{record,facts}] of contractFacts){facts.item_signature=itemSignature(all('SELECT * FROM contract_items WHERE contract_id=?',id));facts.payment_signature=paymentSignature(all('SELECT * FROM payments WHERE contract_id=?',id));sourceRow('合同总表',record,'contract',id,{contract:facts},'imported',one('SELECT owner_id FROM contracts WHERE id=?',id).owner_id?'':'原销售姓名保留，尚未映射到在用业务成员；不创建占位账号');}
  const byRef=new Map([...contractMap.values()].map(c=>[c.ref,c]));
  for(const f of attachments.files){
   const c=byRef.get(f.contract_no);if(!c){report.attachment_issues.push({file:f.source_path,reason:'合同未进入本次业务导入范围'});continue;}
   const online=f.origin==='dingtalk_readonly_attachment';
   check(online?f.source_path.startsWith('QFCRM-AITABLE/合同总表/合同附件/'+f.contract_no+'/')&&tables.get('合同总表').some(r=>r.values['合同编号']===f.contract_no&&(r.values['合同附件']||[]).some(a=>a.resourceId===f.resource_id)):f.source_path.startsWith('QFCRM-FILE/合同总表/合同附件/'),'附件来源目录或原记录身份不正确');ownedPath(f.path);const bytes=fs.readFileSync(f.path);check(hash(bytes)===f.sha256&&bytes.length===f.size,'附件内容指纹不一致');
   const id=insert('attachments',{entity:'contract',entity_id:c.id,filename:f.filename,mime_type:f.mime_type,size:f.size,sha256:f.sha256,content:bytes,source_path:f.source_path,created_at:at,created_by:null});inc('created','attachments');
   insert('source_records',{source:'QFCRM',source_table:'合同附件',source_id:f.source_path,entity:'attachment',entity_id:id,payload:JSON.stringify({archive_sha256:online?null:snapshot.archive.sha256,origin:online?'dingtalk_readonly_attachment':'QFCRM.zip',resource_id:f.resource_id||null,sha256:f.sha256,contract_no:f.contract_no,source_path:f.source_path}),source_file:online?sourceUrl:snapshot.archive.path,sheet_name:'合同附件',row_number:null,imported_at:at,fingerprint:hash(snapshotHash+':attachment:'+f.source_path),status:'imported',reason:''});
  }
  for(const g of guards)db.exec(g.sql);
  check(encode(triggerSql)===encode(all("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name")),'导入例外约束未完整恢复');
  for(const [table,rows] of before){const columns=Object.keys(rows[0]||{});if(!rows.length)continue;const now=all('SELECT '+columns.map(quote).join(',')+' FROM '+quote(table)),original=new Set(rows.map(encode));check(now.filter(row=>original.has(encode(row))).length===rows.length,'原有受保护记录发生变化：'+table);}
  check(all('PRAGMA foreign_key_check').length===0&&one('PRAGMA quick_check').quick_check==='ok','导入后的数据库完整性检查未通过');
  report.totals={active_opportunities:one('SELECT count(*) n FROM opportunities WHERE archived_at IS NULL').n,archived_opportunities:one('SELECT count(*) n FROM opportunities WHERE archived_at IS NOT NULL').n,contracts:one('SELECT count(*) n FROM contracts').n,payments:one('SELECT count(*) n FROM payments').n,attachments:one('SELECT count(*) n FROM attachments').n,customers:one('SELECT count(*) n FROM customers').n,preserved_activities:one('SELECT count(*) n FROM activities').n};
  report.status='complete';report.imported_at=at;
  insert('audit',{user_id:actor,action:'本地按听记字段重导QFCRM三表',entity:'source',entity_id:null,detail:JSON.stringify({snapshot_sha256:snapshotHash,cutoff:snapshot.cutoff,source_read_only:true,imported:report.imported,pending:report.pending.length,created:report.created,followups_preserved:true}),created_at:at});
  run('INSERT INTO settings(key,value) VALUES(?,?)',marker,JSON.stringify(report));db.exec('COMMIT');transaction=false;return report;
 }catch(error){if(transaction)db.exec('ROLLBACK');throw error;}finally{db.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const opts={};for(let i=2;i<process.argv.length;i++){const k=process.argv[i];if(k==='--apply')opts.apply=true;else{check(process.argv[i+1]&&!process.argv[i+1].startsWith('--'),'参数缺值：'+k);opts[k.slice(2)]=process.argv[++i];}}
 try{const result=importQfcrmThreeTables({database:opts.database,snapshotPath:opts.snapshot,attachmentsPath:opts.attachments,deployment:opts.deployment,apply:opts.apply,expectedCounts:opts.expect?JSON.parse(fs.readFileSync(opts.expect,'utf8')):undefined,expectedSnapshotHash:opts.sha256});if(opts.report)fs.writeFileSync(opts.report,JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,source_counts:result.source_counts,imported:result.imported,created:result.created,updated:result.updated,pending:result.pending.length,totals:result.totals}));}
 catch(error){console.error(error.stack);process.exitCode=1;}
}
