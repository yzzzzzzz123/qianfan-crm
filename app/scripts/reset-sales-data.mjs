import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';

// One-time, offline LOCAL reset. This script deliberately does not import the
// application bootstrap, run migrations, initialise demo data, or start jobs.
// Preview: node scripts/reset-sales-data.mjs --db <absolute-local-db-path>
// Apply only after stopping the local application and reviewing the preview:
//   --deployment local --apply --expect customers=N,opportunities=N,contracts=N,payments=N
const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const projectRoot=path.dirname(appRoot);
const removeTables=['commission_lines','commission_batches','contract_attachment_analyses','payments','contract_items','contracts','activity_events','activities','quotes','stage_history','opportunities'];
const entities={opportunity:'opportunities',activity:'activities',quote:'quotes',contract:'contracts',contract_archive:'contracts',contract_item:'contract_items',payment:'payments',payment_receive:'payments',payment_allocation:'payments',payment_checkpoint:'payments',attachment:'attachments',contract_attachment:'attachments',commission:'commission_batches',commission_confirm:'commission_batches',commission_pay:'commission_batches'};
const attachmentEntities=new Set(['opportunity','activity','quote','contract','contract_item','payment','commission']);
const resetMark='[本地销售数据已清理]';
const requiredCounts=['customers','opportunities','contracts','payments'];
const q=value=>'"'+String(value).replaceAll('"','""')+'"';
const sha=value=>createHash('sha256').update(value).digest('hex');
const rows=(db,sql,...args)=>db.prepare(sql).all(...args);
const scalar=(db,sql,...args)=>Object.values(db.prepare(sql).get(...args))[0];
const check=(condition,message)=>{if(!condition)throw new Error(message);};
const encode=value=>JSON.stringify(value,(_key,item)=>typeof item==='bigint'?{integer:item.toString()}:item instanceof Uint8Array?{bytes:item.length,sha256:sha(item)}:item);
const digestRows=value=>({count:value.length,sha256:sha(value.map(encode).sort().join('\n'))});
const inside=(root,target)=>{const relative=path.relative(root,target);return relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};

