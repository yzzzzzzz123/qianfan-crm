import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openDatabase,all,one,run} from '../server/database.mjs';
import {seedDemo} from '../server/seed.mjs';
import {migrateQuoteTotals} from '../server/quote-schema.mjs';
import {deriveQuoteTotals} from '../server/quote-values.mjs';
import {fixture} from './helpers/fixture.mjs';
import {today} from '../server/domain.mjs';

const items=[
  {name:'产品',kind:'标品',quantity:3,list_price:9999,discount_rate:0.85,list_amount:29997,amount:25497},
  {name:'实施',kind:'实施',quantity:2,list_price:12345,discount_rate:0.9,list_amount:24690,amount:22221},
];
function schema11(){
  const db=openDatabase(':memory:');seedDemo(db);
  // Reconstruct only the two retired schema11 columns in an isolated fixture.
  db.exec('DELETE FROM schema_version WHERE version>=12; ALTER TABLE quotes ADD COLUMN list_amount INTEGER; ALTER TABLE quotes ADD COLUMN discount_amount INTEGER;');
  return db;
}
function insertQuote(db,{rawItems=items,list=54687,discount=6969,amount=47718}={}){
  return Number(run(db,'INSERT INTO quotes(opportunity_id,user_id,amount,valid_until,note,created_at,items,list_amount,discount_amount) VALUES(?,?,?,?,?,?,?,?,?)',1,2,amount,today(),'原始历史报价','2026-10-01T00:00:00.000Z',JSON.stringify(rawItems),list,discount).lastInsertRowid);
}
const columns=db=>all(db,'PRAGMA table_info(quotes)').map(c=>c.name);

test('报价汇总逐行舍入再累计，不读取过时行缓存或把未知明细推成零',()=>{
  assert.deepEqual(deriveQuoteTotals(JSON.stringify(items)),{list_amount:54687,discount_amount:6969});
  const fractional=[{quantity:0.5,list_price:101,discount_rate:0.5},{quantity:0.5,list_price:101,discount_rate:0.5}];
  assert.deepEqual(deriveQuoteTotals(fractional),{list_amount:102,discount_amount:50});
  assert.notEqual(Math.round(101*0.5+101*0.5),102,'禁止先合并再舍入');
  assert.deepEqual(deriveQuoteTotals([{...items[0],list_amount:1,amount:1}]),{list_amount:29997,discount_amount:4500});
  for(const raw of [null,undefined,'not JSON','{}','[]',[],[null],[{list_price:100,quantity:1}],[{list_price:100,quantity:1,discount_rate:null}],[{list_price:100,quantity:'1',discount_rate:1}],[{list_price:1.1,quantity:1,discount_rate:1}],[{list_price:Number.MAX_SAFE_INTEGER,quantity:2,discount_rate:1}]]){
    assert.deepEqual(deriveQuoteTotals(raw),{list_amount:null,discount_amount:null});
  }
  assert.deepEqual(deriveQuoteTotals([{list_price:100,quantity:1,discount_rate:0}]),{list_amount:100,discount_amount:100});
});

test('当前结构为37表348列，报价创建不存重复列而状态仍返回计算结果',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  assert.equal(one(f.db,'SELECT MAX(version) version FROM schema_version').version,31);
  const tables=all(f.db,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  assert.equal(tables.length,37);
  assert.equal(tables.reduce((sum,{name})=>sum+all(f.db,`PRAGMA table_info(${name})`).length,0),348);
  for(const name of ['customer_profiles','contract_attachment_analyses','company_profile_jobs','company_profile_queue_control'])assert.ok(tables.some(table=>table.name===name),name);
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM company_profile_jobs').n,one(f.db,'SELECT COUNT(*) n FROM customers').n,'客户查询任务唯一且覆盖已有客户');
  assert.equal(one(f.db,'SELECT COUNT(*) n FROM customer_profiles').n,0,'仅建立任务，不猜造企业资料');
  const contractColumns=all(f.db,'PRAGMA table_info(contracts)');
  for(const name of ['renewal_tag','payment_type','project_status','delivery_staff','project_note'])assert.equal(contractColumns.find(column=>column.name===name)?.notnull,0,name+' 允许保留历史未知值');
  assert.equal(columns(f.db).includes('list_amount'),false);assert.equal(columns(f.db).includes('discount_amount'),false);
  const result=await f.request('/quotes',{actor,method:'POST',body:{opportunity_id:1,valid_until:today(),items:[{name:'按半份报价一',kind:'实施',quantity:0.5,list_price:1.01,discount_rate:0.5},{name:'按半份报价二',kind:'实施',quantity:0.5,list_price:1.01,discount_rate:0.5}]}});
  assert.equal(result.status,200,JSON.stringify(result.body));
  const saved=one(f.db,'SELECT * FROM quotes WHERE id=?',result.body.id);
  assert.equal(saved.amount,52);assert.equal(Object.hasOwn(saved,'list_amount'),false);
  const state=(await f.request('/state',{actor})).body;
  assert.equal(state.quotes.find(q=>q.id===result.body.id).list_amount,102);
  assert.equal(state.quotes.find(q=>q.id===result.body.id).discount_amount,50);
  const old=state.quotes.find(q=>q.id!==result.body.id&&q.items.length===0);
  assert.ok(old);assert.equal(old.list_amount,null);assert.equal(old.discount_amount,null);assert.ok(old.amount>0);
});

