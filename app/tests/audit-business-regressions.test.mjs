import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,customer} from './helpers/fixture.mjs';
import {one,run} from '../server/database.mjs';
import {dateAdd,now} from '../server/domain.mjs';

const templates={issuer:'隔离验收公司',quote:'报价日期：{{date}}',contract:'签约日期：{{date}}',confirmed:true};
function setTemplates(db,documents){run(db,"INSERT INTO settings(key,value) VALUES('integrations',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify({documents}));}
function docxText(file){
  const zip=Buffer.from(file.base64,'base64');
  let offset=0;
  while(zip.readUInt32LE(offset)===0x04034b50){
    const size=zip.readUInt32LE(offset+18),nameLength=zip.readUInt16LE(offset+26),extraLength=zip.readUInt16LE(offset+28);
    const name=zip.subarray(offset+30,offset+30+nameLength).toString();
    const start=offset+30+nameLength+extraLength;
    if(name==='word/document.xml')return zip.subarray(start,start+size).toString();
    offset=start+size;
  }
  throw new Error('Word document XML missing');
}

test('历史合同未提供签约日时，核对稿和批准模板均明确未知，不用创建日期代填',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  run(f.db,"UPDATE contracts SET sign_date='',created_at='2026-10-30T08:12:00.000Z',contract_no='HT-DATE-UNKNOWN' WHERE id=1");
  for(const documents of [{},templates,{...templates,contract:'本合同金额：{{amount}}'}]){
    setTemplates(f.db,documents);
    const result=await f.request('/documents/contract/1',{actor});
    assert.equal(result.status,200);
    for(const output of [result.body.html,docxText(result.body)]){
      assert.match(output,/签约日期未提供/);
      assert.doesNotMatch(output,/2026-10-30/);
    }
    if(documents.contract?.includes('{{date}}'))assert.match(docxText(result.body),/签约日期：未提供/);
    assert.equal(result.body.official,!!documents.confirmed);
  }
  assert.equal(one(f.db,'SELECT sign_date FROM contracts WHERE id=1').sign_date,'');
});

test('合同导出沿用实际签约日，报价独立使用自身创建日期',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  setTemplates(f.db,templates);
  run(f.db,"UPDATE contracts SET sign_date='2025-06-03',created_at='2026-10-30T08:12:00.000Z' WHERE id=1");
  const contract=await f.request('/documents/contract/1',{actor});
  assert.equal(contract.status,200);
  assert.match(docxText(contract.body),/签约日期：2025-06-03/);
  assert.doesNotMatch(docxText(contract.body),/签约日期未提供/);
  const qid=one(f.db,'SELECT id FROM quotes LIMIT 1').id;
  run(f.db,"UPDATE quotes SET created_at='2026-07-14T08:12:00.000Z' WHERE id=?",qid);
  const quote=await f.request('/documents/quote/'+qid,{actor});
  assert.equal(quote.status,200);
  assert.match(docxText(quote.body),/报价日期：2026-07-14/);
  assert.doesNotMatch(docxText(quote.body),/签约日期未提供/);
});

test('赢单输单搁置不计推进风险，仍在跟的关键人触达提醒继续生效',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  run(f.db,'UPDATE contacts SET last_contact=? WHERE role IN (?,?)',dateAdd(-100),'决策人','影响者');
  const oid=one(f.db,'SELECT id FROM opportunities WHERE customer_id=1 LIMIT 1').id;
  for(const stage of ['赢单','输单','搁置']){
    run(f.db,'UPDATE opportunities SET stage=? WHERE id=?',stage,oid);
    const state=(await f.request('/state',{actor})).body;
    const record=state.opportunities.find(o=>o.id===oid);
    assert.equal(record.risk.level,'normal');
    for(const member of state.team){
      const expected=state.opportunities.filter(o=>o.owner_id===member.id&&!['赢单','输单','搁置'].includes(o.stage)&&o.risk.level!=='normal').length;
      assert.equal(member.riskCount,expected);
    }
  }
  run(f.db,"UPDATE opportunities SET stage='需求',stage_at=?,created_at=?,follow_date=NULL,expected_date=? WHERE id=?",now(),now(),dateAdd(10),oid);
  const state=(await f.request('/state',{actor})).body;
  const active=state.opportunities.find(o=>o.id===oid);
  assert.equal(active.risk.level,'attention');
  assert.equal(active.risk.label,'关键人待触达');
});

