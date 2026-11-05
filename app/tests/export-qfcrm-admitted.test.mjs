import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openDatabase} from '../server/database.mjs';
import {importQfcrm} from '../scripts/import-qfcrm.mjs';
import {exportQfcrmAdmitted} from '../scripts/export-qfcrm-admitted.mjs';

const now='2026-10-29T12:00:00Z';
const hash=data=>createHash('sha256').update(data).digest('hex');
function seed(filename,ownerId=2,developerId=1) {
  const db=openDatabase(filename);
  const add=db.prepare('INSERT INTO users(id,name,username,role,active,created_at,developer_admin,business_member,performance_enabled) VALUES(?,?,?,?,?,?,?,?,?)');
  add.run(developerId,'孙笑天','PRIVATE_DEVELOPER_LOGIN','admin',1,now,1,0,0);
  add.run(ownerId,'米粒','PRIVATE_SALES_LOGIN','sales',1,now,0,1,1);db.close();
}
function inspect(filename,fn){const db=openDatabase(filename);try{return fn(db);}finally{db.close();}}
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qf-admitted-'));
  t.after(()=>{assert.ok(path.basename(root).startsWith('qf-admitted-'));fs.rmSync(root,{recursive:true,force:true});});
  const source=path.join(root,'source'),extraction=path.join(root,'extraction'),database=path.join(root,'reviewed.sqlite'),manifest=path.join(root,'manifest.json'),output=path.join(root,'package');
  fs.mkdirSync(source);fs.mkdirSync(extraction);seed(database);
  const tables={
    '客户-基础表':[{客户:'隔离客户甲'},{客户:'隔离客户甲'},{客户:'隔离客户乙'}],
    'PPL总表':[
      {商机编号:'SJ202610001',客户名称:'隔离客户甲',售卖产品:'软件',合同金额:1000,cash金额:800,产品类型:'新签（自建）',订单类型:'千帆',商机阶段:'商务阶段',销售小二:'暮雪',创建时间:'2026-10-01'},
      {商机编号:'SJ202610002',客户名称:'隔离客户乙',售卖产品:'不得导出的缺项商机',合同金额:333,订单类型:'千帆',商机阶段:'需求阶段',销售小二:'米粒',创建时间:'2026-10-01'},
    ],
    '合同总表':[{合同编号:'HT202610001',客户名称:'隔离客户甲',售卖产品:'软件',合同金额:1000,产品金额:1000,产品类型:'标品',销售小二:'暮雪',合同签订时间:'2026-10-02',合同附件:'HT202610001.pdf'}],
    '项目回款计划':[{项目名称:'一期',客户:'隔离客户甲','合同总表 4':'HT202610001',合同金额:1000,已回款金额:300,未回款金额:700,是否回款:'部分回款',实际回款时间:'2026-10-03',预计回款时间:'2026-11-01'}],
    '重点项目跟进':[{客户:'隔离客户甲',关联编号:'SJ202610001',项目内容:'需求复核',项目时间:'2026-10-04',销售小二:'暮雪'}],
    '产品-基础表':[{产品名称:'不得上传的闲置目录',产品类型:'标品'}],
  };
  const sheets=Object.entries(tables).map(([name,values])=>{const headers=[...new Set(values.flatMap(Object.keys))];return {name,rows:[{row:1,values:headers},...values.map((r,i)=>({row:i+2,values:headers.map(h=>r[h]??null)}))]};});
  fs.writeFileSync(path.join(extraction,'QFCRM.rows.json'),JSON.stringify({file:'QFCRM.xlsx',sha256:'original-workbook-digest',sheets}));
  const relative_path='QFCRM-FILE/合同总表/合同附件/HT202610001.pdf',content=Buffer.from('%PDF reviewed attachment');
  fs.mkdirSync(path.dirname(path.join(source,relative_path)),{recursive:true});fs.writeFileSync(path.join(source,relative_path),content);
  fs.writeFileSync(path.join(source,'excluded-private.txt'),'不得导出的无关原件');
  fs.writeFileSync(manifest,JSON.stringify({files:[{relative_path,size:content.length,sha256:hash(content)},{relative_path:'excluded-private.txt',size:7,sha256:'unused'}]}));
  const opts={database,extraction,source,manifest,now},result=importQfcrm(opts);
  return {root,opts,result,output};
}
function exportFixture(f){return exportQfcrmAdmitted({...f.opts,output:f.output});}
function target(f,name='target',owner=72,developer=91){const database=path.join(f.root,name+'.sqlite');seed(database,owner,developer);return {database,extraction:path.join(f.output,'extraction'),source:path.join(f.output,'source'),manifest:path.join(f.output,'manifest.json'),admitted:path.join(f.output,'admitted-package.json'),now};}
function existingHistoricalCash(f) {
  const filename=path.join(f.opts.extraction,'QFCRM.rows.json'),workbook=JSON.parse(fs.readFileSync(filename,'utf8')),sheet=workbook.sheets.find(s=>s.name==='PPL总表'),row=sheet.rows[1];
  row.values[sheet.rows[0].values.indexOf('cash金额')]=null;
  const values=Object.fromEntries(sheet.rows[0].values.map((h,i)=>[h,row.values[i]??null]));
  inspect(f.opts.database,db=>{
    const guard=db.prepare("SELECT sql FROM sqlite_master WHERE name='opportunities_required_cash_update'").get();db.exec('DROP TRIGGER opportunities_required_cash_update');
    db.prepare('UPDATE opportunities SET product_amount=NULL').run();db.exec(guard.sql);
    const record=db.prepare("SELECT id,payload FROM source_records WHERE source_table='PPL总表'").get(),payload=JSON.parse(record.payload);payload.values=values;
    const fingerprint=hash(JSON.stringify({source:'QFCRM',file:workbook.file,sheet:sheet.name,row:row.row,data:values}));
    db.prepare('UPDATE source_records SET payload=?,fingerprint=? WHERE id=?').run(JSON.stringify(payload),fingerprint,record.id);
  });
  fs.writeFileSync(filename,JSON.stringify(workbook));
}

