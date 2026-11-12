import test from 'node:test';
import assert from 'node:assert/strict';
import {intakeSchema,intakeStorage,fieldNames} from '../public/modules/intake-schema.js';
import {guideFields} from '../public/modules/intake-guide.js';
import {filtered} from '../public/modules/shared.js';
import {renderPage,customerDetail} from '../public/views.js';

const state=()=>({
 actor:{id:1,name:'管理员',role:'admin'},today:'2026-11-02',
 users:[{id:1,name:'管理员',active:1,role:'admin'}],rules:{customer_levels:['A','B']},
 customers:[
  {id:1,name:'手动A客户',owner_id:1,manual_level:'A',level:'旧等级B',status:'潜在',sources:[]},
  {id:2,name:'未标注客户',owner_id:1,manual_level:null,level:'A',status:'潜在',sources:[]},
 ],opportunities:[],contracts:[],activities:[],activityEvents:[],team:[],contacts:[],
});

test('退役字段退出AI新增修改、存储协议与角色指南，现行等级及项目状态保留',()=>{
 for(const [type,field] of [['customer','level'],['contract','accept_status'],['contract','recurring_amount'],['contract','auto_renew']]){
  const definition=intakeSchema[type];
  assert.ok(!definition.fields.split(' ').includes(field));
  assert.ok(!definition.createFields.includes(field));
  assert.ok(!definition.updateFields.includes(field));
  assert.ok(!Object.hasOwn(intakeStorage[type],field));
  assert.ok(!Object.hasOwn(fieldNames,field));
 }
 assert.ok(intakeSchema.customer.updateFields.includes('manual_level'));
 assert.ok(guideFields('contract','pm').optional.includes('project_status'));
 assert.ok(!guideFields('contract','pm').optional.includes('accept_status'));
 for(const field of ['renewal_tag','valid_until'])assert.ok(intakeSchema.contract.fields.split(' ').includes(field));
});

test('当前客户筛选只使用手动等级，不把来源旧等级当成当前标签',()=>{
 const S=state();
 assert.deepEqual(filtered(S,{level:'A'},S.customers).map(c=>c.id),[1]);
 const html=renderPage(S,{view:'customers',level:'A',q:''});
 assert.match(html,/手动A客户/);
 assert.doesNotMatch(html,/未标注客户/);
});

test('客户资产分级使用手动等级，并让未标注客户保持未填写',()=>{
 const html=renderPage(state(),{view:'assets'});
 const distribution=html.match(/<details class="management-structure">\s*<summary>客户分级[^]*?<ul>([^]*?)<\/ul>/)?.[1];
 assert.ok(distribution);
 assert.match(distribution,/>A <b>1 家/);
 assert.match(distribution,/>未填写 <b>1 家/);
 assert.doesNotMatch(distribution,/旧等级/);
});

test('客户详情不再重复呈现旧等级，不影响当前人工标签',()=>{
 const html=customerDetail(state(),1);
 assert.match(html,/手动A客户/);
 assert.match(html,/>A<\/span>/);
 assert.doesNotMatch(html,/历史等级|旧等级B/);
});
