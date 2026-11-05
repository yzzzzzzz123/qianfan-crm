import test from 'node:test';
import assert from 'node:assert/strict';
import {recognizeMinutes} from '../server/modules/minutes/recognition.mjs';
test('活动认定必须有准确标签、录音存在证据和有效销售身份，未知或冲突不计入',()=>{
 const base={tags:['visit-id'],verified:true,recording:true,member:{role:'sales',active:1,business_member:1,developer_admin:0},config:{visitTagIds:['visit-id'],demoTagIds:['demo-id']}};
 assert.equal(recognizeMinutes(base).type,'visit');assert.equal(recognizeMinutes({...base,tags:['demo-id']}).type,'demo');
 for(const change of [{verified:false},{recording:false},{tags:[]},{tags:['visit-id','demo-id']},{config:{}},{member:{...base.member,role:'admin'}},{member:{...base.member,developer_admin:1}},{member:{...base.member,active:0}}])assert.equal(recognizeMinutes({...base,...change}).type,'none');
});
