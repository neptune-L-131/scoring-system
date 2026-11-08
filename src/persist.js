import { KEY } from './constants.js';
import { _persistBlocked } from './normalize.js';
import { render } from './render.js';
import { state } from './state.js';
import { toast } from './toast.js';
// persist.js —— IndexedDB 读写与合并写盘调度
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== IndexedDB 持久化层 =====
const IDB_NAME='score_sys_db';
const IDB_VERSION=1;
const IDB_STORE='kv';
let _idbPromise=null;
function openIDB(){
  if(_idbPromise)return _idbPromise;
  _idbPromise=new Promise(function(resolve,reject){
    if(!window.indexedDB){reject(new Error('no-indexeddb'));return;}
    const req=indexedDB.open(IDB_NAME,IDB_VERSION);
    req.onupgradeneeded=function(e){
      const db=e.target.result;
      if(!db.objectStoreNames.contains(IDB_STORE))db.createObjectStore(IDB_STORE);
    };
    req.onsuccess=function(e){resolve(e.target.result);};
    req.onerror=function(e){reject(e.target.error);};
  });
  return _idbPromise;
}
// 仅保留主数据键；其余历史 key 见 migrateLegacy()
// 读盘超时保护：把三种结果显式区分开 —— ok（拿到值）/ timeout（未回调）/ error（读失败）
function withTimeout(p,ms){
  return new Promise(function(resolve){
    let done=false;
    const timer=setTimeout(function(){if(done)return;done=true;resolve({status:'timeout'});},ms);
    p.then(function(v){if(done)return;done=true;clearTimeout(timer);resolve({status:'ok',value:v});})
     .catch(function(e){if(done)return;done=true;clearTimeout(timer);resolve({status:'error',error:e});});
  });
}
function idbGet(key){
  return openIDB().then(function(db){
    return new Promise(function(resolve,reject){
      const tx=db.transaction(IDB_STORE,'readonly');
      const rq=tx.objectStore(IDB_STORE).get(key);
      rq.onsuccess=function(){resolve(rq.result);};
      rq.onerror=function(){reject(rq.error);};
    });
  });
}
function idbPut(key,val){
  return openIDB().then(function(db){
    return new Promise(function(resolve,reject){
      const tx=db.transaction(IDB_STORE,'readwrite');
      tx.objectStore(IDB_STORE).put(val,key);
      tx.oncomplete=function(){resolve();};
      tx.onerror=function(){reject(tx.error);};
    });
  });
}

function idbDelete(key){
  return openIDB().then(function(db){
    return new Promise(function(resolve,reject){
      const tx=db.transaction(IDB_STORE,'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete=function(){resolve();};
      tx.onerror=function(){reject(tx.error);};
    });
  });
}

// ===== 持久化调度：合并写盘（200ms 尾随防抖）+ 强制 flush =====
// _saveChain 保持不变：所有写入仍串行；区别只在于「何时序列化/入链」。
let _saveChain=Promise.resolve();
const Persist=(function(){
  const SAVE_DELAY=200;
  let timer=null;
  let pending=false;
  function serialize(){return JSON.stringify(state);}
  function flush(){
    if(timer){clearTimeout(timer);timer=null;}
    if(!pending)return _saveChain;
    pending=false;
    // 读档未成功期间禁止落盘：否则空默认库会覆盖真实存档
    if(_persistBlocked)return _saveChain;
    let json;
    try{json=serialize();}catch(e){console.warn('serialize failed',e);return _saveChain;}
    _saveChain=_saveChain.then(function(){return idbPut(KEY,json);})
      .catch(function(e){
        console.warn('IndexedDB save failed',e);
        // 写失败必须有用户可见路径（配额/权限/存储被禁用），10 秒内只提示一次
        if(Date.now()-_saveErrAt<10000)return;
        _saveErrAt=Date.now();
        try{toast('本地保存失败：浏览器拒绝写入，请检查存储空间或权限','err');}catch(err){}
      });
    return _saveChain;
  }
  function schedule(delay){
    pending=true;
    if(timer)clearTimeout(timer);
    timer=setTimeout(flush,delay===undefined?SAVE_DELAY:delay);
  }
  return {schedule:schedule,flush:flush,serialize:serialize,delay:SAVE_DELAY,isPending:function(){return pending;}};
})();
function save(){if(_persistBlocked)return;Persist.schedule();}
export function initPersistHooks(){try{
  document.addEventListener('visibilitychange',function(){if(document.hidden)Persist.flush();});
  window.addEventListener('pagehide',function(){Persist.flush();});
}catch(e){}}
// 一次提交：落盘 + 全量渲染 + 可选提示（仅用于原本 save()+render()(+toast) 的调用点）
function commit(msg,type){save();render();if(msg)toast(msg,type);}
// 合并渲染：同一帧内的多次请求只渲染一次（仅用于定时调度批量处理后的收尾）
let _renderRAF=null;
function scheduleRender(){
  if(_renderRAF!==null)return;
  _renderRAF=requestAnimationFrame(function(){_renderRAF=null;render();});
}

let _saveErrAt=0;

export { IDB_NAME, IDB_VERSION, IDB_STORE, _idbPromise, openIDB, withTimeout, idbGet, idbPut, idbDelete, _saveChain, Persist, save, commit, _renderRAF, scheduleRender, _saveErrAt };
