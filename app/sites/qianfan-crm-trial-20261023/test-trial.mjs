import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync as nodeScrypt } from 'node:crypto';
import { scryptSync } from './crypto-browser.mjs';
class Storage {data=new Map();getItem(k){return this.data.get(k)||null}setItem(k,v){this.data.set(k,String(v))}removeItem(k){this.data.delete(k)}}
globalThis.localStorage=new Storage();globalThis.sessionStorage=new Storage();
let adapter;
const login=async(id)=>{const a=await adapter.api('/auth/login',{method:'POST',body:{demo_user_id:id}});adapter.setCsrf(a.csrf)};
const post=(path,body,key)=>adapter.api(path,{method:'POST',body,key});
let cid,oid,contractId;
const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
test('B01 浏览器密码算法与服务器scrypt一致',()=>{assert.equal(scryptSync('trial-password','example-salt',64).toString('hex'),nodeScrypt('trial-password','example-salt',64).toString('hex'))});
test('B02 浏览器SQLite初始化与角色登录',async()=>{adapter=await import('./browser-api.mjs');assert.equal((await adapter.api('/auth/options')).users.length,3);await assert.rejects(adapter.api('/state'),e=>e.status===401);await login(1);assert.equal((await adapter.api('/state')).actor.role,'admin')});
test('B03 浏览器写入客户、查重、商机及跟进',async()=>{
 cid=(await post('/customers',{name:'浏览器自动测试客户',level:'A',owner_id:2})).id;
 await assert.rejects(post('/customers',{name:'浏览器自动测试客户',level:'A'}),e=>e.status===409);
 oid=(await post('/opportunities',{customer_id:cid,name:'浏览器自动测试商机',amount:100000,product_type:'标品',stage:'线索',follow_date:date,next_action:'确认需求'})).id;
 await post('/activities',{opportunity_id:oid,source:'手动跟进',activity_type:'手动跟进',summary:'确认需求范围',action:'演示下一步',activity_date:date});
 assert.equal((await adapter.api('/state')).opportunities.find(o=>o.id===oid).next_action,'演示下一步');
});
test('B04 浏览器成交、回款幂等及超额回滚',async()=>{
 contractId=(await post('/contracts',{opportunity_id:oid,name:'浏览器自动测试合同',sign_date:date,items:[{name:'软件授权',kind:'标品',amount:100000}]})).id;
 const body={contract_id:contractId,amount:20000,status:'已到账',pay_date:date};const key=crypto.randomUUID();
 const a=await post('/payments',body,key);const b=await post('/payments',body,key);assert.equal(a.id,b.id);
 await assert.rejects(post('/payments',{...body,amount:90000}));
 const c=(await adapter.api('/state')).contracts.find(c=>c.id===contractId);assert.equal(c.collected,2000000);assert.equal(c.outstanding,8000000);
});
test('B05 浏览器重新初始化后业务和会话保留',async()=>{adapter=await import('./browser-api.mjs?restart');const a=await adapter.api('/auth/me');adapter.setCsrf(a.csrf);const s=await adapter.api('/state');assert.equal(s.contracts.find(c=>c.id===contractId).outstanding,8000000)});
test('B06 浏览器销售不能写合同回款且只见本人商机',async()=>{await login(3);await assert.rejects(post('/payments',{contract_id:contractId,amount:1,status:'已到账',pay_date:date}),e=>e.status===403);assert.ok((await adapter.api('/state')).opportunities.every(o=>o.owner_id===3))});
test('B07 浏览器存储失败时拒绝保存且恢复原数据',async()=>{await login(1);const before=(await adapter.api('/state')).customers.length;const save=localStorage.setItem;localStorage.setItem=()=>{const e=new Error('full');e.name='QuotaExceededError';throw e};await assert.rejects(post('/customers',{name:'不应写入客户',level:'A'}),/操作未保存/);localStorage.setItem=save;assert.equal((await adapter.api('/state')).customers.length,before)});