test('准入包只导成功原行和附件，负责人纯证据保留，账号与排除资料不上传',t=>{
  const f=fixture(t),pack=exportFixture(f);
  assert.equal(pack.admitted_rows.length,7);assert.equal(pack.expected.source_records,8);assert.equal(pack.expected.business.customers,2);
  assert.equal(pack.customer_owner_evidence.length,2);assert.equal(pack.files.filter(f=>f.path.startsWith('source/')).length,1);
  const raw=fs.readFileSync(path.join(f.output,'extraction/QFCRM.rows.json'),'utf8'),meta=JSON.stringify(pack);
  for(const secret of ['不得导出的缺项商机','不得上传的闲置目录','PRIVATE_DEVELOPER_LOGIN','PRIVATE_SALES_LOGIN'])assert.equal((raw+meta).includes(secret),false);
  assert.equal(fs.existsSync(path.join(f.output,'source/excluded-private.txt')),false);
  assert.ok(pack.customer_owner_evidence.find(c=>c.customer_name==='隔离客户乙').evidence.some(r=>r.sheet==='PPL总表'&&r.row===3));
  assert.equal(/"(?:owner_id|entity_id|ding_user_id|union_id|username)"/.test(meta),false);
  assert.throws(()=>exportFixture(f),/输出目录已存在/);
});