test('schema12保留原报价ID金额与明细，仅不能还原的汇总保存稳定来源证据且升级幂等',()=>{
  const db=schema11();try{
    const exact=insertQuote(db),mismatch=insertQuote(db,{list:55000,discount:7000});
    const legacy=insertQuote(db,{rawItems:[],list:null,discount:null,amount:10000});
    const opaque=insertQuote(db,{rawItems:[],list:11000,discount:1000,amount:10000});
    const before=all(db,'SELECT id,opportunity_id,user_id,amount,valid_until,note,created_at,items FROM quotes ORDER BY id');
    const original=one(db,'SELECT id,items,amount,list_amount,discount_amount FROM quotes WHERE id=?',mismatch);
    const users=all(db,'SELECT * FROM users'),opps=all(db,'SELECT * FROM opportunities');
    migrateQuoteTotals(db);
    assert.deepEqual(all(db,'SELECT id,opportunity_id,user_id,amount,valid_until,note,created_at,items FROM quotes ORDER BY id'),before);
    assert.deepEqual(all(db,'SELECT * FROM users'),users);assert.deepEqual(all(db,'SELECT * FROM opportunities'),opps);
    const evidence=all(db,"SELECT * FROM source_records WHERE source='schema12报价结构迁移' ORDER BY entity_id");
    assert.deepEqual(evidence.map(row=>row.entity_id),[mismatch,opaque]);
    assert.equal(evidence.some(row=>row.entity_id===exact||row.entity_id===legacy),false);
    assert.equal(evidence[0].payload,JSON.stringify(original));assert.equal(evidence[0].entity,'quote');
    assert.equal(evidence[0].fingerprint,createHash('sha256').update('schema12:quotes:'+mismatch+':'+JSON.stringify(original)).digest('hex'));
    assert.equal(evidence[0].status,'archived');assert.equal(evidence[0].source_table,'quotes');
    const revision=one(db,'SELECT revision FROM workspace_revision WHERE id=1').revision;
    migrateQuoteTotals(db);
    assert.deepEqual(all(db,"SELECT * FROM source_records WHERE source='schema12报价结构迁移' ORDER BY entity_id"),evidence);
    assert.equal(one(db,'SELECT revision FROM workspace_revision WHERE id=1').revision,revision);
    assert.equal(one(db,'SELECT COUNT(*) n FROM schema_version WHERE version=12').n,1);
    assert.deepEqual(all(db,'PRAGMA foreign_key_check'),[]);assert.equal(one(db,'PRAGMA integrity_check').integrity_check,'ok');
  }finally{db.close();}
});

test('schema12已有相同迁移证据不覆盖时间或内容，不增加重复来源',()=>{
  const db=schema11();try{
    const id=insertQuote(db,{list:55000,discount:7000});
    const row=one(db,'SELECT id,items,amount,list_amount,discount_amount FROM quotes WHERE id=?',id),payload=JSON.stringify(row);
    const fingerprint=createHash('sha256').update('schema12:quotes:'+id+':'+payload).digest('hex');
    run(db,'INSERT INTO source_records(source,entity,entity_id,payload,source_file,imported_at,fingerprint,status,reason) VALUES(?,?,?,?,?,?,?,?,?)','schema12报价结构迁移','quote',id,payload,'已有升级证据','2026-10-01T00:00:00.000Z',fingerprint,'archived','已有说明不得覆盖');
    const before=all(db,'SELECT * FROM source_records');migrateQuoteTotals(db);
    assert.deepEqual(all(db,'SELECT * FROM source_records'),before);
  }finally{db.close();}
});

test('schema12后半段失败原子回滚已删列、来源证据、版本与revision',()=>{
  const db=schema11();try{
    insertQuote(db,{list:55000,discount:7000});
    db.exec('CREATE VIEW schema12_failure_fixture AS SELECT discount_amount FROM quotes');
    const before=all(db,'SELECT * FROM quotes'),source=all(db,'SELECT * FROM source_records');
    const revision=one(db,'SELECT revision FROM workspace_revision WHERE id=1').revision;
    assert.throws(()=>migrateQuoteTotals(db),/discount_amount|view/);
    assert.ok(columns(db).includes('list_amount'));assert.ok(columns(db).includes('discount_amount'));
    assert.deepEqual(all(db,'SELECT * FROM quotes'),before);assert.deepEqual(all(db,'SELECT * FROM source_records'),source);
    assert.equal(one(db,'SELECT MAX(version) version FROM schema_version').version,11);
    assert.equal(one(db,'SELECT revision FROM workspace_revision WHERE id=1').revision,revision);
    assert.equal(one(db,'PRAGMA foreign_keys').foreign_keys,1);
    db.exec('DROP VIEW schema12_failure_fixture');migrateQuoteTotals(db);
    assert.equal(one(db,'SELECT MAX(version) version FROM schema_version').version,12);
    assert.equal(all(db,'SELECT * FROM source_records').length,source.length+1);
  }finally{db.close();}
});

test('schema12检测已有证据指纹冲突时拒绝升级，原数据与证据均不覆盖',()=>{
  const db=schema11();try{
    const id=insertQuote(db,{list:55000,discount:7000});
    const row=one(db,'SELECT id,items,amount,list_amount,discount_amount FROM quotes WHERE id=?',id);
    const fingerprint=createHash('sha256').update('schema12:quotes:'+id+':'+JSON.stringify(row)).digest('hex');
    run(db,'INSERT INTO source_records(source,payload,source_file,imported_at,fingerprint) VALUES(?,?,?,?,?)','隔离冲突证据','{}','isolated fixture','2026-10-01T00:00:00.000Z',fingerprint);
    assert.throws(()=>migrateQuoteTotals(db),/证据指纹冲突/);
    assert.equal(one(db,'SELECT payload FROM source_records WHERE fingerprint=?',fingerprint).payload,'{}');
    assert.deepEqual(one(db,'SELECT id,items,amount,list_amount,discount_amount FROM quotes WHERE id=?',id),row);
    assert.equal(one(db,'SELECT MAX(version) version FROM schema_version').version,11);
  }finally{db.close();}
});
