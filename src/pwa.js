import { KEY } from './constants.js';
import { defaults } from './defaults.js';
import { openModal } from './modal-host.js';
import { _persistBlocked, loadIssue, parseState, setLoadIssue, setPersistBlocked } from './normalize.js';
import { idbGet, idbPut, save, withTimeout } from './persist.js';
import { render } from './render.js';
import { runStartupProcessors } from './startup.js';
import { setState, state } from './state.js';
import { toast } from './toast.js';
// pwa.js —— PWA 安装提示
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== PWA Install =====
let deferredPrompt=null;

// Inject manifest via Blob (works for single-file HTML)
function injectManifest(){
  const manifest={
    name:'计分系统',
    short_name:'计分',
    description:'活力点、进度值、成果点自动计分系统',
    start_url:'.',
    display:'standalone',
    background_color:'#e8e8e8',
    theme_color:'#e8e8e8',
    icons:[]
  };
  const blob=new Blob([JSON.stringify(manifest)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  let link=document.querySelector('link[rel="manifest"]');
  if(!link){link=document.createElement('link');link.rel='manifest';document.head.appendChild(link);}
  link.href=url;
}

// 注册独立的 Service Worker 文件（整版缓存 + 温和更新，见仓库根目录 sw.js）
function registerSW(){
  if(!('serviceWorker' in navigator))return;
  // updateViaCache:'none'：sw.js 本身不走 HTTP 缓存，push 后能第一时间发现新版本
  navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'}).then(function(reg){
    // 新版本下载完成时让它立即激活：当前页面仍在跑已经加载好的旧代码，不会被打断；
    // 下一次打开就整版切到新版本。首次安装（还没有 controller）时什么都不做。
    function promote(worker){
      if(worker&&navigator.serviceWorker.controller)worker.postMessage({type:'SKIP_WAITING'});
    }
    promote(reg.waiting);
    reg.addEventListener('updatefound',function(){
      const w=reg.installing;
      if(!w)return;
      w.addEventListener('statechange',function(){if(w.state==='installed')promote(w);});
    });
  }).catch(function(){});
}

function initPWA(){
  injectManifest();
  registerSW();

  // Detect if already running as installed app
  function isStandalone(){
    return window.matchMedia('(display-mode: standalone)').matches
      ||window.navigator.standalone===true;
  }

  const btn=document.getElementById('installBtn');

  // If already standalone, hide install button
  if(isStandalone()){
    if(btn)btn.style.display='none';
  }

  // Listen for install prompt (capture deferredPrompt, button already visible)
  window.addEventListener('beforeinstallprompt',e=>{
    e.preventDefault();
    deferredPrompt=e;
  });

  // Listen for app installed event
  window.addEventListener('appinstalled',()=>{
    if(btn)btn.style.display='none';
    deferredPrompt=null;
    toast('已安装至桌面');
  });

  // Also check display-mode change (uninstall scenario)
  window.matchMedia('(display-mode: standalone)').addEventListener('change',e=>{
    if(!btn)return;
    if(e.matches){
      btn.style.display='none';
    }else{
      // Running in browser after uninstall — show button
      btn.style.display='';
    }
  });
}

function installApp(){
  if(!deferredPrompt){
    // Browser doesn't support install prompt — show manual instructions
    openModal('installModal');
    return;
  }
  deferredPrompt.prompt();
  deferredPrompt.userChoice.then(()=>{
    deferredPrompt=null;
    const btn=document.getElementById('installBtn');
    if(btn)btn.style.display='none';
  });
}

// 数据损坏/被截断：先备份原始内容，避免被下一次保存覆盖而彻底丢失
// 固定两个键轮换（latest/prev），不再每次生成时间戳键导致 localStorage 无限膨胀
const CORRUPT_BACKUP_KEY='score_sys_corrupt_backup';
function backupCorrupt(raw){
  try{
    const cur=localStorage.getItem(CORRUPT_BACKUP_KEY);
    if(cur)localStorage.setItem(CORRUPT_BACKUP_KEY+'_prev',cur);
    localStorage.setItem(CORRUPT_BACKUP_KEY,raw);
    // 清理历史版本留下的时间戳键
    const stale=[];
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(k&&k.indexOf(CORRUPT_BACKUP_KEY+'_')===0&&k!==CORRUPT_BACKUP_KEY+'_prev')stale.push(k);
    }
    stale.forEach(function(k){localStorage.removeItem(k);});
  }catch(e){}
}

