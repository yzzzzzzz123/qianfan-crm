import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import DatePicker from '@arco-design/web-react/es/DatePicker/index.js';
import '@arco-design/web-react/es/DatePicker/style/css.js';
import './minutes-date-range.css';

function MinutesDateRange({value,onChange,popup}){
  const [dates,setDates]=useState(value);
  return <DatePicker.RangePicker
    aria-label="闪记同步与筛选日期"
    value={dates}
    onChange={next=>{const selected=next||[];setDates(selected);onChange(selected);}}
    getPopupContainer={()=>popup}
    allowClear
  />;
}
export function mountMinutesDateRange(host,{value=[],onChange}){
  host.classList.add('qf-minutes-calendar');
  const popup=document.createElement('div');popup.className='qf-minutes-calendar qf-minutes-calendar-popup';document.body.append(popup);
  const root=createRoot(host);root.render(<MinutesDateRange value={value} onChange={onChange} popup={popup}/>);
  return {destroy(){root.unmount();popup.remove();}};
}
