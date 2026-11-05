// Required fields apply to new records. Historical unknown values are preserved without guesses.
export function migrateRequiredCash(db) {
  if(db.prepare('SELECT 1 FROM schema_version WHERE version=11').get())return;
  const invalidCash="typeof(NEW.product_amount)<>'integer' OR NEW.product_amount<0 OR NEW.product_amount>NEW.amount";
  const triggers=[
    {name:'opportunities_required_cash_insert',operation:'INSERT',condition:`NEW.product_amount IS NULL OR ${invalidCash}`,message:'CRM opportunity cash amount is required and must be between zero and total amount'},
    {name:'opportunities_required_cash_update',operation:'UPDATE',condition:`(NEW.product_amount IS NULL AND OLD.product_amount IS NOT NULL) OR (NEW.product_amount IS NOT NULL AND (${invalidCash}))`,message:'CRM opportunity known cash amount cannot be cleared and must be between zero and total amount'},
    {name:'opportunities_required_classification_update',operation:'UPDATE',condition:'(NEW.sale_type IS NULL AND OLD.sale_type IS NOT NULL) OR (NEW.order_type IS NULL AND OLD.order_type IS NOT NULL)',message:'CRM opportunity known sale_type and order_type cannot be cleared'},
  ].map(t=>({...t,sql:`CREATE TRIGGER ${t.name} BEFORE ${t.operation} ON opportunities WHEN ${t.condition} BEGIN SELECT RAISE(ABORT,'${t.message}'); END`}));
  db.exec('BEGIN IMMEDIATE');
  try {
    for(const trigger of triggers){
      if(trigger.name==='opportunities_required_classification_update')db.exec('DROP TRIGGER IF EXISTS '+trigger.name);
      db.exec(trigger.sql);
    }
    db.exec('UPDATE workspace_revision SET revision=revision+1 WHERE id=1');
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('cash金额约束升级外键检查失败');
    db.exec('INSERT INTO schema_version VALUES(11); COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}