// 启动装载：只读 IndexedDB；显式区分「有存档 / 真没存档 / 读超时」三种结果。
// 超时或读取失败时返回空白默认库仅供渲染，同时 _persistBlocked=true 禁止落盘，
// 避免用空库覆盖仍然完好的真实存档。
async function loadStateFromStorage(){
  setLoadIssue(null);
  setPersistBlocked(false);
  const r=await withTimeout(idbGet(KEY),3000);
  if(r.status==='timeout'){
    setLoadIssue({type:'timeout'});
    setPersistBlocked(true);
    return defaults();
  }
  if(r.status==='error'){
    // 完全没有 IndexedDB 能力（如某些 file:// 环境）：这是真正的“无存档”
    if(!window.indexedDB)return defaults();
    setLoadIssue({type:'read-error'});
    setPersistBlocked(true);
    return defaults();
  }
  const raw=r.value;
  const hasIDB=(raw!==undefined&&raw!==null&&raw!=='');
  if(hasIDB){
    const s=parseState(raw);
    if(loadIssue){
      if(loadIssue.type==='corrupt'){try{await idbPut(KEY+'_corrupt',raw);}catch(e){}}
      backupCorrupt(raw);
    }
    return s;
  }
  return defaults();
}
// 读档失败时顶部横幅：暂停写入 + 手动重试（不自动重试，避免与用户操作抢写）
function showLoadBanner(kind){
  const rb=document.getElementById('recoverBar');
  if(!rb)return;
  rb.style.display='flex';
  rb.innerHTML='<span>'+(kind==='timeout'
    ?'读取本地存档超时，已暂停写入以免覆盖原有数据。'
    :'无法读取本地存档，已暂停写入以免覆盖原有数据。')+'</span>'
    +'<button class="btn btn-sm" onclick="retryLoadStorage()">重试读取</button>';
}
async function retryLoadStorage(){
  const rb=document.getElementById('recoverBar');
  const btn=rb?rb.querySelector('button'):null;
  if(btn){btn.disabled=true;btn.textContent='重试中…';}
  let r;
  try{r=await withTimeout(idbGet(KEY),5000);}catch(e){r={status:'error',error:e};}
  if(r.status==='ok'){
    const raw=r.value;
    if(raw===undefined||raw===null||raw===''){
      // 已确认确实没有存档：解除暂停，按当前内存状态继续
      setPersistBlocked(false);setLoadIssue(null);
      if(rb)rb.style.display='none';
      save();render();
      toast('已确认本地暂无存档，可以正常使用');
      return;
    }
    // 读到存档：重新走完整启动流程（迁移、结算、渲染口径与正常启动一致）
    if(typeof location.reload==='function'){location.reload();return;}
    const s=parseState(raw);
    if(!loadIssue){
      setState(s);setPersistBlocked(false);
      if(!state.domains.find(d=>d.id==='d_default'))state.domains.unshift({id:'d_default',name:'默认'});
      if(!state.collections.find(c=>c.id==='c_default'))state.collections.unshift({id:'c_default',name:'默认'});
      // 与正常启动保持同一套处理器：活动、债务、贷款、预算结算、跨天基准都要重跑
      runStartupProcessors();
      if(rb)rb.style.display='none';
      save();render();
      toast('已重新读取本地存档');
      return;
    }
    toast('读取到的存档无法解析，未覆盖原数据','err');
  }else{
    toast(r.status==='timeout'?'读取仍然超时，已继续暂停写入':'读取失败，已继续暂停写入','err');
  }
  if(btn){btn.disabled=false;btn.textContent='重试读取';}
}

async function attemptRecovery(){
  const bar=document.getElementById('recoverBar');
  const btn=bar?bar.querySelector('button'):null;
  if(btn){btn.disabled=true;btn.textContent='恢复中…';}
  try{
    let raw=null;
    try{raw=await idbGet(KEY+'_corrupt');}catch(e){}
    if(raw===undefined||raw===null||raw===''){toast('未找到可恢复的原始数据','err');return;}
    const s=parseState(raw);
    if(!s||typeof s!=='object'||!s.scores){toast('恢复失败：原始内容无法解析','err');return;}
    setState(s);
    save();
    render();
    toast('已尝试恢复上次数据','ok');
  }finally{
    if(bar)bar.style.display='none';
    if(btn){btn.disabled=false;btn.textContent='尝试恢复';}
  }
}

export { deferredPrompt, injectManifest, registerSW, initPWA, installApp, CORRUPT_BACKUP_KEY, backupCorrupt, loadStateFromStorage, showLoadBanner, retryLoadStorage, attemptRecovery };
