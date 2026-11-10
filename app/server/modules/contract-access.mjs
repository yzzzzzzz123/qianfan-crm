import {assert} from '../domain.mjs';

// Always authorize against the current database owner, including nested saves.
export function editableContract(ctx,id){
 const c=ctx.scoped('contracts',id,ctx.actor);
 assert(ctx.actor.role==='admin'||ctx.actor.role==='sales'&&c.owner_id===ctx.actor.id,'仅管理员或合同所属销售可编辑',403);
 return c;
}
