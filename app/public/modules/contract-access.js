export const canManageContractData=S=>['admin','sales'].includes(S?.actor?.role);
export const canManageContract=(S,c)=>!!c&&canManageContractData(S)&&(S.actor.role==='admin'||Number(c.owner_id)===Number(S.actor.id));
