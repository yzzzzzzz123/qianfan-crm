import test from 'node:test';
import assert from 'node:assert/strict';
import {createTranscriptReader} from '../server/modules/minutes/transcript.mjs';
import {minuteArtifact} from '../public/modules/minutes-artifacts.js';

const complete=(id,text='完整正文')=>({data:{taskUuid:id,complete:true,direction:'0',pages:8,paragraphCount:1,paragraphList:[{paragraphId:1,nickName:'发言人',paragraph:text,startTime:0}]},meta:{pagination:{endpoint_exhausted:true}}});
test('完整逐字稿支持多页确认，旧失败可以重新读取，禁止把不完整页当全文',async()=>{
 let calls=0;const read=createTranscriptReader(async()=>{calls++;return complete('record');});
 assert.equal((await read('record')).content,'发言人：完整正文');assert.equal(calls,1);
 const wrong=createTranscriptReader(async args=>args[1]==='+transcript'?complete('other-record'):{result:{paragraphList:[]}});
 assert.equal((await wrong('record')).state,'failed');
});
test('钉钉省略段落正文时使用实际句子，空白句不使完整八页听记整体失败',async()=>{
 const response=complete('record');response.data.paragraphList.push({paragraphId:2,nickName:'发言人',startTime:100,sentenceList:[{sentence:' ',wordList:[]}]},{paragraphId:3,nickName:'客户',startTime:200,sentenceList:[{sentence:'实际句子一。'},{sentence:'实际句子二。'}]});response.data.paragraphCount=3;
 const read=createTranscriptReader(async()=>response),a=await read('record');assert.equal(a.state,'ready');assert.equal(a.content,'发言人：完整正文\n\n客户：实际句子一。实际句子二。');
});
test('真实通话听记的空对象识别为源未提供，不再误报分页失败；未知响应仍不编造正文',async()=>{
 const read=createTranscriptReader(async args=>{if(args[1]==='+transcript')throw new Error('incomplete first page');return {result:{}};});
 const a=await read('voice-call');assert.equal(a.state,'empty');assert.equal(a.content,'');assert.match(a.reason,/钉钉本次未提供/);
 const unknown=createTranscriptReader(async args=>{if(args[1]==='+transcript')throw new Error('failure');return {result:{unreviewedField:'fragment'}};});
 assert.equal((await unknown('record')).state,'failed');
});
test('初次完整读取瞬时失败时重新读取全部分页，不直接保存原子接口首屏',async()=>{
 let full=0;const read=createTranscriptReader(async args=>{if(args[1]==='+transcript'){if(++full===1)throw new Error('transient');return complete('record');}return {result:{paragraphList:[{paragraph:'第一屏片段'}],hasNext:true}};});
 assert.equal((await read('record')).content,'发言人：完整正文');assert.equal(full,2);
});
test('逐字稿缺失时清楚标注已有总结，保留转义并提供显式重读入口',()=>{
 const html=minuteArtifact('transcript',{state:'empty',content:'',reason:'钉钉本次未提供逐字稿正文'},1,true,'transcript',{state:'ready',content:'<script>总结</script>'});
 assert.match(html,/以下为已同步的 AI 总结/);assert.match(html,/&lt;script&gt;/);assert.match(html,/data-action="minutes-artifact-retry"/);assert.doesNotMatch(html,/该项尚无可展示正文/);
});