test('合格包重映射服务器人员编号，完整恢复本地计数且重复执行不变',t=>{
  const f=fixture(t),pack=exportFixture(f),opts=target(f),first=importQfcrm(opts),second=importQfcrm(opts);
  assert.deepEqual(first.totals,f.result.totals);assert.deepEqual(first.amounts_cents,f.result.amounts_cents);assert.deepEqual(second.created,{});assert.deepEqual(second.totals,first.totals);
  assert.equal(first.admitted_verified.rows,7);assert.deepEqual(first.admitted_verified.business,pack.expected.business);
  inspect(opts.database,db=>{for(const table of ['customers','opportunities','contracts'])assert.deepEqual(db.prepare(`SELECT DISTINCT owner_id FROM ${table}`).all().map(r=>r.owner_id),[72]);assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,2);assert.equal(db.prepare('SELECT business_member FROM users WHERE id=91').get().business_member,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM audit').get().n,1);});
});

test('伪造非唯一销售证据、开发者负责人、停用成员均整批拒绝',t=>{
  const f=fixture(t),pack=exportFixture(f),filename=path.join(f.output,'admitted-package.json');
  const cases=[
    p=>p.customer_owner_evidence[0].evidence.push({sheet:'PPL总表',row:99,customer_name:'隔离客户甲',sales_name:'其他销售'}),
    p=>{p.customer_owner_evidence[0].owner_name='孙笑天';for(const proof of p.customer_owner_evidence[0].evidence)proof.sales_name='孙笑天';},
  ];
  for(const [index,mutate] of cases.entries()){const changed=structuredClone(pack);mutate(changed);fs.writeFileSync(filename,JSON.stringify(changed));const opts=target(f,'invalid-'+index);assert.throws(()=>importQfcrm(opts),/准入包/);inspect(opts.database,db=>assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n,0));}
  fs.writeFileSync(filename,JSON.stringify(pack));const stopped=target(f,'stopped');inspect(stopped.database,db=>db.prepare('UPDATE users SET active=0 WHERE id=72').run());assert.throws(()=>importQfcrm(stopped),/准入包负责人/);
});

test('客户原行与证据逐一对应，原文件哈希与包内文件篡改均失败',t=>{
  const f=fixture(t),pack=exportFixture(f),filename=path.join(f.output,'admitted-package.json');
  const wrong=structuredClone(pack);wrong.customer_owner_evidence[0].source_rows[0].row=99;fs.writeFileSync(filename,JSON.stringify(wrong));assert.throws(()=>importQfcrm(target(f,'row-tamper')),/一一对应/);
  const missing=structuredClone(pack);missing.customer_owner_evidence.pop();fs.writeFileSync(filename,JSON.stringify(missing));assert.throws(()=>importQfcrm(target(f,'missing-proof')),/证据不完整/);
  const wrongSource=structuredClone(pack);wrongSource.source.sha256='forged';fs.writeFileSync(filename,JSON.stringify(wrongSource));assert.throws(()=>importQfcrm(target(f,'source-tamper')),/原文件校验值/);
  fs.writeFileSync(filename,JSON.stringify(pack));fs.appendFileSync(path.join(f.output,'extraction/QFCRM.rows.json'),' ');assert.throws(()=>importQfcrm(target(f,'content-tamper')),/文件校验失败/);
});

test('服务器已有同号但非本次来源业务时停止，不重复新增或覆盖',t=>{
  const f=fixture(t);exportFixture(f);const opts=target(f);importQfcrm(opts);
  inspect(opts.database,db=>{db.prepare('INSERT INTO users(id,name,username,role,active,created_at,business_member) VALUES(?,?,?,?,?,?,?)').run(73,'其他在用销售','other-sales','sales',1,now,1);db.prepare('UPDATE customers SET owner_id=73 WHERE id=(SELECT MIN(id) FROM customers)').run();});
  assert.throws(()=>importQfcrm(opts),/负责人已变化/);
  inspect(opts.database,db=>{assert.equal(db.prepare('SELECT COUNT(*) n FROM customers WHERE owner_id=73').get().n,1);db.prepare('UPDATE customers SET owner_id=72 WHERE owner_id=73').run();});
  const prior=inspect(opts.database,db=>{db.exec('DELETE FROM source_records');return {amount:db.prepare('SELECT SUM(amount) n FROM contracts').get().n,audit:db.prepare('SELECT COUNT(*) n FROM audit').get().n};});
  assert.throws(()=>importQfcrm(opts),/冲突.*整批回滚/);
  inspect(opts.database,db=>{assert.equal(db.prepare('SELECT COUNT(*) n FROM source_records').get().n,0);assert.equal(db.prepare('SELECT SUM(amount) n FROM contracts').get().n,prior.amount);assert.equal(db.prepare('SELECT COUNT(*) n FROM audit').get().n,prior.audit);assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n,2);});
});

