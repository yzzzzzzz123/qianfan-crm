import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {openDatabase} from '../server/database.mjs';
import {importQfcrmThreeTables} from '../scripts/import-qfcrm-three-tables.mjs';
import {qfcrmSourceFields,contractSourceFields,importedCollections} from '../server/qfcrm-source-fields.mjs';
import {buildState} from '../server/modules/reporting-prd.mjs';

const runtime=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../runtime');
function setup(t){
 fs.mkdirSync(runtime,{recursive:true});
 const folder=fs.mkdtempSync(path.join(runtime,'qfcrm-three-table-test-')),database=path.join(folder,'isolated.sqlite');
 t.after(()=>{assert.equal(path.dirname(fs.realpathSync(folder)),fs.realpathSync(runtime));fs.rmSync(folder,{recursive:true});});
 const db=openDatabase(database),at='2026-09-20T00:00:00+08:00';
 db.prepare('INSERT INTO users(id,name,username,role,active,created_at,ding_user_id,business_member,developer_admin) VALUES(?,?,?,?,?,?,?,?,?)').run(1,'隔离管理员','isolated-admin','admin',1,at,'admin',1,0);
 db.prepare('INSERT INTO users(id,name,username,role,active,created_at,ding_user_id,business_member,developer_admin) VALUES(?,?,?,?,?,?,?,?,?)').run(2,'隔离销售','isolated-sales','sales',1,at,'sales',1,0);
 db.prepare('INSERT INTO users(id,name,username,role,active,created_at,ding_user_id,business_member,developer_admin) VALUES(?,?,?,?,?,?,?,?,?)').run(3,'隔离开发者','isolated-developer','admin',1,at,'dev',0,1);
 db.exec('UPDATE users SET performance_enabled=0 WHERE developer_admin=1');
 db.prepare("INSERT INTO customers(name,normalized,owner_id,note,created_at,updated_at) VALUES('核对客户','核对客户',2,'原档案不覆盖',?,?)").run(at,at);
 db.prepare("INSERT INTO opportunities(name,customer_id,owner_id,stage,amount,product_amount,sale_type,order_type,created_at,updated_at,stage_at,reference) VALUES('应归档旧商机',1,2,'线索',10000,10000,'新签自建','代销',?,?,?,'SJ202609001')").run(at,at,at);
 db.prepare("INSERT INTO activities(opportunity_id,user_id,source,activity_type,summary,activity_date,created_at) VALUES(1,2,'历史资料导入','手动跟进','必须保留的原始跟进','2026-09-20',?)").run(at);
 const row=(id,values,links={})=>({record_id:id,created_at:values['创建时间']||'2026-10-02T12:00:00+08:00',values,links,raw:{recordId:id}});
 const source={format:'qfcrm-three-table-v1',base_id:'EpGBa2Lm8amK9zQLhZrdY5aG8gN7R35y',cutoff:'2026-10-01T00:00:00+08:00',archive:{path:path.join(folder,'original.zip'),sha256:createHash('sha256').update('isolated').digest('hex')},tables:[
  {name:'PPL总表',records:[row('op-1',{'商机编号':'SJ202610001','客户名称':['核对客户'],'售卖产品':'产品甲','合同金额':'100','cash金额':null,'商机阶段':'需求阶段','销售小二':[{id:'sales',name:'隔离销售'}]}),row('op-2',{'商机编号':'SJ202610002','客户名称':['核对客户'],'售卖产品':'产品乙','合同金额':'200','cash金额':'150','商机阶段':'线索阶段','销售小二':[{id:'unmapped',name:'原销售姓名'}]}),row('blank',{'商机编号':'SJ202610003','合同金额':'0','销售小二':[{id:'dev',name:'隔离开发者'}]})]},
  {name:'合同总表',records:[row('contract-1',{'合同编号':'HT202610001','客户名称':['核对客户'],'售卖产品':['产品甲'],'产品类型':['标品','交付'],'合同金额':'100','产品金额':'60','项目/服务金额':'40','产品毛利':null,'项目/服务毛利':'10','总毛利':'10','产品毛利率':'.2','产品续签标签':'续签一','订单类型':'代销','销售小二':[{id:'sales',name:'隔离销售'}],'回款状态':'部分回款','回款时间':'2026-10-03'})]},
  {name:'项目回款计划',records:[row('collection-1',{'项目名称':'第一阶段','客户':['核对客户'],'产品':['产品甲'],'合同金额':'50','已回款金额':'30','未回款金额':'20','实际回款时间':'2026-10-03','预计回款时间':'2026-10-10','项目状态':'交付中','产品毛利':null,'服务毛利':'5','总毛利':'5','销售经理':[{name:'隔离销售'}],'项目经理':[{name:'原项目经理'}],'研发\\交付人员':[{name:'原交付人员'}],'创建时间':'2026-10-03T12:00:00+08:00'},{'合同总表 4':['contract-1']}),row('collection-2',{'项目名称':'第二阶段','客户':['核对客户'],'产品':['产品甲'],'合同金额':'50','未回款金额':'50','是否回款':'否','预计回款时间':'2026-11-10','项目状态':'交付中','产品毛利':null,'服务毛利':'5','总毛利':'5','销售经理':[{name:'隔离销售'}],'创建时间':'2026-10-04T12:00:00+08:00'},{'合同总表 4':['contract-1']}),row('unlinked',{'项目名称':'未关联合同','客户':['核对客户'],'合同金额':'1','未回款金额':'1'})]},
 ]};
 fs.writeFileSync(source.archive.path,'isolated');
 const snapshotPath=path.join(folder,'snapshot.json'),attachmentsPath=path.join(folder,'attachments.json');
 fs.writeFileSync(snapshotPath,JSON.stringify(source));fs.writeFileSync(attachmentsPath,JSON.stringify({archive_sha256:source.archive.sha256,files:[]}));
 const before={customer:db.prepare('SELECT * FROM customers').get(),activity:db.prepare('SELECT * FROM activities').get(),users:db.prepare('SELECT * FROM users ORDER BY id').all()};db.close();
 return {folder,database,snapshotPath,attachmentsPath,source,before,options:{database,snapshotPath,attachmentsPath,apply:true,deployment:'local'}};
}

