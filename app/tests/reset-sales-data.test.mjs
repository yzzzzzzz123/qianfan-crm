import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {openDatabase,all,one,run} from '../server/database.mjs';
import {seedDemo} from '../server/seed.mjs';
import {resetSalesData,assertLocalExecution} from '../scripts/reset-sales-data.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
function setup(t,{followups=true}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qianfan-sales-reset-')),filename=path.join(root,'fixture.sqlite'),db=openDatabase(filename);seedDemo(db);
 t.after(()=>{assert.equal(path.dirname(fs.realpathSync(root)),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(root).startsWith('qianfan-sales-reset-'));fs.rmSync(root,{recursive:true,force:true});});
 const insert=(table,row)=>{const keys=Object.keys(row);return Number(run(db,`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`,...Object.values(row)).lastInsertRowid);};
 const at='2026-11-02T01:00:00Z',contract=one(db,'SELECT * FROM contracts ORDER BY id LIMIT 1'),opportunity=one(db,'SELECT * FROM opportunities ORDER BY id LIMIT 1');
 const artifact=Buffer.from('仅供隔离测试的原始附件');
 const attach=(entity,entity_id)=>insert('attachments',{entity,entity_id,filename:entity+'.txt',mime_type:'text/plain',size:artifact.length,sha256:hash(artifact),content:artifact,created_at:at});
 const attachment=attach('contract',contract.id),customerAttachment=attach('customer',1);
 insert('contract_attachment_analyses',{contract_id:contract.id,attachment_id:attachment,attachment_sha256:hash(artifact),fingerprint:'fixture',filename:'contract.txt',model:'fake-model',state:'ready',result:'{"total_amount":123,"payment_stages":[]}',generated_at:at,generated_by:1});
 insert('customer_profiles',{customer_id:1,state:'ready',provider:'fake',source_url:'',details:'客户原始资料',reason:'',checked_at:at,identity_fingerprint:'fixture'});
 run(db,"INSERT INTO sessions(token,user_id,csrf,expires,auth_method) VALUES('isolated-session',1,'isolated-csrf',9999999999999,'dingtalk')");
 insert('ding_identities',{user_id:1,union_id:'isolated-union'});
 run(db,"INSERT OR IGNORE INTO customer_collaborators VALUES(1,2)");
 insert('performance_reviews',{user_id:2,month:'2026-10',status:'confirmed',snapshot:'{"retain":"手工绩效快照"}',reviewed_by:1,updated_at:at});
 insert('daily_reports',{day:'2026-10-30',snapshot:'{"retain":"历史日报"}',created_at:at});
 const commission=insert('commission_batches',{sales_id:2,kind:'personal',period:'2026Q4',base:10000,rate:.03,amount:300,status:'confirmed',snapshot:'{"old":"snapshot"}',created_at:at,confirmed_by:1});
 const item=one(db,'SELECT id FROM contract_items WHERE contract_id=? LIMIT 1',contract.id);
 insert('commission_lines',{batch_id:commission,contract_id:contract.id,item_id:item.id,base:10000,rebate_rate:.5,rate:.03,amount:300});
 run(db,"INSERT INTO minutes_sources(id,member_id,corp_id,user_id,account_name,corp_name,credential_key,connection_state,collect_from,created_at) VALUES('fixture-source',1,'isolated-corp','isolated-user','本人','组织','isolated-key','connected',?,?)",at,at);
 const minute=insert('minutes_records',{source_id:'fixture-source',external_id:'isolated-note',title:'保留听记',start_time:at,duration_ms:1000,media_state:'unavailable',customer_id:opportunity.customer_id,opportunity_id:opportunity.id,synced_at:at});
 insert('minutes_artifacts',{record_id:minute,kind:'transcript',state:'ready',content:'原始逐字稿不得删除',checked_at:at});
 run(db,'UPDATE activities SET minutes_record_id=? WHERE id=(SELECT MIN(id) FROM activities)',minute);
 const source=(entity,entity_id,payload,fp)=>insert('source_records',{source:'fixture',entity,entity_id,payload:JSON.stringify(payload),source_file:'isolated.json',imported_at:at,fingerprint:fp,reason:'原备注'});
 const contractSource=source('contract',contract.id,{raw:'合同原字段'},'contract-original'),customerSource=source('customer',1,{raw:'客户原字段'},'customer-original');
 const batch=(state,operations,result,source_hash)=>insert('ai_import_batches',{user_id:1,source_hash,state,summary:'隔离批次',questions:'[]',operations:JSON.stringify(operations),errors:'[]',model:'fake',usage:'{}',base_revision:0,created_at:at,confirmed_at:state==='confirmed'?at:null,result:result?JSON.stringify(result):null,source_role:'admin'});
 const confirmed=batch('confirmed',[{type:'contract',action:'create',data:{customer_id:1}}],[{type:'contract',id:contract.id}],'old-contract-source');
 const draft=batch('draft',[{type:'contract',action:'update',target_id:contract.id,data:{name:'待确认变更'}}],null,'old-draft-source');
 const customerBatch=batch('confirmed',[{type:'customer',action:'create',data:{name:'客户'}}],[{type:'customer',id:1}],'retained-customer-source');
 const newDraft=batch('draft',[{type:'contract',action:'create',data:{customer_id:1,name:'尚未提交的新合同'}}],null,'retained-new-contract-source');
 insert('ai_uploads',{batch_id:confirmed,filename:'原件.txt',sha256:hash(artifact),content:artifact});
 const mutate=(route,key,response)=>insert('mutations',{key:'1:1:POST:/api/'+route+':'+key,hash:'same-request-body',response:JSON.stringify(response),created_at:at});
 mutate('contracts','old-contract',{id:contract.id});mutate('customers','keep-customer',{id:1});
 mutate('ai/batches/'+confirmed+'/confirm','old-confirm',{id:confirmed,result:[{type:'contract',id:contract.id}]});
 mutate('ai/intake','old-intake',{id:confirmed});mutate('ai/intake','keep-intake',{id:customerBatch});
 mutate('contracts/999999','unrelated-contract',{id:999999});
 if(!followups)db.exec('DELETE FROM activity_events; DELETE FROM activities');
 const counts=Object.fromEntries(['customers','opportunities','contracts','payments'].map(table=>[table,one(db,'SELECT COUNT(*) n FROM '+table).n]));
 db.close();
 return {root,filename,counts,contract,opportunity,attachment,customerAttachment,minute,contractSource,customerSource,confirmed,draft,customerBatch,newDraft};
}
function data(filename){const db=new DatabaseSync(filename,{readOnly:true});try{return Object.fromEntries(all(db,"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(({name})=>[name,all(db,'SELECT * FROM "'+name+'"')]));}finally{db.close();}}
function apply(f){return resetSalesData({databasePath:f.filename,apply:true,expectedCounts:f.counts,backupDirectory:path.join(f.root,'backups')});}

test('存在跟进记录时拒绝连带清理商机，所有记录和备份目录保持原状',t=>{
 const f=setup(t),before=data(f.filename),files=fs.readdirSync(f.root).sort();
 assert.ok(before.activities.length>0);
 assert.throws(()=>apply(f),/跟进记录必须保留/);
 assert.deepEqual(data(f.filename),before);
 assert.deepEqual(fs.readdirSync(f.root).sort(),files);
});

test('本地销售清理默认只读预览，不初始化库、不写备份、不改变任何行',t=>{
 const f=setup(t),before=data(f.filename),files=fs.readdirSync(f.root).sort();
 const preview=resetSalesData({databasePath:f.filename});
 assert.equal(preview.mode,'dry-run');assert.equal(preview.plan.delete.contracts,f.counts.contracts);assert.equal(preview.plan.unlink_minutes,1);assert.equal(preview.plan.retire_ai_batches,2);assert.equal(preview.plan.tombstone_mutations,3);
 assert.deepEqual(data(f.filename),before);assert.deepEqual(fs.readdirSync(f.root).sort(),files);
});

test('清理完整备份并仅删除授权业务，客户身份听记原件证据保留且历史ID不复用',t=>{
 const f=setup(t,{followups:false}),before=data(f.filename),receipt=apply(f),after=data(f.filename);
 assert.equal(receipt.status,'complete');assert.equal(receipt.quick_check,'ok');assert.equal(receipt.foreign_key_check,'ok');
 assert.deepEqual(data(receipt.backup.file),before);assert.equal(hash(fs.readFileSync(receipt.backup.file)),receipt.backup.sha256);
 for(const table of Object.keys(receipt.plan.delete))assert.equal(after[table].length,0,table);
 for(const table of ['customers','contacts','customer_collaborators','customer_profiles','users','sessions','ding_identities','settings','minutes_sources','minutes_artifacts','minutes_authorizations','minutes_sync_runs','performance_reviews','targets','daily_reports','ai_uploads'])assert.deepEqual(after[table],before[table],table);
 const minute=after.minutes_records.find(row=>row.id===f.minute),oldMinute=before.minutes_records.find(row=>row.id===f.minute);
 assert.deepEqual({...minute,opportunity_id:oldMinute.opportunity_id,revision:oldMinute.revision},{...oldMinute});assert.equal(minute.opportunity_id,null);assert.equal(minute.revision,oldMinute.revision+1);
 assert.deepEqual(after.attachments,before.attachments.filter(row=>row.id===f.customerAttachment));
 const oldSource=before.source_records.find(row=>row.id===f.contractSource),newSource=after.source_records.find(row=>row.id===f.contractSource);
 assert.equal(newSource.status,'archived');assert.match(newSource.reason,/本地销售数据已清理/);assert.deepEqual({...newSource,status:oldSource.status,reason:oldSource.reason},{...oldSource});
 assert.deepEqual(after.source_records.find(row=>row.id===f.customerSource),before.source_records.find(row=>row.id===f.customerSource));
 for(const id of [f.confirmed,f.draft]){
  const old=before.ai_import_batches.find(row=>row.id===id),changed=after.ai_import_batches.find(row=>row.id===id);
  assert.equal(changed.state,'cancelled');assert.match(changed.summary,/本地销售数据已清理/);assert.equal(changed.result,old.result);assert.equal(changed.operations,old.operations);assert.equal(changed.confirmed_at,old.confirmed_at);assert.notEqual(changed.source_hash,old.source_hash);
 }
 for(const id of [f.customerBatch,f.newDraft])assert.deepEqual(after.ai_import_batches.find(row=>row.id===id),before.ai_import_batches.find(row=>row.id===id));
 for(const row of after.mutations){const old=before.mutations.find(value=>value.key===row.key);if(/:old-/.test(row.key)){assert.equal(JSON.parse(row.response).reset,true);assert.equal(JSON.parse(row.response).id,undefined);assert.equal(row.hash,old.hash);}else assert.deepEqual(row,old);}
 assert.deepEqual(after.audit.slice(0,before.audit.length),before.audit);assert.equal(after.audit.at(-1).action,'本地清理商机合同回款');
 const db=new DatabaseSync(f.filename);try{
  const old=f.opportunity,keys=Object.keys(old).filter(key=>key!=='id');
  const inserted=db.prepare('INSERT INTO opportunities('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...keys.map(key=>old[key]));
  assert.ok(Number(inserted.lastInsertRowid)>Math.max(...before.opportunities.map(row=>row.id)));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});

test('apply预期计数不一致和新增未知外键均拒绝，失败前不创建备份',t=>{
 const f=setup(t),before=data(f.filename);
 assert.throws(()=>resetSalesData({databasePath:f.filename,apply:true}),/预期计数/);
 assert.throws(()=>resetSalesData({databasePath:f.filename,apply:true,expectedCounts:{...f.counts,contracts:f.counts.contracts+1}}),/预期计数/);
 assert.deepEqual(data(f.filename),before);
 const db=new DatabaseSync(f.filename);db.exec('CREATE TABLE future_dependency(id INTEGER PRIMARY KEY,opportunity_id INTEGER REFERENCES opportunities(id))');db.close();
 assert.throws(()=>apply(f),/未纳入范围的业务外键/);assert.equal(fs.existsSync(path.join(f.root,'backups')),false);
});

test('删除中途失败完整回滚全部表，已验证备份可读取且回执明确失败',t=>{
 const f=setup(t,{followups:false}),db=new DatabaseSync(f.filename);db.exec("CREATE TRIGGER fail_reset BEFORE DELETE ON contracts BEGIN SELECT RAISE(ABORT,'isolated reset failure'); END");db.close();
 const before=data(f.filename);assert.throws(()=>apply(f),/isolated reset failure/);assert.deepEqual(data(f.filename),before);
 const folder=path.join(f.root,'backups',fs.readdirSync(path.join(f.root,'backups'))[0]);
 assert.deepEqual(data(path.join(folder,'before.sqlite')),before);assert.equal(JSON.parse(fs.readFileSync(path.join(folder,'receipt.json'),'utf8')).status,'failed');
});

test('意外触发器改动保留客户字段时哈希检查拒绝提交并回滚全部业务',t=>{
 const f=setup(t,{followups:false}),db=new DatabaseSync(f.filename);db.exec("CREATE TRIGGER unexpected_reset_effect AFTER DELETE ON opportunities BEGIN UPDATE customers SET note='必须回滚此变动' WHERE id=1; END");db.close();
 const before=data(f.filename);assert.throws(()=>apply(f),/保留数据哈希不一致/);assert.deepEqual(data(f.filename),before);
});

test('CLI拒绝缺省数据库、相对路径、网络目标和服务器环境',t=>{
 const f=setup(t),script=path.resolve('scripts/reset-sales-data.mjs');
 assert.throws(()=>resetSalesData({databasePath:f.filename,deployment:'server'}),/仅支持local部署/);
 assert.throws(()=>assertLocalExecution(undefined),/绝对路径/);assert.throws(()=>assertLocalExecution('data/crm.sqlite'),/绝对路径/);assert.throws(()=>assertLocalExecution('https://server/db.sqlite'),/绝对路径/);
 for(const env of [{NODE_ENV:'production'},{CRM_RUNTIME_ENVIRONMENT:'server'}]){
  const result=spawnSync(process.execPath,[script,'--db',f.filename],{encoding:'utf8',env:{...process.env,...env}});
  assert.notEqual(result.status,0);assert.match(result.stderr,/拒绝在生产或服务器环境/);
 }
 const result=spawnSync(process.execPath,[script],{encoding:'utf8'});assert.notEqual(result.status,0);assert.match(result.stderr,/绝对路径/);
 const incomplete=spawnSync(process.execPath,[script,'--db',f.filename,'--deployment'],{encoding:'utf8'});assert.notEqual(incomplete.status,0);assert.match(incomplete.stderr,/缺少参数值/);
});

test('CLI使用显式本地路径先预览，再凭完整预期计数执行并返回已验证备份回执',t=>{
 const f=setup(t,{followups:false}),script=path.resolve('scripts/reset-sales-data.mjs');
 const preview=spawnSync(process.execPath,[script,'--db',f.filename],{encoding:'utf8'});
 assert.equal(preview.status,0,preview.stderr);assert.equal(JSON.parse(preview.stdout).mode,'dry-run');
 const result=spawnSync(process.execPath,[script,'--db',f.filename,'--deployment','local','--apply','--expect',Object.entries(f.counts).map(([key,count])=>key+'='+count).join(','),'--backup-dir',path.join(f.root,'cli-backups')],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);const receipt=JSON.parse(result.stdout);assert.equal(receipt.status,'complete');
 assert.equal(receipt.after.tables.customers.count,f.counts.customers);assert.equal(receipt.after.tables.contracts.count,0);assert.ok(fs.existsSync(receipt.backup.file));assert.ok(fs.existsSync(receipt.receipt));
});
