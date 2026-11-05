import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,one,run} from '../server/database.mjs';
import {createCompanyProfiles} from '../server/company-profile.mjs';
import {createCompanyProfileQueue} from '../server/company-profile-queue.mjs';
import {createQccMcpProfileProvider} from '../server/qcc-mcp-profile.mjs';
import {QCC_MCP_VERSION} from '../server/qcc-mcp-transport.mjs';

const registration='get_company_registration_info',profile='get_company_profile';
const tool=name=>({name,inputSchema:{type:'object',properties:{searchKey:{type:'string'}},required:['searchKey']}});
const reply=(id,result)=>new Response(JSON.stringify({jsonrpc:'2.0',id,result}),{headers:{'Content-Type':'application/json'}});

function fixture(t){
  const db=openDatabase(':memory:');t.after(()=>db.close());
  run(db,"INSERT INTO users(id,name,username,role,created_at) VALUES(1,'隔离销售','qcc-integration-only','sales','2026-11-02T00:00:00Z')");
  run(db,"INSERT INTO customers(id,name,normalized,credit_code,owner_id,created_at,updated_at) VALUES(1,'完整链路隔离科技有限公司','完整链路隔离科技有限公司','91310000MA1K00000X',1,'2026-11-02T00:00:00Z','2026-11-02T00:00:00Z')");
  let clock=Date.parse('2026-11-02T00:00:00Z'),quota=false,hook=null;const calls=[];
  const provider=createQccMcpProfileProvider({env:{CRM_COMPANY_PROFILE_PROVIDER:'qcc-mcp',QCC_MCP_API_KEY:'synthetic-integration-key'},fetcher:async(_url,options)=>{
    assert.equal(db.isTransaction,false,'外部请求不得持有SQLite写事务');
    const m=JSON.parse(options.body);
    if(m.method==='initialize')return reply(m.id,{protocolVersion:QCC_MCP_VERSION,capabilities:{tools:{}}});
    if(m.method==='notifications/initialized')return new Response(null,{status:202});
    if(m.method==='tools/list')return reply(m.id,{tools:[tool(registration),tool(profile)]});
    calls.push(m.params.name);
    const customer=one(db,'SELECT name,credit_code FROM customers WHERE id=1');
    if(hook)await hook(m);
    if(m.params.name===profile&&quota)return reply(m.id,{isError:true,structuredContent:{code:300008,message:'upstream-private-detail'}});
    return reply(m.id,{structuredContent:m.params.name===registration?{'企业名称':customer.name,'统一社会信用代码':customer.credit_code,'人员规模':'10-19人','经营范围':'软件开发','参保人数':0}:{'企业名称':customer.name,'企业规模':'小型','主营产品':['隔离产品'],'简介':'源返回的完整简介'}});
  }});
  const profiles=createCompanyProfiles({db,provider,scoped:()=>{throw new Error('Unused manual path');},audit:()=>{}});
  const createQueue=()=>createCompanyProfileQueue({db,provider,clock:()=>clock,commitResult:(customer,result)=>{
    assert.equal(db.isTransaction,true,'只在短事务内保存已核验资料');return profiles.saveResult(customer,result);
  }});
  return {db,provider,profiles,calls,createQueue,quota:value=>{quota=value;},clock:value=>{clock=Date.parse(value);},hook:value=>{hook=value;},read:()=>profiles.read(one(db,'SELECT * FROM customers WHERE id=1'))};
}

test('真实provider和持久队列联通：额度暂停后只补简介，完整资料与任务状态同事务提交',async t=>{
  const f=fixture(t),q=f.createQueue();f.quota(true);
  const first=await q.runNext({manual:true});
  assert.equal(first.job.status,'waiting_quota');assert.equal(first.job.stage,'profile');assert.equal(first.job.complete,false);
  assert.deepEqual(f.calls,[registration,profile]);assert.equal(f.read().state,'partial');assert.equal(f.read().details.insured_count,'0');assert.equal(f.read().details.main_products,null);
  assert.equal(q.summary().estimated_remaining_credits,1);assert.equal((await q.runNext({manual:true})).state,'waiting_quota');
  assert.doesNotMatch(JSON.stringify(one(f.db,'SELECT * FROM company_profile_jobs WHERE customer_id=1')),/upstream-private|synthetic-integration/);
  f.quota(false);f.clock('2026-11-02T18:05:01Z');
  // A new queue instance must recover the committed checkpoint, not RAM state.
  const resumed=f.createQueue(),second=await resumed.runNext({manual:true});
  assert.equal(second.job.status,'complete');assert.equal(second.job.complete,true);assert.deepEqual(f.calls,[registration,profile,profile]);
  assert.equal(f.read().state,'ready');assert.equal(f.read().details.employee_scale,'10-19人');assert.equal(f.read().details.company_scale,'小型');assert.equal(f.read().details.main_products,'隔离产品');assert.equal(resumed.summary().estimated_remaining_credits,0);
  resumed.enqueueCustomer(1,{retry:true});await resumed.runNext({manual:true});assert.equal(f.calls.length,3,'完整同主体检查点不得重新收费查询');
});

test('真实provider的工商回调遇主体变化立即停止；新任务只接受新主体资料',async t=>{
  const f=fixture(t),q=f.createQueue();let changed=false;
  f.hook(m=>{if(m.params.name===registration&&!changed){changed=true;run(f.db,"UPDATE customers SET name='更名后的隔离科技有限公司' WHERE id=1");}});
  await q.runNext({manual:true});
  assert.deepEqual(f.calls,[registration]);assert.equal(q.read(1).status,'pending');assert.equal(one(f.db,'SELECT COUNT(*) n FROM customer_profiles').n,0);
  f.hook(null);await q.runNext({manual:true});
  assert.deepEqual(f.calls,[registration,registration,profile]);assert.equal(q.read(1).status,'complete');assert.equal(f.read().details.company_name,'更名后的隔离科技有限公司');
});
