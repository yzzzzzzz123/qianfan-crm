import test from 'node:test';
import assert from 'node:assert/strict';
import {createMinutesClient} from '../server/modules/minutes/client.mjs';

function setup({corpId='dingPrimary',detail={orgId:null,orgUserId:'123456'},resolve}={}){
 const calls=[],source={corpId,userId:'123456',profile:corpId+':123456'};
 const c=createMinutesClient(source,{resolveEmployeeIdentity:resolve,run:async(binary,args)=>{
  calls.push(args);const payload=args.includes('get-self')?{result:[{orgEmployeeModel:{corpId,userId:'123456',orgUserMobile:'13800138000',stateCode:'86'}}]}:{result:Array.isArray(detail)?detail:[{orgEmployeeModel:detail}]};
  return {stdout:JSON.stringify({success:true,...payload})};
 }});
 return {c,calls,expected:{corpId:'dingPrimary',userId:'123456',unionId:'bound-union'}};
}
test('本人编号与企业编号相同时，经同组织本人详情核验，避免不必要的手机号反查',async()=>{
 const {c,calls,expected}=setup({resolve:()=>assert.fail('should not query mobile')});assert.deepEqual(await c.employeeIdentity(expected),{corpId:'dingPrimary',userId:'123456'});
 assert.equal(calls.length,2);assert.deepEqual(calls[1].slice(0,5),['contact','user','get','--ids','123456']);
 for(const args of calls)assert.equal(args[args.indexOf('--profile')+1],'dingPrimary:123456');
});
test('相同文本不跳过身份映射，其他企业成员、其他组织和不同本人编号均拒绝',async()=>{
 for(const detail of [{orgId:123,orgUserId:'another-member'},{orgId:123,orgUserId:'123456',corpId:'dingOther'},{orgId:123,orgUserId:'123456',userId:'different-self'}]){
  const {c,expected}=setup({detail,resolve:()=>assert.fail('should not fall back after contradictory proof')});await assert.rejects(()=>c.employeeIdentity(expected),e=>e.status===403&&e.code==='MINUTES_ACCOUNT_MISMATCH');
 }
});
test('本人详情为空、多条或缺少企业成员编号时不放行，也不按名字或手机号猜身份',async()=>{
 for(const detail of [[],[{orgEmployeeModel:{orgId:1,orgUserId:'123456'}},{orgEmployeeModel:{orgId:1,orgUserId:'123456'}}],{orgId:123},{orgId:123,orgUserId:''}]){
  const {c,expected}=setup({detail,resolve:()=>assert.fail('should not bypass incomplete evidence')});await assert.rejects(()=>c.employeeIdentity(expected),e=>e.status===502&&e.code==='MINUTES_MEMBER_IDENTITY');
 }
});
test('跨组织相同编号仍使用原来的企业身份桥接，不以相同文本跨组织放行',async()=>{
 let resolved=0;const {c,calls,expected}=setup({corpId:'dingOther',resolve:async(e,x)=>{resolved++;assert.equal(x.corpId,'dingOther');return {...e};}});
 assert.deepEqual(await c.employeeIdentity(expected),{corpId:'dingPrimary',userId:'123456'});assert.equal(resolved,1);assert.equal(calls.length,1);
});
