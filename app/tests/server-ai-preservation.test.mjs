import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {serverAIEnvironment} from '../server/server-config.mjs';
import {withQwenCompanyFallback} from '../server/company-profile-fallback.mjs';

test('已有服务器AI配置显式选择原提供方，调用地址、模型和协议同时保持',()=>{
  const config={provider:'ppio',model:'qwen/qwen3.8-max',base_url:'https://api.ppio.com/openai/v1',apiKey:'isolated-server-ai-test-key',python_executable:'/srv/qianfan-crm/runtime/intake-venv/bin/python3'};
  const env=serverAIEnvironment(config);
  assert.equal(env.CRM_AI_PROVIDER,'ppio');assert.equal(env.AI_API_KEY,config.apiKey);assert.equal(env.PPIO_SEARCH_API_KEY,config.apiKey);
  for(const patch of [{provider:'other'},{model:'deepseek-v4-1-flash'},{base_url:'https://other.invalid'}])assert.throws(()=>serverAIEnvironment({...config,...patch}));
  const result=spawnSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import {AI_MODEL,AI_ENDPOINT,createIntakeAI} from './server/ai-intake.mjs';
    import {createSalesAdviceAI} from './server/sales-advice.mjs';
    assert.equal(AI_MODEL,'qwen/qwen3.8-max');assert.equal(AI_ENDPOINT,'https://api.ppio.com/openai/v1/chat/completions');
    const sent=[];
    const fetcher=async(url,options)=>{const body=JSON.parse(options.body);sent.push(body);assert.equal(url,AI_ENDPOINT);assert.equal(body.model,AI_MODEL);assert.equal(body.reasoning_effort,'none');assert.equal(body.thinking,undefined);assert.equal(options.redirect,'error');return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({summary:'隔离验证',questions:[],operations:[]})}}]})};};
    const ai=createIntakeAI({env:process.env,fetcher});await ai.prepare({text:'隔离资料'},{today:'2026-11-12',actor:{id:1},records:{}});assert.equal(sent.length,1);
    assert.equal(createSalesAdviceAI({env:process.env,fetcher}).model,AI_MODEL);
  `],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,...env,CRM_RUNTIME_ENVIRONMENT:'server'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

test('本地默认模型与服务器配置隔离，企业资料标注使用实际调用模型',async()=>{
  const result=spawnSync(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import {AI_MODEL,AI_ENDPOINT,AI_REQUEST_OPTIONS} from './server/ai-intake.mjs';assert.equal(AI_MODEL,'deepseek-v4-1-flash');assert.equal(AI_ENDPOINT,'https://aiclub.zimaocloud.com/model/openApi/v1/chat/completions');assert.deepEqual(AI_REQUEST_OPTIONS,{thinking:{type:'disabled'}});`],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:{...process.env,CRM_RUNTIME_ENVIRONMENT:'local',CRM_AI_PROVIDER:'ppio'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const fallback={configured:true,model:'qwen/qwen3.8-max',lookup:async()=>({details:{company_description:'公开原文摘录'},field_sources:{company_description:'qwen'},sources:[],reason:'隔离验证'})};
  const value=await withQwenCompanyFallback({configured:false},{fallback}).lookup({name:'隔离企业'});
  assert.equal(value.details._lookup.kind,'qwen');assert.match(value.provider,/Qwen/);assert.doesNotMatch(value.provider,/DeepSeek/);
});
