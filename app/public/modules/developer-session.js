import { esc, icon } from '../ui.js';
import {presenceControl} from './developer-presence.js';

const roleName = role => ({admin:'管理员',sales:'销售',pm:'协作PM'}[role] || role);
export function sessionControl(S) {
  const {users} = S.developer;
  const label = user => `${user.name} · ${roleName(user.role)}`;
  return `<div class="developer-session-controls" aria-label="身份与会话">
    <span class="developer-session-label">开发者模式</span>
    <details class="developer-identity-select" id="developer-picker">
      <summary aria-label="开发者切换身份" aria-haspopup="listbox"><span>${esc(label(S.actor))}</span>${icon('down')}</summary>
      <div class="developer-identity-popover"><input type="search" id="developer-search" aria-label="搜索切换身份" placeholder="搜索姓名或角色" autocomplete="off">
        <div role="listbox" aria-label="可切换用户">${users.map(user=>`<button type="button" role="option" aria-selected="${user.id===S.actor.id}" data-action="developer-select" data-id="${user.id}" data-identity-label="${esc(label(user))}"><span>${esc(label(user))}</span>${user.id===S.actor.id?icon('check'):''}</button>`).join('')}</div><p class="developer-no-results" hidden>没有匹配的用户</p>
      </div>
    </details>
    ${presenceControl()}
    <button type="button" class="btn ghost" data-action="logout">退出登录</button>
  </div>`;
}

export function bindIdentityPicker() {
  const picker=document.querySelector('#developer-picker');
  if(!picker)return;
  const input=picker.querySelector('input');
  picker.addEventListener('toggle',()=>{if(picker.open)input.focus();});
  input.addEventListener('input',()=>{
    const query=input.value.trim().toLocaleLowerCase();
    const options=[...picker.querySelectorAll('[role=option]')];
    for(const option of options)option.hidden=!option.dataset.identityLabel.toLocaleLowerCase().includes(query);
    picker.querySelector('.developer-no-results').hidden=options.some(option=>!option.hidden);
  });
  picker.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();picker.open=false;picker.querySelector('summary').focus();return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    const options=[...picker.querySelectorAll('[role=option]:not([hidden])')];
    if(!options.length)return;
    event.preventDefault();
    const index=options.indexOf(document.activeElement);
    const next=event.key==='Home'?0:event.key==='End'?options.length-1:event.key==='ArrowDown'?(index+1)%options.length:(index<0?options.length-1:(index+options.length-1)%options.length);
    options[next].focus();
  });
}