export function assertLocalExecution(filename){
 check(!['production','server'].includes(String(process.env.NODE_ENV||'').toLowerCase())&&process.env.CRM_RUNTIME_ENVIRONMENT!=='server','拒绝在生产或服务器环境执行本地清理');
 check(typeof filename==='string'&&path.isAbsolute(filename)&&!/^\\\\|^\/\/|^[a-z]+:\/\//i.test(filename),'必须显式提供本地数据库绝对路径，不接受网络路径或URL');
 check(fs.existsSync(filename)&&fs.statSync(filename).isFile(),'指定数据库不存在或不是文件');
 const actual=fs.realpathSync(filename);
 check(!/(?:^|[\\/])(srv|www|wwwroot|releases|production|server)(?:[\\/]|$)/i.test(actual),'拒绝服务器或生产目录');
 const roots=[path.join(appRoot,'data'),path.join(projectRoot,'runtime')].filter(p=>fs.existsSync(p)).map(p=>fs.realpathSync(p));
 const temporary=path.relative(fs.realpathSync(os.tmpdir()),actual).split(path.sep);
 check(roots.some(root=>inside(root,actual))||temporary.length>1&&/^qianfan-sales-reset-[a-zA-Z0-9_-]+$/.test(temporary[0])&&!temporary.includes('..'),'清理目标仅允许本项目data/runtime或专用隔离测试目录');
 check(/\.(sqlite|sqlite3|db)$/i.test(actual),'目标必须是明确的SQLite数据库文件');
 return actual;
}

function schema(db){return rows(db,"SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");}
function allTables(db){return rows(db,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r=>r.name);}
function snapshot(db){
 const tables=Object.fromEntries([...allTables(db),'sqlite_sequence'].map(name=>[name,digestRows(rows(db,'SELECT * FROM '+q(name)))]));
 return {schema_sha256:sha(encode(schema(db))),tables};
}
function integrity(db){
 check(scalar(db,'PRAGMA quick_check')==='ok','SQLite quick_check未通过');
 check(rows(db,'PRAGMA foreign_key_check').length===0,'SQLite外键检查未通过');
}
function parsed(value,label){try{return JSON.parse(value||'null');}catch{throw new Error(label+'包含无效JSON，停止清理');}}
const inSet=(ids,table,id)=>Number.isSafeInteger(Number(id))&&Number(id)>0&&ids[table]?.has(Number(id));

function referencesDeleted(value,ids){
 if(!value||typeof value!=='object')return false;
 if(Array.isArray(value))return value.some(item=>referencesDeleted(item,ids));
 const table=entities[value.type]||entities[value.entity]||value.table||value.table_name;
 if(table&&['id','target_id','entity_id','record_id','detail_id'].some(key=>inSet(ids,table,value[key])))return true;
 if(value.type==='contract_attachment'&&inSet(ids,'contracts',value.target_id))return true;
 for(const [key,target] of Object.entries({opportunity_id:'opportunities',contract_id:'contracts',payment_id:'payments',item_id:'contract_items',activity_id:'activities',quote_id:'quotes',attachment_id:'attachments',archive_attachment_id:'attachments'}))if(inSet(ids,target,value[key]))return true;
 const intent={convert:'opportunities','edit-opportunity':'opportunities','new-activity':'opportunities','new-quote':'opportunities','edit-contract':'contracts','new-payment':'contracts','edit-item':'contract_items','receive-payment':'payments','payment-checkpoint':'payments','payment-allocation':'payments','commission-pay':'commission_batches'}[value.intent];
 if(intent&&inSet(ids,intent,value.id))return true;
 return Object.values(value).some(child=>child&&typeof child==='object'&&referencesDeleted(child,ids));
}

function plan(db){
 integrity(db);
 const tables=allTables(db),set=new Set(tables);
 for(const name of [...removeTables,'customers','contacts','customer_collaborators','customer_profiles','users','sessions','settings','audit','source_records','mutations','ai_import_batches','ai_uploads','minutes_records','minutes_artifacts','workspace_revision'])check(set.has(name),'缺少预期业务表：'+name);
 // A future dependency must be reviewed rather than silently cascaded away.
 for(const name of tables)for(const fk of rows(db,'PRAGMA foreign_key_list('+q(name)+')'))if(removeTables.includes(fk.table))check(removeTables.includes(name)||name==='minutes_records'&&fk.from==='opportunity_id','发现未纳入范围的业务外键：'+name+'.'+fk.from);
 for(const name of removeTables)check(/AUTOINCREMENT/i.test(schema(db).find(row=>row.type==='table'&&row.name===name)?.sql||''),'业务ID必须有AUTOINCREMENT防复用：'+name);
 const ids=Object.fromEntries(removeTables.map(name=>[name,new Set(rows(db,'SELECT id FROM '+q(name)).map(r=>r.id))]));
 ids.attachments=new Set(rows(db,'SELECT id,entity FROM attachments').filter(row=>attachmentEntities.has(row.entity)).map(row=>row.id));
 const sources=rows(db,'SELECT * FROM source_records').filter(row=>inSet(ids,entities[row.entity],row.entity_id)||referencesDeleted(parsed(row.payload,'来源证据'),ids)).map(row=>row.id);
 const batches=rows(db,'SELECT * FROM ai_import_batches').filter(row=>!row.summary.startsWith(resetMark)&&(referencesDeleted(parsed(row.operations,'AI操作'),ids)||referencesDeleted(parsed(row.result,'AI回执'),ids)||referencesDeleted(parsed(row.source_context,'AI上下文'),ids))).map(row=>row.id);
 const batchIds=new Set(batches);
 const mutations=rows(db,'SELECT * FROM mutations').filter(row=>{
  const match=row.key.match(/(?:^|:)(POST|PATCH|PUT|DELETE):(\/api\/[^:]*):/);if(!match)return false;
  const route=match[2],parts=route.split('/'),table={opportunities:'opportunities',activities:'activities',quotes:'quotes',contracts:'contracts',items:'contract_items',payments:'payments',commissions:'commission_batches'}[parts[2]];
  const response=parsed(row.response,'幂等回执');
  if(table&&(inSet(ids,table,parts[3])||inSet(ids,table,response?.id)||referencesDeleted(response,ids)))return true;
  if(route==='/api/ai/intake')return batchIds.has(Number(response?.id));
  return /^\/api\/ai\/batches\/\d+\/(confirm|validate|cancel)$/.test(route)&&batchIds.has(Number(parts[4]));
 }).map(row=>row.key);
 return {ids,sources,batches,mutations,summary:{delete:Object.fromEntries(removeTables.map(table=>[table,ids[table].size])),delete_attachments:ids.attachments.size,unlink_minutes:Number(scalar(db,'SELECT COUNT(*) FROM minutes_records WHERE opportunity_id IS NOT NULL')),archive_source_records:sources.length,retire_ai_batches:batches.length,tombstone_mutations:mutations.length,preserve:['客户、联系人、协作者、企业档案','账号、钉钉身份、会话、设置','听记原始记录、客户关联、正文及附件','原始导入payload与AI上传原件','绩效评定、季度目标、历史日报、审计'],id_policy:'保留所有sqlite_sequence，不复用已清业务主键'}};
}

function selectIds(db,table,key,values){const wanted=new Set(values);return rows(db,'SELECT * FROM '+q(table)).filter(row=>wanted.has(row[key]));}
const omit=(row,keys)=>Object.fromEntries(Object.entries(row).filter(([name])=>!keys.includes(name)));
function protectedState(db,p){
 const mutable=new Set([...removeTables,'attachments','minutes_records','source_records','ai_import_batches','mutations','audit','workspace_revision']);
 const retained=Object.fromEntries(allTables(db).filter(table=>!mutable.has(table)).map(table=>[table,digestRows(rows(db,'SELECT * FROM '+q(table)))]));
 retained.attachments=digestRows(rows(db,'SELECT * FROM attachments').filter(row=>!p.ids.attachments.has(row.id)));
 retained.minutes_records=digestRows(rows(db,'SELECT * FROM minutes_records').map(row=>omit(row,['opportunity_id','revision'])));
 for(const [table,idKey,affected,columns] of [['source_records','id',p.sources,['status','reason']],['ai_import_batches','id',p.batches,['state','summary','errors','source_hash','version']],['mutations','key',p.mutations,['response']]]){
  const selected=new Set(affected);retained[table]=digestRows(rows(db,'SELECT * FROM '+q(table)).map(row=>selected.has(row[idKey])?omit(row,columns):row));
 }
 retained.audit=digestRows(rows(db,'SELECT * FROM audit WHERE id<=?',p.auditMax));
 return retained;
}

function applyPlan(db,p,backupName){
 db.prepare('UPDATE minutes_records SET opportunity_id=NULL,revision=revision+1 WHERE opportunity_id IS NOT NULL').run();
 for(const table of removeTables)db.exec('DELETE FROM '+q(table));
 for(const id of p.ids.attachments)db.prepare('DELETE FROM attachments WHERE id=?').run(id);
 for(const id of p.sources)db.prepare('UPDATE source_records SET status=?,reason=?||CASE WHEN reason=\'\' THEN \'\' ELSE char(10)||reason END WHERE id=?').run('archived',resetMark+' 原业务已清理；原payload、指纹及历史主键保留，不再表示当前业务。',id);
 for(const row of selectIds(db,'ai_import_batches','id',p.batches)){
  const errors=parsed(row.errors,'AI校验结果');check(Array.isArray(errors),'AI校验结果不是数组');
  errors.push({index:-1,record:'历史批次',message:resetMark+' 对应业务已清理，原文件和入库回执仅作历史证据；请重新提交并核对新的资料。'});
  db.prepare('UPDATE ai_import_batches SET state=?,summary=?,errors=?,source_hash=?,version=version+1 WHERE id=?').run('cancelled',resetMark+' '+row.summary,JSON.stringify(errors),'reset:'+row.id+':'+row.source_hash,row.id);
 }
 const response=JSON.stringify({reset:true,requires_new_request:true,message:resetMark+' 此请求对应业务已不存在，历史回执不可重放；请刷新后重新提交并核对。'});
 for(const key of p.mutations)db.prepare('UPDATE mutations SET response=? WHERE key=?').run(response,key);
 db.prepare('UPDATE workspace_revision SET revision=revision+1 WHERE id=1').run();
 db.prepare('INSERT INTO audit(user_id,action,entity,entity_id,detail,created_at) VALUES(NULL,?,?,NULL,?,?)').run('本地清理商机合同回款','workspace',JSON.stringify({...p.summary,backup:backupName}),new Date().toISOString());
}

export function resetSalesData({databasePath,apply=false,expectedCounts,backupDirectory,deployment='local'}={}){
 check(deployment==='local','一次性销售清理仅支持local部署');
 const source=assertLocalExecution(databasePath);
 let db=new DatabaseSync(source,{readOnly:true}),transaction=false,committed=false,backupFile,receiptFile,receipt;
 try{
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN');transaction=true;
  const p=plan(db),before=snapshot(db);p.auditMax=Number(scalar(db,'SELECT COALESCE(MAX(id),0) FROM audit'));
  const retained=protectedState(db,p),sequence=rows(db,'SELECT name,seq FROM sqlite_sequence');
  db.exec('COMMIT');transaction=false;
  receipt={mode:apply?'apply':'dry-run',source,before,plan:p.summary};
  if(!apply)return receipt;
  for(const table of requiredCounts)check(Number.isSafeInteger(expectedCounts?.[table])&&expectedCounts[table]>=0&&before.tables[table].count===expectedCounts[table],'apply须显式提供且匹配当前预期计数：'+table);
  check(before.tables.activities.count===0&&before.tables.activity_events.count===0,'跟进记录必须保留；当前工具禁止清理存在跟进记录的商机，请单独核对业务范围');
  check(!backupDirectory||path.isAbsolute(backupDirectory)&&!/^\\\\|^\/\//.test(backupDirectory),'备份目录必须为本地绝对路径');
  const root=backupDirectory||path.join(projectRoot,'runtime','sales-data-reset');
  check(!/(?:^|[\\/])(srv|www|wwwroot|production|server)(?:[\\/]|$)/i.test(root),'备份目录不能位于服务器或生产路径');
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const actualBackupRoot=fs.realpathSync(root);
  check(!/^\\\\|^\/\//.test(actualBackupRoot)&&!/(?:^|[\\/])(srv|www|wwwroot|production|server)(?:[\\/]|$)/i.test(actualBackupRoot),'备份目标必须保持在本地非生产目录');
  const folder=path.join(actualBackupRoot,new Date().toISOString().replaceAll(':','-')+'-'+randomUUID());fs.mkdirSync(folder,{mode:0o700});
  backupFile=path.join(folder,'before.sqlite');receiptFile=path.join(folder,'receipt.json');
  db.prepare('VACUUM INTO ?').run(backupFile);fs.chmodSync(backupFile,0o600);
  const backup=new DatabaseSync(backupFile,{readOnly:true});try{integrity(backup);check(encode(snapshot(backup))===encode(before),'备份与预检快照不一致，源数据可能变化；未执行清理');}finally{backup.close();}
  receipt.backup={file:backupFile,sha256:sha(fs.readFileSync(backupFile))};
  fs.writeFileSync(receiptFile,JSON.stringify({...receipt,status:'backed_up'},null,2),{flag:'wx',mode:0o600});
  db.close();db=new DatabaseSync(source);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');transaction=true;
  check(assertLocalExecution(databasePath)===source,'数据库实际路径发生变化');
  check(encode(snapshot(db))===encode(before),'数据库在备份后发生变化，停止清理；请关闭本地业务服务后重试');
  applyPlan(db,p,path.basename(folder));
  for(const table of removeTables)check(Number(scalar(db,'SELECT COUNT(*) FROM '+q(table)))===0,'业务表未完整清理：'+table);
  check(Number(scalar(db,'SELECT COUNT(*) FROM minutes_records WHERE opportunity_id IS NOT NULL'))===0,'听记商机关联未解除');
  check(encode(protectedState(db,p))===encode(retained),'保留数据哈希不一致，整个清理事务回滚');
  check(sha(encode(schema(db)))===before.schema_sha256,'清理不得修改数据库结构');
  for(const row of sequence)check(Number(scalar(db,'SELECT seq FROM sqlite_sequence WHERE name=?',row.name))>=row.seq,'自增主键序列降低，停止清理：'+row.name);
  integrity(db);const after=snapshot(db);
  db.exec('COMMIT');transaction=false;committed=true;
  receipt={...receipt,status:'complete',after,preserved_sha256:sha(encode(retained)),foreign_key_check:'ok',quick_check:'ok',receipt:receiptFile};
  fs.writeFileSync(receiptFile,JSON.stringify(receipt,null,2),{mode:0o600});
  return receipt;
 }catch(error){
  if(transaction){try{db.exec('ROLLBACK');}catch{}transaction=false;}
  if(receiptFile)try{fs.writeFileSync(receiptFile,JSON.stringify({...receipt,status:committed?'committed_receipt_error':'failed',error:error.message,backup_file:backupFile},null,2),{mode:0o600});}catch{}
  if(committed)throw new Error('清理事务已提交，回执写入失败；请从已验证备份和数据库核对，不可视为已回滚：'+error.message);
  throw error;
 }finally{try{db.close();}catch{}}
}

function argumentsFor(argv){
 const options={apply:false};
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];
  const value=()=>{const next=argv[++i];check(typeof next==='string'&&next.length>0&&!next.startsWith('--'),arg+'缺少参数值');return next;};
  if(arg==='--apply')options.apply=true;
  else if(arg==='--dry-run')options.apply=false;
  else if(arg==='--db')options.databasePath=value();
  else if(arg==='--backup-dir')options.backupDirectory=value();
  else if(arg==='--deployment')options.deployment=value();
  else if(arg==='--expect'){
   options.expectedCounts={};for(const pair of value().split(',')){const [name,count]=pair.split('=');check(requiredCounts.includes(name)&&/^\d+$/.test(count||''),'--expect格式须为customers=N,opportunities=N,contracts=N,payments=N');options.expectedCounts[name]=Number(count);}
  }else throw new Error('未知参数：'+arg);
 }
 return options;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(resetSalesData(argumentsFor(process.argv.slice(2))),null,2));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
