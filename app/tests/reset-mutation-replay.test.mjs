import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,opp} from './helpers/fixture.mjs';
import {one} from '../server/database.mjs';
import {today} from '../server/domain.mjs';

const message='原业务已清理，请刷新后以新操作提交';
function tombstone(db,path,key){
  const row=one(db,'SELECT * FROM mutations WHERE key=?',`1:1:POST:/api${path}:${key}`);assert.ok(row);
  db.prepare('UPDATE mutations SET response=? WHERE key=?').run(JSON.stringify({reset:true,requires_new_request:true,message:'清理工具原说明'}),row.key);
}

test('旧商机及合同创建回执已清理时返回409，hash冲突优先，客户原回执仍正常重放',async t=>{
  const f=await fixture(t),actor=await f.login(1);
  for(const [path,body,table] of [['/opportunities',opp(1,{name:'旧操作商机',owner_id:2}),'opportunities'],['/contracts',{customer_id:1,owner_id:2,name:'旧操作合同',sign_date:today(),items:[{name:'授权',kind:'标品',amount:100}]},'contracts']]){
    const key=randomUUID(),request={actor,method:'POST',body,key};const first=await f.request(path,request);assert.equal(first.status,200);
    tombstone(f.db,path,key);const count=one(f.db,'SELECT COUNT(*) n FROM '+table).n;
    const replay=await f.request(path,request);assert.equal(replay.status,409);assert.equal(replay.body.error,message);assert.equal(replay.body.id,undefined);
    const conflict=await f.request(path,{...request,body:{...body,name:'请求内容不同'}});assert.equal(conflict.status,409);assert.match(conflict.body.error,/重复操作编号对应不同内容/);assert.doesNotMatch(conflict.body.error,/原业务已清理/);
    assert.equal(one(f.db,'SELECT COUNT(*) n FROM '+table).n,count);
  }
  const key=randomUUID(),request={actor,method:'POST',body:{name:'保留客户原回执',owner_id:2},key};
  const first=await f.request('/customers',request);assert.equal(first.status,200);const count=one(f.db,'SELECT COUNT(*) n FROM customers').n;
  const replay=await f.request('/customers',request);assert.equal(replay.status,200);assert.deepEqual(replay.body,first.body);assert.equal(one(f.db,'SELECT COUNT(*) n FROM customers').n,count);
});

test('AI接收失效回执在调用模型前返回409，保留冲突优先且不会新增接收批次',async t=>{
  let calls=0;const f=await fixture(t,{aiProvider:{configured:true,model:'fake-model',prepare:async()=>{calls++;return {model:'fake-model',summary:'隔离新客户提案',questions:[],usage:{},operations:[{type:'customer',action:'create',ref:'c',source_file:'粘贴内容',evidence:'用户提供',data:{name:'仅预览未写入客户',owner_id:2}}]};}}}),actor=await f.login(1);
  const key=randomUUID(),request={actor,method:'POST',body:{text:'隔离旧批次'},key},first=await f.request('/ai/intake',request);assert.equal(first.status,200);assert.equal(calls,1);
  tombstone(f.db,'/ai/intake',key);const count=one(f.db,'SELECT COUNT(*) n FROM ai_import_batches').n;
  const replay=await f.request('/ai/intake',request);assert.equal(replay.status,409);assert.equal(replay.body.error,message);assert.equal(replay.body.id,undefined);
  const conflict=await f.request('/ai/intake',{...request,body:{text:'不同的资料'}});assert.equal(conflict.status,409);assert.match(conflict.body.error,/操作编号冲突/);assert.doesNotMatch(conflict.body.error,/原业务已清理/);
  assert.equal(calls,1);assert.equal(one(f.db,'SELECT COUNT(*) n FROM ai_import_batches').n,count);
});
