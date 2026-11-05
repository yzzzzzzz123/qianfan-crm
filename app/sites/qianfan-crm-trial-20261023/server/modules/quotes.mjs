import { text, cents, validDate, now } from "../domain.mjs";

/** quotes: unmatched routes return undefined; transaction and idempotency are owned by service.mjs. */
export function handleQuotes(context) {
  const { path, method, b, actor, insert, scoped, audit } = context;
  if (path === "/api/quotes" && method === "POST") {
    const o = scoped("opportunities", b.opportunity_id, actor);
    const id = insert("quotes", {
      opportunity_id: o.id,
      user_id: o.owner_id,
      amount: cents(b.amount, "报价金额"),
      valid_until: validDate(b.valid_until, "报价有效期"),
      note: text(b.note || "", "报价说明", 2000, false),
      created_at: now(),
    });
    audit(actor, "登记报价", "opportunity", o.id, { quote_id: id });
    return { id, message: "报价已登记，正式模板待提供" };
  }
}
