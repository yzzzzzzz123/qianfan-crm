import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDeviceFlow,initializeMinutesAuthorization,minutesConnectorError,gatewayEnvironment,publicAuthorizationError} from '../server/modules/minutes/device-flow.mjs';

async function isolated(t){const root=await mkdtemp(path.join(tmpdir(),'crm-auth-'));t.after(async()=>{assert.equal(path.dirname(await realpath(root)),await realpath(tmpdir()));assert.ok(path.basename(root).startsWith('crm-auth-'));await rm(root,{recursive:true,force:true});});return root;}

test('新授权目录显式为空账号表，阻止默认带入本机旧登录；已有凭据不覆盖',async t=>{
 const root=await isolated(t);await initializeMinutesAuthorization(root);const file=path.join(root,'profiles.json');assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{version:2,currentProfile:'',orgCurrentProfiles:{},profiles:[]});
 const saved=JSON.stringify({version:2,currentProfile:'dingKnown:1',profiles:[{corpId:'dingKnown',userId:'1'}]});await writeFile(file,saved);await initializeMinutesAuthorization(root);assert.equal(await readFile(file,'utf8'),saved);
 const env=gatewayEnvironment(root);assert.equal(env.DWS_CONFIG_DIR,root);assert.equal(env.DWS_KEYCHAIN_DIR,path.join(root,'keychain'));assert.equal(env.DWS_KEYCHAIN_TEST_NAMESPACE,undefined);
});

test('真实子进程失败按原因分类，未识别错误不猜组织权限，不泄露原始账号或凭据',async t=>{
 const root=await isolated(t);let child,options;
 const begin=createDeviceFlow({binary:path.join(root,'dws'),spawnImpl:(binary,args,opts)=>{options=opts;child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};return child;}});
 const control=await begin({credentialDir:root,onPrompt(){},onVerifying(){}});
 assert.deepEqual(JSON.parse(await readFile(path.join(root,'profiles.json'),'utf8')).profiles,[]);assert.equal(options.env.DWS_CONFIG_DIR,root);
 const denied=assert.rejects(control.completion,e=>e.code==='MINUTES_ORG_NOT_AUTHORIZED'&&!e.message.includes('SECRET')&&!e.message.includes('其他账号'));
 child.stdout.write(JSON.stringify({success:false,error:{code:'CLI_ORG_NOT_AUTHORIZED',access_token:'SECRET',user_name:'其他账号'}}));child.emit('close',1);await denied;
 const cases=[['expired_token','MINUTES_AUTH_EXPIRED'],['access_denied','MINUTES_AUTH_DENIED'],['您暂无 CLI 数据访问权限','MINUTES_CLI_ACCESS_DENIED'],['CLI_USER_NOT_AUTHORIZED','MINUTES_MEMBER_NOT_AUTHORIZED'],['当前渠道 test 未获得该组织授权','MINUTES_CHANNEL_NOT_AUTHORIZED'],['检查 CLI 授权状态失败: timeout','MINUTES_AUTH_NETWORK'],['保存 token 失败','MINUTES_CREDENTIAL_SAVE']];
 for(const [input,code] of cases)assert.equal(minutesConnectorError(input,{authorization:true}).code,code);
 const unknown=minutesConnectorError('授权码将在600秒后过期\nunknown failure SECRET',{authorization:true});assert.equal(unknown.code,'DEVICE_AUTH_FAILED');assert.doesNotMatch(unknown.message,/可能被取消|组织尚未开通|SECRET/);
});

test('未获得账号身份时的CLI拒绝不推断CRM成员权限，旧错误仅修正展示不改原记录',()=>{
 const e=minutesConnectorError('您暂无 CLI 数据访问权限\n当前组织未授权您通过 CLI 访问个人数据。\n组织主管理员：其他账号 SECRET',{authorization:true});
 assert.equal(e.code,'MINUTES_CLI_ACCESS_DENIED');assert.match(e.message,/实际听记账号及其所属组织/);assert.doesNotMatch(e.message,/当前成员|千帆|暮雪|其他账号|SECRET/);
 const old='所选钉钉组织尚未给当前成员开通 CLI 数据访问权限，请该组织管理员授权后重试（MINUTES_MEMBER_NOT_AUTHORIZED）';assert.equal(publicAuthorizationError(old),e.message);
 assert.match(publicAuthorizationError('钉钉授权未完成，可能被取消、过期或组织尚未开通访问权限，请重新授权或核对组织权限'),/旧版本未保留具体错误原因/);
});
