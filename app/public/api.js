let csrf = "";
export const basePath=import.meta.url.startsWith('file:')?'/':new URL('.',import.meta.url).pathname;
const simulationKey=basePath==='/'?'qf_act_as':'qf_act_as:'+basePath;
export function simulationIdentity() {
  try { return sessionStorage.getItem(simulationKey) || ''; } catch { return ''; }
}
export function setSimulationIdentity(id) {
  try { if(id)sessionStorage.setItem(simulationKey,String(id));else sessionStorage.removeItem(simulationKey); }
  catch { if(id)throw new Error('当前浏览器无法保存测试身份，请允许当前页面使用会话存储后重试。'); }
}
export function setCsrf(value) {
  csrf = value || "";
}
export async function api(path, { method = "GET", body, key } = {}) {
  const simulated=!path.startsWith('/auth/')&&!path.startsWith('/developer/')?simulationIdentity():'';
  const response = await fetch(basePath+"api" + path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(simulated?{'X-CRM-Act-As':simulated}:{}),
      ...(method !== "GET"
        ? {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf,
            "Idempotency-Key": key || crypto.randomUUID(),
          }
        : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("服务返回异常，请稍后重试");
  }
  if (!response.ok) {
    if(method==='GET'&&path.split('?')[0]==='/state'&&simulated&&result.code?.startsWith('DEVELOPER_')) {
      setSimulationIdentity('');
      return api(path,{method,body,key});
    }
    if(response.status===401)setSimulationIdentity('');
    const e = new Error(result.error || "操作失败，请重试");
    e.status = response.status;
    e.code = result.code;
    e.requestId = result.requestId;
    throw e;
  }
  return result;
}
