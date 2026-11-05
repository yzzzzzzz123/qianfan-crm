import test from 'node:test';
import assert from 'node:assert/strict';
import {personalAuthorization,registerPersonalClient,exchangePersonalCode,boundedText,savePersonalTokens,loadPersonalTokens} from '../server/modules/minutes/personal-oauth.mjs';
import {parseMcpResponse,createPersonalTransport} from '../server/modules/minutes/personal-transport.mjs';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('个人听记仅请求官方个人只读范围，PKCE 与随机状态每轮独立',()=>{
 const client={clientId:'public-client',redirectUri:'http://127.0.0.1:3100/callback'},a=personalAuthorization(client),b=personalAuthorization(client),url=new URL(a.url);
 assert.equal(url.origin,'https://minutes.qwennote.cn');assert.equal(url.searchParams.get('scope'),'qwennote:read');assert.equal(url.searchParams.get('code_challenge'),createHash('sha256').update(a.verifier).digest('base64url'));assert.notEqual(a.state,b.state);assert.notEqual(a.verifier,b.verifier);assert(!url.searchParams.has('corpId'));
});
test('个人授权拒绝外部 HTTP 回调和上游扩大权限',async()=>{
 await assert.rejects(()=>registerPersonalClient('http://external.test/callback'),/回调地址无效/);
 const flow=personalAuthorization({clientId:'client',redirectUri:'http://127.0.0.1:3100/callback'});
 await assert.rejects(()=>exchangePersonalCode(flow,'code',{fetchImpl:async()=>Response.json({access_token:'fake-token',token_type:'Bearer',expires_in:3600,scope:'qwennote:read qwennote:write'})}),/未请求的权限/);
});
test('个人 MCP 流式限额在读取过程中取消，兼容缺失长度头',async()=>{
 let reads=0,cancelled=false;const response=new Response(new ReadableStream({pull(controller){reads++;controller.enqueue(new Uint8Array(1024));},cancel(){cancelled=true;}}));
 await assert.rejects(()=>boundedText(response,1500),/安全限额/);assert(cancelled);assert(reads<=4);
});
test('个人 MCP JSON 与 SSE 只取当前 JSON-RPC 回执，不透传源错误正文',()=>{
 assert.deepEqual(parseMcpResponse('{"jsonrpc":"2.0","id":4,"result":{"tools":[]}}',4),{tools:[]});
 assert.deepEqual(parseMcpResponse('event: message\ndata: {"jsonrpc":"2.0","id":4,"result":{"tools":[]}}\n\n',4),{tools:[]});
 assert.throws(()=>parseMcpResponse('{"jsonrpc":"2.0","id":4,"error":{"message":"secret-token"}}',4),error=>!error.message.includes('secret-token'));
});
test('个人 MCP 只读白名单拒绝修改工具，未访问网络',async()=>{
 let calls=0;const client=createPersonalTransport({allowedReadTools:['verified-list'],fetchImpl:async()=>{calls++;throw new Error();}});
 await assert.rejects(()=>client.callReadTool('delete-minutes',{}),/只读范围/);assert.equal(calls,0);
});
test('个人 MCP 初始化与 token 续期在并发时各执行一次',async()=>{
 let refreshes=0,initializes=0,stored={accessToken:'expired-fake',refreshToken:'refresh-fake',expiresAt:0};
 const client=createPersonalTransport({credentialDir:'isolated-fixture',load:async()=>stored,save:async(_dir,value)=>{stored=value;},refresh:async value=>{refreshes++;return {...value,accessToken:'new-fake',expiresAt:Date.now()+3600000};},fetchImpl:async(_url,options)=>{const b=JSON.parse(options.body);if(b.method==='notifications/initialized')return new Response(null,{status:202});if(b.method==='initialize')initializes++;return Response.json({jsonrpc:'2.0',id:b.id,result:b.method==='initialize'?{protocolVersion:'2025-03-26'}:{tools:[]}});}});
 await Promise.all([client.tools(),client.tools()]);assert.equal(refreshes,1);assert.equal(initializes,1);
});

test('迟到的旧 token 401 不重复轮换已经更新的个人授权',async()=>{
 let stored={accessToken:'old-fake',refreshToken:'refresh-fake',expiresAt:Date.now()+3600000},refreshes=0,releaseLate;
 const late=new Promise(resolve=>releaseLate=resolve);let listCalls=0;
 const client=createPersonalTransport({credentialDir:'late-401-fixture',load:async()=>stored,save:async(_dir,value)=>stored=value,refresh:async value=>{refreshes++;return {...value,accessToken:'new-fake'};},fetchImpl:async(_url,options)=>{
  const b=JSON.parse(options.body);
  if(b.method==='notifications/initialized')return new Response(null,{status:202});
  if(b.method==='initialize')return Response.json({jsonrpc:'2.0',id:b.id,result:{protocolVersion:'2025-03-26'}});
  if(options.headers.authorization==='Bearer old-fake'){listCalls++;if(listCalls===2)await late;return new Response(null,{status:401});}
  return Response.json({jsonrpc:'2.0',id:b.id,result:{tools:[]}});
 }});
 const first=client.tools(),second=client.tools();await first;releaseLate();await second;assert.equal(refreshes,1);
});

test('个人授权凭据使用本机保护往返读取，落盘不含令牌，损坏密文拒绝读取',async t=>{
 const base=await realpath(tmpdir()),directory=await mkdtemp(path.join(base,'qf-personal-oauth-test-'));
 t.after(async()=>{const resolved=await realpath(directory);assert.equal(path.dirname(resolved),base);assert(path.basename(resolved).startsWith('qf-personal-oauth-test-'));await rm(resolved,{recursive:true,force:true});});
 const value={accessToken:'test-only-access-9762',refreshToken:'test-only-refresh-4280',memberId:3};
 await savePersonalTokens(directory,value);assert.deepEqual(await loadPersonalTokens(directory),value);
 const filename=path.join(directory,'personal-oauth.json'),raw=await readFile(filename,'utf8');assert(!raw.includes(value.accessToken));assert(!raw.includes(value.refreshToken));
 const envelope=JSON.parse(raw);envelope.data='AAAA';await writeFile(filename,JSON.stringify(envelope));
 await assert.rejects(()=>loadPersonalTokens(directory),error=>error.code==='PERSONAL_STORAGE'&&!error.message.includes(value.accessToken));
});