test('三表导入按来源ID保留一客多商机、原客户和跟进，缺项留空，未知销售不创建账号，重复导入幂等',t=>{
 const f=setup(t),sourceBytes=fs.readFileSync(f.snapshotPath),result=importQfcrmThreeTables(f.options);
 assert.deepEqual(result.imported,{'PPL总表':2,'合同总表':1,'项目回款计划':2});assert.equal(result.pending.length,2);
 let db=openDatabase(f.database);
 try{
  assert.deepEqual(db.prepare('SELECT * FROM customers WHERE id=1').get(),f.before.customer);
  assert.deepEqual(db.prepare('SELECT * FROM activities WHERE id=1').get(),f.before.activity);
  assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all(),f.before.users);
  assert.ok(db.prepare('SELECT archived_at FROM opportunities WHERE id=1').get().archived_at);
  const active=db.prepare('SELECT * FROM opportunities WHERE archived_at IS NULL ORDER BY id').all();assert.equal(active.length,2);assert.equal(active[0].product_amount,null);assert.equal(active[1].owner_id,null);
  assert.equal(db.prepare('SELECT count(*) n FROM payments').get().n,3);
  assert.equal(db.prepare("SELECT sum(amount) n FROM payments WHERE status='已到账'").get().n,3000);
  assert.throws(()=>db.prepare("INSERT INTO opportunities(name,customer_id,owner_id,stage,amount,product_amount,sale_type,order_type,created_at,updated_at,stage_at) VALUES('不能绕过日常归属',1,NULL,'线索',100,100,'新签自建','代销','2026-10-01','2026-10-01','2026-10-01')").run(),/owner is required/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  const state=buildState({db,getRules:()=>JSON.parse(db.prepare("SELECT value FROM settings WHERE key='rules'").get().value),demo:false,month:'2026-10'},{id:1,role:'admin'});
  assert.equal(state.opportunities.length,2);assert.equal(state.opportunities.find(o=>o.owner_id===null).owner_label,'原销售姓名');assert.equal(state.collections.length,1);assert.equal(state.collections[0].collection_source_count,2);
  assert.equal(state.collections[0].collected,3000);assert.equal(state.collections[0].outstanding,7000);assert.equal(state.collections[0].collection_created_at,'2026-10-03T12:00:00+08:00');
  assert.deepEqual(state.collections[0].collection_manager_names,['原项目经理']);
 }finally{db.close();}
 assert.equal(importQfcrmThreeTables(f.options).status,'already-imported');assert.deepEqual(fs.readFileSync(f.snapshotPath),sourceBytes);
});

test('来源毛利的NULL和零分别保留，PM不获得毛利，手工维护后的明细不被旧来源覆盖',t=>{
 const f=setup(t);importQfcrmThreeTables(f.options);const db=openDatabase(f.database);
 try{
  const c=db.prepare('SELECT * FROM contracts').get(),items=db.prepare('SELECT * FROM contract_items').all(),payments=db.prepare('SELECT * FROM payments').all(),sources=qfcrmSourceFields(db),facts=sources.contracts.get(c.id);
  const projected=contractSourceFields(c,items,payments,facts);assert.equal(projected.product_margin,null);assert.equal(projected.service_margin,1000);
  const pm=contractSourceFields(c,items,payments,facts,{hideMargin:true});for(const key of ['product_margin','service_margin','total_margin','product_margin_rate'])assert.equal(pm[key],null);
  const collections=importedCollections([{...c,payments,lifecycle:'历史登记',collected:3000,outstanding:7000}],sources.collections,{hideMargin:true});assert.equal(collections[0].service_margin,null);
  db.prepare('UPDATE contract_items SET margin=1 WHERE id=?').run(items[0].id);
  assert.equal(Object.hasOwn(contractSourceFields(c,db.prepare('SELECT * FROM contract_items').all(),payments,facts),'product_margin'),false);
 }finally{db.close();}
});

