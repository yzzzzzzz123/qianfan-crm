import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {openDatabase} from '../server/database.mjs';
import {importQfcrm,parseSourceMoney} from '../scripts/import-qfcrm.mjs';

const now='2026-10-29T07:00:00.000Z';
const hash=s=>createHash('sha256').update(s).digest('hex');
function input(t,overrides={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'qf-real-import-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),extraction=path.join(root,'extraction'),database=path.join(root,'isolated.sqlite'),manifest=path.join(root,'manifest.json');
  fs.mkdirSync(source);fs.mkdirSync(extraction);
  const tables={
    '客户-基础表':[{客户:'隔离甲企业',联系人姓名:'联系人甲',联系方式:'邮件联系',联系电话:'测试电话',创建人:'孙笑天'},{客户:'隔离甲企业',联系人姓名:'联系人甲',联系方式:'邮件联系',联系电话:'测试电话',创建人:'孙笑天'}],
    'PPL总表':[{商机编号:'SJ202601001',客户名称:'隔离甲企业',售卖产品:'隔离业务',商机阶段:'商务阶段',合同金额:'¥10,000.25',cash金额:'¥6,000.00',产品类型:'新签（自建）',订单类型:'千帆',销售小二:'历史销售甲',创建时间:'2025-12-01 09:00:00',最后更新时间:'2026-10-01 09:00:00'}, {商机编号:'SJ202501001',客户名称:'隔离甲企业',售卖产品:'旧业务',商机阶段:'赢单',合同金额:'1000',销售小二:'历史销售甲',创建时间:'2025-01-01',最后更新时间:'2025-12-01'}],
    '合同总表':[{合同编号:'HT202601001',客户名称:'隔离甲企业',售卖产品:'软件与开发',产品类型:'标品,定开',合同金额:'10000.25',产品金额:'6000.00','项目/服务金额':'4000.25',合同签订时间:'2026-01-01',销售小二:'历史销售甲',合同附件:'signed.pdf'}, {合同编号:'HT202601002',客户名称:'隔离甲企业',售卖产品:'待完善',合同金额:'500',合同签订时间:null,销售小二:'历史销售甲'}],
    '项目回款计划':[{项目名称:'一期',客户:'隔离甲企业','合同总表 4':'HT202601001',合同金额:'10000.25',已回款金额:'1500',未回款金额:'8500.25',是否回款:'部分回款',实际回款时间:'2026-01-08',预计回款时间:'2026-11-01'}],
    '重点项目跟进':[{序号:1,客户:'隔离甲企业',关联编号:'SJ202601001',项目内容:'核对项目需求',项目推进思路:'客户补充范围',项目时间:'2026-10-01',销售小二:'历史销售甲'}],
    '绩效管理':[{效能日期:'2026-10-01',销售:'历史销售甲',当日效能得分:50}],
    '付款计划':[{项目名称:'对外支付',应付款金额:300}],
    '流水登记表':[{对方公司名称:'隔离甲企业',到账金额:100,到账日期:'2026-10-02'}],
    '产品-基础表':[{产品名称:'独立目录项',产品类型:'标品'}],
    ...overrides,
  };
  const sheets=Object.entries(tables).map(([name,records])=>{
    const headers=[...new Set(records.flatMap(Object.keys))];
    return {name,rows:[{row:1,values:headers},...records.map((data,index)=>({row:index+2,values:headers.map(h=>data[h]??null)}))]};
  });
  fs.writeFileSync(path.join(extraction,'QFCRM.rows.json'),JSON.stringify({file:'QFCRM.xlsx',sha256:'fixture-source',sheets}));
  const relative_path='QFCRM-FILE/合同总表/合同附件/signed.pdf',content=Buffer.from('%PDF-fixture unverified document');
  fs.mkdirSync(path.dirname(path.join(source,relative_path)),{recursive:true});fs.writeFileSync(path.join(source,relative_path),content);
  fs.writeFileSync(manifest,JSON.stringify({files:[{relative_path,size:content.length,sha256:hash(content)}]}));
  const db=openDatabase(database);
  db.prepare('INSERT INTO users(id,name,username,role,active,created_at,developer_admin,business_member,performance_enabled) VALUES(?,?,?,?,?,?,?,?,?)').run(1,'孙笑天','fixture-dev','admin',1,now,1,0,0);
  db.prepare('INSERT INTO users(id,name,username,role,active,created_at,developer_admin,business_member,performance_enabled) VALUES(?,?,?,?,?,?,?,?,?)').run(2,'历史销售甲','fixture-sales','sales',1,now,0,1,1);
  db.close();
  return {database,extraction,source,manifest,now};
}
const read=(filename,fn)=>{const db=openDatabase(filename);try{return fn(db);}finally{db.close();}};

test('原表合同订单类型逐项带入，缺失仍为空且不从产品类型猜测',t=>{
  for(const order of ['代销','经销','千帆',null]){
    const opts=input(t,{'合同总表':[{合同编号:'HT202601001',客户名称:'隔离甲企业',售卖产品:'原表产品',产品类型:'标品',合同金额:'100',产品金额:'100',合同签订时间:'2026-01-01',销售小二:'历史销售甲',订单类型:order}]});
    importQfcrm(opts);
    read(opts.database,db=>assert.equal(db.prepare('SELECT order_type FROM contracts').get().order_type,order));
  }
});

test('严格准入保留开发者权限与未知毛利，仅导成功业务来源并分开回款计划',t=>{
  const opts=input(t),r=importQfcrm(opts);
  assert.deepEqual(r.integrity,{check:'ok',foreign_key_errors:0});
  assert.equal(r.totals.customers,1);assert.equal(r.totals.contacts,1);assert.equal(r.totals.opportunities,1);
  assert.equal(r.totals.contracts,1);assert.equal(r.totals.contract_items,2);assert.equal(r.totals.payments,2);
  read(opts.database,db=>{
    const developer=db.prepare('SELECT * FROM users WHERE id=1').get();assert.equal(developer.business_member,0);assert.equal(developer.developer_admin,1);
    const history=db.prepare("SELECT * FROM users WHERE name='历史销售甲'").get();assert.equal(history.active,1);assert.equal(Object.hasOwn(history,'password'),false);assert.equal(history.ding_user_id,null);assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,2);
    const c=db.prepare('SELECT * FROM contracts').get();assert.equal(c.amount,1000025);assert.equal(c.owner_id,2);assert.equal(Object.hasOwn(c,'source_sales'),false);assert.equal(c.lifecycle,'历史登记');assert.equal(c.archive_attachment_id,null);assert.equal(c.commission_policy,'pending');assert.equal(Object.hasOwn(c,'accept_status'),false);assert.equal(c.project_status,null);
    const o=db.prepare('SELECT * FROM opportunities').get();assert.equal(o.stage,'商务');assert.equal(Object.hasOwn(o,'mirror'),false);assert.equal(o.product_amount,600000);assert.equal(o.sale_type,'新签自建');assert.equal(o.order_type,'千帆');assert.equal(Object.hasOwn(o,'product_type'),false);
    assert.ok(db.prepare('SELECT margin,rate FROM contract_items').all().every(x=>x.margin===null&&x.rate===null));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM performance_reviews').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM commission_batches').get().n,0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM settings WHERE key='product_catalog'").get().n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM source_records WHERE source_table='产品-基础表'").get().n,0);
    assert.ok(r.excluded.some(x=>x.sheet==='产品-基础表'&&/没有产品目录读取或维护功能/.test(x.reason)));
    assert.equal(db.prepare("SELECT COUNT(*) n FROM source_records WHERE status!='imported'").get().n,0);assert.ok(r.excluded.some(x=>x.sheet==='合同总表'&&/签订日期/.test(x.reason)));
    const attachment=db.prepare('SELECT * FROM attachments').get();assert.equal(attachment.entity,'contract');assert.equal(attachment.entity_id,c.id);
    const plan=db.prepare("SELECT payload FROM source_records WHERE source_table='项目回款计划'").get();assert.equal(JSON.parse(plan.payload).related.length,2);
  });
  assert.equal(r.amounts_cents.received,150000);assert.equal(r.amounts_cents.planned,850025);
});