test('附件内容与来源路径错误不生成发布包',t=>{
  const f=fixture(t),relative='QFCRM-FILE/合同总表/合同附件/HT202610001.pdf';fs.writeFileSync(path.join(f.opts.source,relative),'tampered');assert.throws(()=>exportFixture(f),/附件校验和/);assert.equal(fs.existsSync(f.output),false);
  const g=fixture(t);inspect(g.opts.database,db=>db.prepare("UPDATE attachments SET source_path='../escaped.pdf'").run());assert.throws(()=>exportFixture(g),/附件缺已准入合同/);assert.equal(fs.existsSync(g.output),false);
  if(process.platform==='linux'){
    const h=fixture(t),original=path.join(h.opts.source,relative),outside=path.join(h.root,'outside.pdf');fs.copyFileSync(original,outside);fs.unlinkSync(original);fs.symlinkSync(outside,original);assert.throws(()=>exportFixture(h),/超出来源目录/);assert.equal(fs.existsSync(h.output),false);
  }
});

test('明确历史包保留既有cash空值，事务后新增约束仍有效且普通导入无例外',t=>{
  const f=fixture(t);existingHistoricalCash(f);const pack=exportFixture(f),opts=target(f);
  assert.equal(pack.format,'qfcrm-admitted-historical-v1');assert.equal(pack.grandfathered_missing_fields.length,1);assert.equal(pack.grandfathered_missing_fields[0].field,'product_amount');
  const originalGuard=inspect(opts.database,db=>db.prepare("SELECT sql FROM sqlite_master WHERE name='opportunities_required_cash_insert'").get().sql);
  const first=importQfcrm(opts),second=importQfcrm(opts);assert.deepEqual(first.totals,f.result.totals);assert.deepEqual(second.created,{});assert.equal(first.admitted_verified.grandfathered_missing_cash,1);
  inspect(opts.database,db=>{
    assert.equal(db.prepare('SELECT product_amount FROM opportunities').get().product_amount,null);
    assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='opportunities_required_cash_insert'").get().sql,originalGuard);
    const {id,...data}=db.prepare('SELECT * FROM opportunities').get();data.reference='SJ-new-without-cash';
    assert.throws(()=>db.prepare(`INSERT INTO opportunities(${Object.keys(data).join(',')}) VALUES(${Object.keys(data).map(()=>'?').join(',')})`).run(...Object.values(data)),/cash amount is required/);
  });
  const fullDatabase=path.join(f.root,'ordinary-full.sqlite');seed(fullDatabase);
  const full=importQfcrm({...f.opts,database:fullDatabase});assert.equal(full.totals.opportunities,0);assert.equal(full.totals.activities,0);assert.ok(full.excluded.some(r=>/cash金额/.test(r.reason)));
});

test('历史缺项白名单遗漏、改字段、伪指纹或扩大到非缺项行均拒绝，失败不遗留约束豁免',t=>{
  const f=fixture(t);existingHistoricalCash(f);const pack=exportFixture(f),filename=path.join(f.output,'admitted-package.json');
  const mutations=[p=>{p.grandfathered_missing_fields=[];},p=>{p.grandfathered_missing_fields[0].field='amount';},p=>{p.grandfathered_missing_fields[0].fingerprint='forged';},p=>{p.grandfathered_missing_fields.push({...p.admitted_rows.find(r=>r.entity==='customer'),field:'product_amount'});},p=>{p.format='qfcrm-admitted-v1';}];
  for(const [index,mutate] of mutations.entries()){
    const changed=structuredClone(pack);mutate(changed);fs.writeFileSync(filename,JSON.stringify(changed));const opts=target(f,'bad-exception-'+index);
    assert.throws(()=>importQfcrm(opts),/白名单/);inspect(opts.database,db=>{assert.equal(db.prepare('SELECT COUNT(*) n FROM opportunities').get().n,0);assert.ok(db.prepare("SELECT sql FROM sqlite_master WHERE name='opportunities_required_cash_insert'").get());});
  }
  const changed=structuredClone(pack);changed.expected.amounts_cents.contracts++;
  fs.writeFileSync(filename,JSON.stringify(changed));const opts=target(f,'fail-after-history-write');
  assert.throws(()=>importQfcrm(opts),/金额与验收值不一致/);inspect(opts.database,db=>{assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM opportunities').get().n,0);assert.ok(db.prepare("SELECT sql FROM sqlite_master WHERE name='opportunities_required_cash_insert'").get());});
});