test('客户标签与流程标记新增更新共享上限，超限整体回滚且有效长值保留',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  const valid={tags:'标'.repeat(500),compliance_flag:'流'.repeat(200)};
  const result=await f.request('/customers',{actor,method:'POST',body:customer({name:'边界长度验收企业',...valid})});
  assert.equal(result.status,200,JSON.stringify(result.body));
  const id=result.body.id;
  const updated=await f.request('/customers/'+id,{actor,method:'PATCH',body:{...valid,note:'有效长内容不阻断维护'}});
  assert.equal(updated.status,200,JSON.stringify(updated.body));
  assert.equal(one(f.db,'SELECT tags FROM customers WHERE id=?',id).tags,valid.tags);
  for(const field of ['tags','compliance_flag']){
    const invalid={...valid,[field]:valid[field]+'超'};
    const create=await f.request('/customers',{actor,method:'POST',body:customer({name:'超限长度验收企业'+field,duplicate_ack:true,...invalid})});
    assert.equal(create.status,400);
    const edit=await f.request('/customers/'+id,{actor,method:'PATCH',body:{...invalid,note:'不应保存'}});
    assert.equal(edit.status,400);
    assert.deepEqual({...one(f.db,'SELECT tags,compliance_flag,note FROM customers WHERE id=?',id)},{...valid,note:'有效长内容不阻断维护'});
  }
});

test('来源和附件能力标记遵循现有API权限，不扩大PM或共享客户权限',async t=>{
  const f=await fixture(t),admin=await f.login(1),sales=await f.login(2),other=await f.login(3);
  const pmid=Number(run(f.db,'INSERT INTO users(name,username,role,created_at) VALUES(?,?,?,?)','隔离PM','audit-permissions-pm','pm',now()).lastInsertRowid);
  run(f.db,'UPDATE contracts SET collaborator_pm=? WHERE id=1',pmid);
  const customerId=one(f.db,'SELECT customer_id FROM contracts WHERE id=1').customer_id;
  run(f.db,'INSERT OR IGNORE INTO customer_collaborators VALUES(?,?)',customerId,pmid);
  const aid=Number(run(f.db,'INSERT INTO attachments(entity,entity_id,filename,mime_type,size,sha256,content,created_at) VALUES(?,?,?,?,?,?,?,?)','contract',1,'权限验收.pdf','application/pdf',8,'permission-test',Buffer.from('%PDF-1.7'),now()).lastInsertRowid);
  const pm=await f.login(pmid);
  for(const [actor,allowed] of [[admin,true],[sales,true],[pm,false]]){
    const state=(await f.request('/state',{actor})).body,c=state.contracts.find(c=>c.id===1);
    assert.equal(c.can_read_sources,allowed);assert.equal(c.can_download_attachments,allowed);
    assert.equal(state.customers.find(c=>c.id===customerId).can_read_sources,allowed);
    assert.equal((await f.request('/attachments/'+aid,{actor})).status,allowed?200:403);
    assert.equal((await f.request('/source-records?entity=contract&id=1',{actor})).status,allowed?200:403);
    if(!allowed){
      const opportunity=state.opportunities.find(o=>o.customer_id===customerId);assert.ok(opportunity);
      assert.equal(opportunity.can_read_sources,true);
      assert.equal((await f.request('/source-records?entity=opportunity&id='+opportunity.id,{actor})).status,200);
    }
  }
  const otherState=(await f.request('/state',{actor:other})).body;
  assert.equal(otherState.customers.find(c=>c.id===customerId).can_read_sources,false);
  assert.equal((await f.request('/attachments/'+aid,{actor:other})).status,403);
});
