
// toast.js —— 轻量提示条（唯一依赖 DOM 的底层 UI 原语）
// 由 shell.js 抽离（第六轮循环依赖治理），实现逐字未改。

function toast(msg,type){
  const wrap=document.getElementById('toastWrap');
  if(!wrap)return;
  const t=document.createElement('div');
  t.className='toast'+(type?' '+type:'');
  t.textContent=msg;
  wrap.appendChild(t);
  // 同时最多 3 条，避免批量操作时堆满屏幕
  while(wrap.children.length>3)wrap.removeChild(wrap.firstChild);
  setTimeout(()=>t.remove(),2800);
}


export { toast };
