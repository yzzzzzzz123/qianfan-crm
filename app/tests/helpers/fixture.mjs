import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import {run} from '../../server/database.mjs';
import { createApp } from "../../server/index.mjs";
import { today, dateAdd } from "../../server/domain.mjs";

export async function fixture(t, options = {}) {
  const app = createApp({ demo: true, logger: { error() {} }, ...options });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.service.minutes.shutdown();
    await new Promise((r) => app.server.close(r));
    app.db.close();
  });
  async function request(
    p,
    { actor, method = "GET", body, key, headers = {} } = {},
  ) {
    const r = await fetch(base + "/api" + p, {
      method,
      headers: {
        ...(actor ? { Cookie: actor.cookie, "X-CSRF-Token": actor.csrf } : {}),
        ...(method !== "GET"
          ? {
              "Content-Type": "application/json",
              "Idempotency-Key": key || randomUUID(),
            }
          : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: r.status,
      body: await r.json(),
      cookie: r.headers.get("set-cookie"),
    };
  }
  async function login(id) {
    const r = await request("/auth/login", {
      method: "POST",
      body: { demo_user_id: id },
    });
    assert.equal(r.status, 200);
    return { cookie: r.cookie.split(";")[0], csrf: r.body.csrf };
  }
  return { ...app, request, login, base };
}
export const customer = (extra = {}) => ({
  name: "核验客户有限公司",
  industry: "智能制造",
  region: "广东",
  owner_id: 1,
  ...extra,
});
export const opp = (customer_id, extra = {}) => ({
  customer_id,
  name: "核验商机",
  amount: "100000.00",
  product_amount: 0,
  stage: "线索",
  sale_type: "新签自建",
  order_type: "代销",
  next_action: "确认需求范围",
  follow_date: dateAdd(2),
  ...extra,
});
export const contract = (opportunity_id, extra = {}) => ({
  opportunity_id,
  name: "核验合同",
  sign_date: today(),
  items: [{ name: "授权", kind: "标品", amount: 100000 }],
  ...extra,
});
export async function archiveContract(f,actor,id){
  const content=Buffer.from('%PDF-1.4\nIsolated signed fixture '+randomUUID());
  const attachment=Number(run(f.db,'INSERT INTO attachments(entity,entity_id,filename,mime_type,size,sha256,content,created_at) VALUES(?,?,?,?,?,?,?,?)','contract',id,'测试双方盖章合同.pdf','application/pdf',content.length,createHash('sha256').update(content).digest('hex'),content,new Date().toISOString()).lastInsertRowid);
  const result=await f.request(`/contracts/${id}/archive`,{actor,method:'POST',body:{both_stamped:true,archive_attachment_id:attachment}});
  assert.equal(result.status,200,JSON.stringify(result.body));return result;
}
