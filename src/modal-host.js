// modal-host.js —— 模态框显隐原语（只有 DOM 操作，无业务依赖）
// 由 modals.js 抽离（第六轮循环依赖治理），实现逐字未改。
// 另含弹窗公共可访问性：背景滚动锁 + Tab 焦点陷阱（初始化时对全部 .modal-bg 生效）。
function openModal(id){document.getElementById(id).classList.add('show')}
function closeModal(id){document.getElementById(id).classList.remove('show')}

const FOCUSABLE='a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
let lockY=0;
let locked=false;
let a11yStarted=false;

function openModals(){
  return [].slice.call(document.querySelectorAll('.modal-bg.show'));
}
function topModal(){
  const list=openModals();
  return list.length?list[list.length-1]:null;
}
// 任意 .modal-bg 的 class 变化都走这里：有弹窗就锁背景，全部关闭后恢复原滚动位置。
// 用 MutationObserver 而不是改 openModal/closeModal，是为了覆盖直接 classList 收起的路径
// （遮罩点击、ESC、各模块自己的关闭逻辑）。
function syncModalLock(){
  const any=openModals().length>0;
  const root=document.documentElement;
  if(any&&!locked){
    locked=true;
    lockY=window.pageYOffset||window.scrollY||0;
    if(root&&root.classList)root.classList.add('modal-lock');
  }else if(!any&&locked){
    locked=false;
    if(root&&root.classList)root.classList.remove('modal-lock');
    if(typeof window.scrollTo==='function')window.scrollTo(0,lockY);
  }
}
function focusables(bg){
  return [].slice.call(bg.querySelectorAll(FOCUSABLE)).filter(function(el){
    if(el.disabled)return false;
    if(el.type==='hidden')return false;
    const r=el.getBoundingClientRect?el.getBoundingClientRect():null;
    return !!(r&&(r.width>0||r.height>0));
  });
}
function onModalKeydown(e){
  if(e.key!=='Tab')return;
  const bg=topModal();
  if(!bg)return;
  const list=focusables(bg);
  if(!list.length){e.preventDefault();return;}
  const first=list[0],last=list[list.length-1];
  const active=document.activeElement;
  const inside=!!(active&&bg.contains(active));
  if(e.shiftKey){
    if(!inside||active===first){e.preventDefault();last.focus();}
  }else if(!inside||active===last){
    e.preventDefault();first.focus();
  }
}
function initModalA11y(){
  if(a11yStarted)return;
  a11yStarted=true;
  if(typeof MutationObserver==='function'&&document.querySelectorAll){
    document.querySelectorAll('.modal-bg').forEach(function(bg){
      new MutationObserver(syncModalLock).observe(bg,{attributes:true,attributeFilter:['class']});
    });
  }
  document.addEventListener('keydown',onModalKeydown,true);
}

export { openModal, closeModal, initModalA11y };
