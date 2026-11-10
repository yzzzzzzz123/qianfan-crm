import {assert} from './domain.mjs';

// During the initial rollout, sales maintain the ledger for their own contracts.
// Record ownership is always checked in addition to this role capability.
export const canManageContractData=actor=>['admin','sales'].includes(actor?.role);

export function assertContractDataAccess(actor,contract){
  assert(canManageContractData(actor),'当前角色不能维护合同与回款资料',403);
  if(contract)assert(actor.role==='admin'||contract.owner_id===actor.id,'无权维护其他销售的合同资料',403);
}

export const isContractCorrectionRoute=path=>/^\/api\/(?:contracts(?:\/\d+(?:\/(?:maintenance|archive|attachments|termination|termination-request))?)?|items\/\d+|payments(?:\/\d+(?:\/(?:details|allocation|receive|reconcile|checkpoint|void-plan|reopen))?)?)$/.test(path);
