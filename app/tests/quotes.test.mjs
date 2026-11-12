import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from 'node:crypto';
import { fixture } from "./helpers/fixture.mjs";
import { dateAdd } from "../server/domain.mjs";

test("M05-A01 登记报价保存金额有效期并进入过程计数，不自动改变阶段", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(2);
  const before = (await f.request("/state", { actor })).body;
  const r = await f.request("/quotes", {
    actor,
    method: "POST",
    body: {
      opportunity_id: 1,
      amount: 9800,
      items: [{ name:'产品授权',kind:'标品',quantity:1,list_price:10000,discount_rate:0.98 }],
      valid_until: dateAdd(15),
      note: "报价说明",
    },
  });
  assert.equal(r.status, 200);
  const s = (await f.request("/state", { actor })).body;
  const q = s.quotes.find((q) => q.id === r.body.id);
  assert.equal(q.amount, 980000);
  assert.equal(q.list_amount, 1000000);
  assert.equal(q.discount_amount, 20000);
  assert.equal(q.items.length, 1);
  assert.equal(q.valid_until, dateAdd(15));
  assert.equal(q.note, "报价说明");
  assert.ok(q.code.startsWith("BJ"));
  assert.equal(s.team[0].process.quote, before.team[0].process.quote + 1);
  assert.equal(
    s.opportunities.find((o) => o.id === 1).stage,
    before.opportunities.find((o) => o.id === 1).stage,
  );
});
test("M05-A02 他人商机报价与非法有效日期被拒绝", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(2);
  const b = { opportunity_id: 3, items: [{name:'实施服务',kind:'实施',quantity:1,list_price:10000,discount_rate:1}], valid_until: dateAdd(15) };
  assert.equal(
    (await f.request("/quotes", { actor, method: "POST", body: b })).status,
    403,
  );
  assert.equal(
    (
      await f.request("/quotes", {
        actor,
        method: "POST",
        body: { ...b, opportunity_id: 1, valid_until: "2026-02-31" },
      })
    ).status,
    400,
  );
});

test("商机报价可选传附件并省略有效期，附件沿用报价权限", async (t) => {
  const f = await fixture(t);
  const sales = await f.login(2);
  const otherSales = await f.login(3);
  const admin = await f.login(1);
  const file = {
    name: '报价原件.pdf',
    base64: Buffer.concat([Buffer.from('%PDF-1.4\n报价原件'),Buffer.alloc(1024*1024,32)]).toString('base64'),
  };
  const body = {
    opportunity_id: 1,
    items: [{name:'产品授权',kind:'标品',quantity:1,list_price:1234}],
    file,
  };
  const request = { actor: sales, method:'POST', body, key:randomUUID() };
  const created = await f.request('/quotes', request);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.ok(created.body.attachment_id > 0);
  assert.deepEqual((await f.request('/quotes', request)).body, created.body);

  const {id,attachment_id: attachmentId} = created.body;
  const state = (await f.request('/state',{actor:sales})).body;
  const quote = state.quotes.find(q => q.id === id);
  assert.equal(quote.valid_until, '');
  assert.deepEqual(quote.attachments.map(a => ({id:a.id,filename:a.filename})), [{id:attachmentId,filename:file.name}]);
  assert.equal(quote.attachments[0].size, Buffer.from(file.base64,'base64').length);
  assert.equal(quote.attachments[0].base64, undefined);
  const attachmentPath = '/attachments/'+attachmentId;
  for (const actor of [sales,admin]) {
    const download = await f.request(attachmentPath,{actor});
    assert.equal(download.status, 200);
    assert.deepEqual(download.body,{filename:file.name,mime_type:'application/pdf',base64:file.base64});
  }
  assert.equal((await f.request(attachmentPath,{actor:otherSales})).status, 403);
  const otherState = (await f.request('/state',{actor:otherSales})).body;
  assert.ok(otherState.quotes.every(q => q.id !== id));

  const document = await f.request('/documents/quote/'+id,{actor:sales});
  assert.equal(document.status, 200);
  assert.doesNotMatch(document.body.html,/有效期/);

  const plain = await f.request('/quotes',{actor:sales,method:'POST',body:{opportunity_id:1,items:body.items}});
  assert.equal(plain.status, 200);
  const updated = (await f.request('/state',{actor:sales})).body;
  assert.deepEqual(updated.quotes.find(q => q.id === plain.body.id).attachments, []);
});

test("文件格式校验失败时整笔报价回滚", async (t) => {
  const f = await fixture(t);
  const actor = await f.login(2);
  const count = (table) => f.db.prepare('SELECT COUNT(*) AS total FROM '+table).get().total;
  const tables = ['quotes','attachments','audit'];
  const before = tables.map(count);
  const rejected = await f.request('/quotes',{
    actor,method:'POST',
    body:{
      opportunity_id:1,
      items:[{name:'产品授权',kind:'标品',quantity:1,list_price:1234}],
      file:{name:'报价原件.pdf',base64:Buffer.from('plain text').toString('base64')},
    },
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error,/PDF附件内容与文件类型不符/);
  assert.deepEqual(tables.map(count), before);
});