test('导入发生异常时业务替换、原归档标记和暂时豁免的约束一起回滚',t=>{
 const f=setup(t);let db=openDatabase(f.database);db.exec("CREATE TRIGGER isolated_failure BEFORE INSERT ON source_records WHEN NEW.source='QFCRM' BEGIN SELECT RAISE(ABORT,'isolated failure'); END;");db.close();
 assert.throws(()=>importQfcrmThreeTables(f.options),/isolated failure/);db=openDatabase(f.database);
 try{assert.equal(db.prepare('SELECT count(*) n FROM opportunities').get().n,1);assert.equal(db.prepare('SELECT archived_at FROM opportunities').get().archived_at,null);assert.equal(db.prepare('SELECT count(*) n FROM contracts').get().n,0);assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='opportunities_required_cash_insert'").get());assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='contracts_required_owner_insert'").get());assert.deepEqual(db.prepare('SELECT * FROM activities').get(),f.before.activity);}
 finally{db.close();}
});

test('来源创建日期、输入指纹或部署边界不符合时拒绝写入',t=>{
 const f=setup(t);
 assert.throws(()=>importQfcrmThreeTables({...f.options,deployment:'server'}),/仅允许本地/);
 assert.throws(()=>importQfcrmThreeTables({...f.options,expectedSnapshotHash:'bad'}),/指纹/);
 f.source.tables[0].records[0].created_at='2026-09-30T23:59:59+08:00';fs.writeFileSync(f.snapshotPath,JSON.stringify(f.source));
 assert.throws(()=>importQfcrmThreeTables(f.options),/范围外/);
});

test('超额的多阶段计划保留原字段而不重复记账，明确到账仍按实际金额入库',t=>{
 const f=setup(t),r=f.source.tables[2].records[1];r.values['未回款金额']='120';fs.writeFileSync(f.snapshotPath,JSON.stringify(f.source));
 const report=importQfcrmThreeTables(f.options),db=openDatabase(f.database);
 try{assert.equal(report.imported['项目回款计划'],2);assert.equal(db.prepare('SELECT count(*) n FROM payments').get().n,1);assert.equal(db.prepare('SELECT amount,status FROM payments').get().amount,3000);assert.equal(db.prepare('SELECT amount,status FROM payments').get().status,'已到账');assert.ok(report.field_issues.some(r=>r.issues.some(s=>s.includes('超额'))));}
 finally{db.close();}
});

test('只读补取的附件须与原表resourceId对应，原件哈希校验失败时整批回滚',t=>{
 const f=setup(t),bytes=Buffer.from('%PDF-isolated-original'),filename=path.join(f.folder,'original.pdf'),sha=createHash('sha256').update(bytes).digest('hex');fs.writeFileSync(filename,bytes);
 f.source.tables[1].records[0].values['合同附件']=[{filename:'合同.pdf',resourceId:'original-resource'}];fs.writeFileSync(f.snapshotPath,JSON.stringify(f.source));
 const attachment={origin:'dingtalk_readonly_attachment',source_path:'QFCRM-AITABLE/合同总表/合同附件/HT202610001/合同.pdf',resource_id:'original-resource',contract_no:'HT202610001',path:filename,filename:'合同.pdf',mime_type:'application/pdf',size:bytes.length,sha256:sha};
 fs.writeFileSync(f.attachmentsPath,JSON.stringify({archive_sha256:f.source.archive.sha256,files:[{...attachment,sha256:'invalid'}]}));
 assert.throws(()=>importQfcrmThreeTables(f.options),/附件内容指纹/);
 let db=openDatabase(f.database);assert.equal(db.prepare('SELECT count(*) n FROM contracts').get().n,0);db.close();
 fs.writeFileSync(f.attachmentsPath,JSON.stringify({archive_sha256:f.source.archive.sha256,files:[attachment]}));importQfcrmThreeTables(f.options);db=openDatabase(f.database);
 try{assert.deepEqual(Buffer.from(db.prepare('SELECT content FROM attachments').get().content),bytes);assert.equal(JSON.parse(db.prepare("SELECT payload FROM source_records WHERE entity='attachment'").get().payload).origin,'dingtalk_readonly_attachment');}
 finally{db.close();}
});