test('重复执行保持业务、来源、附件和审计幂等，既有业务差异不被覆盖',t=>{
  const opts=input(t),first=importQfcrm(opts),second=importQfcrm(opts);
  assert.deepEqual(second.totals,first.totals);assert.deepEqual(second.created,{});assert.ok(second.skipped_idempotent>0);
  const src=JSON.parse(fs.readFileSync(path.join(opts.extraction,'QFCRM.rows.json'),'utf8'));
  const sheet=src.sheets.find(s=>s.name==='PPL总表');sheet.rows[1].values[sheet.rows[0].values.indexOf('合同金额')]='20000';
  fs.writeFileSync(path.join(opts.extraction,'QFCRM.rows.json'),JSON.stringify(src));
  const third=importQfcrm(opts);assert.equal(third.totals.opportunities,1);
  read(opts.database,db=>{assert.equal(db.prepare('SELECT amount FROM opportunities').get().amount,1000025);assert.ok(third.excluded.some(x=>x.sheet==='PPL总表'&&/来源不同/.test(x.reason)));assert.equal(db.prepare('SELECT COUNT(*) n FROM audit').get().n,1);});
});

test('拆分冲突整条合同留包外，缺日期与超收不补造流水或未分类明细',t=>{
  const opts=input(t,{'合同总表':[{合同编号:'HT202601001',客户名称:'隔离甲企业',售卖产品:'组合项目',产品类型:'标品,定开',合同金额:'100',产品金额:'80','项目/服务金额':'80',合同签订时间:'2026-01-01',销售小二:'历史销售甲'}],
    '项目回款计划':[{项目名称:'缺到账日期',客户:'隔离甲企业','合同总表 4':'HT202601001',合同金额:'100',已回款金额:'100',未回款金额:'0',是否回款:'是'}, {项目名称:'原始超收',客户:'隔离甲企业','合同总表 4':'HT202601001',合同金额:'100',已回款金额:'120',未回款金额:'0',是否回款:'是',实际回款时间:'2026-01-02'}]});
  const r=importQfcrm(opts);assert.equal(r.totals.payments,0);
  read(opts.database,db=>{assert.equal(db.prepare('SELECT COUNT(*) n FROM contracts').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM contract_items').get().n,0);assert.equal(db.prepare("SELECT COUNT(*) n FROM source_records WHERE source_table='合同总表'").get().n,0);});
  assert.ok(r.excluded.some(x=>x.sheet==='合同总表'&&/不等于/.test(x.reason)&&x.values['产品金额']==='80'));
});

test('附件路径和校验和出错整次业务导入回滚',t=>{
  const opts=input(t),m=JSON.parse(fs.readFileSync(opts.manifest,'utf8'));m.files[0].sha256='wrong';fs.writeFileSync(opts.manifest,JSON.stringify(m));
  assert.throws(()=>importQfcrm(opts),/整次导入回滚/);
  read(opts.database,db=>{assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM source_records').get().n,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,2);});
  m.files[0].relative_path='QFCRM-FILE/合同总表/合同附件/../../signed.pdf';fs.writeFileSync(opts.manifest,JSON.stringify(m));assert.throws(()=>importQfcrm(opts),/路径不安全/);
});

test('导入器禁止直接写正式库，金额不把空值和错误值变成零',()=>{
  const formal=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/crm.sqlite');
  assert.throws(()=>importQfcrm({database:formal}),/禁止直接修改正式/);
  assert.equal(parseSourceMoney('¥1,234.56'),123456);assert.equal(parseSourceMoney('0.01'),1);
  assert.equal(parseSourceMoney('0'),0);assert.equal(parseSourceMoney(null),null);assert.equal(parseSourceMoney('未知'),null);assert.equal(parseSourceMoney('1.001'),null);
});

test('未知或停用销售、缺销售分类与联系人方式不能借历史导入绕过必填',t=>{
  const opts=input(t,{'客户-基础表':[{客户:'隔离甲企业',联系人姓名:'只有姓名',创建人:'孙笑天'}],
    'PPL总表':[{商机编号:'SJ202610001',客户名称:'隔离甲企业',售卖产品:'项目',商机阶段:'需求阶段',合同金额:100,产品类型:null,订单类型:'千帆',销售小二:'历史销售甲',创建时间:'2026-10-01'}]});
  const r=importQfcrm(opts);assert.equal(r.totals.customers,1);assert.equal(r.totals.contacts,0);assert.equal(r.totals.opportunities,0);
  assert.ok(r.excluded.some(x=>/销售分类缺失/.test(x.reason)));assert.ok(r.excluded.some(x=>x.kind==='contact'));
  const repeated=importQfcrm(opts);assert.ok(repeated.excluded.some(x=>x.kind==='contact'));assert.deepEqual(repeated.totals,r.totals);
  read(opts.database,db=>{assert.equal(db.prepare("SELECT COUNT(*) n FROM source_records WHERE source_table='PPL总表'").get().n,0);});
  const stopped=input(t);read(stopped.database,db=>db.prepare('UPDATE users SET active=0 WHERE id=2').run());
  const blocked=importQfcrm(stopped);assert.equal(blocked.totals.customers,0);assert.equal(blocked.totals.contracts,0);assert.equal(blocked.totals.source_records,0);assert.equal(blocked.totals.attachments,0);
  read(stopped.database,db=>assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,2));
});

test('cash金额为必填，原文明确为0可导入，缺失或超额不补造',t=>{
  for(const cash of [null,0,10001]){
    const opts=input(t),filename=path.join(opts.extraction,'QFCRM.rows.json'),source=JSON.parse(fs.readFileSync(filename,'utf8')),sheet=source.sheets.find(s=>s.name==='PPL总表');
    sheet.rows[1].values[sheet.rows[0].values.indexOf('cash金额')]=cash;fs.writeFileSync(filename,JSON.stringify(source));
    const result=importQfcrm(opts);assert.equal(result.totals.opportunities,cash===0?1:0);
    if(cash===0)read(opts.database,db=>assert.equal(db.prepare('SELECT product_amount FROM opportunities').get().product_amount,0));
    else assert.ok(result.excluded.some(r=>r.sheet==='PPL总表'&&/cash金额/.test(r.reason)));
  }
});
