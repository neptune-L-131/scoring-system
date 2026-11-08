import { AUDIT_MAX, LOG_MAX } from './constants.js';
import { save } from './persist.js';
import { defaultWatermark, round2, clone, now, splitCents, uid, logAmt, getTaskDomainIds } from './pure.js';
import { render } from './render.js';
import { setState, state } from './state.js';
import { attachAgg, detachAgg, noteEvicted, noteInvisible, reaggEntry, rebuildStats, shadowLabel, shadowPush } from './stats.js';
import { totalProgress } from './utils.js';

// 撤销实现由 undo.js 在模块加载时注入（见文件末尾 setReverseHandler）。
// 这样账务引擎不需要 import undo，避免 ledger ↔ undo 循环；调用时机仍在运行时，
// 所有模块加载完成后才可能触发，行为与直接调用一致。
let _reverseHandler = null;
function setReverseHandler(fn) { _reverseHandler = fn; }
// ledger.js —— 账务引擎：唯一资产写入入口（Ledger）
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== 账务引擎（唯一资产写入入口）=====
// 约定：账户键是运行时映射，不落盘；可见流水字段与事件流水完全一致。
// 精度口径由调用方决定，引擎不做 round2。
const Ledger=(function(){
  let tx=null;
  const policies={beforeSpend:[],beforePurchase:[],afterPost:[],onTxnEnd:[]};

  // 记录统一入栈（全文件唯一写入口）：最新的在最前，超过上限原地截断（不复制整表）
  // 截断掉的旧流水其账户贡献转入 ext.stats.evicted，保证“余额 vs 流水”在裁剪后仍可精确对账
  function pushLog(entry){
    state.logs.unshift(entry);
    if(state.logs.length>LOG_MAX){
      for(let i=LOG_MAX;i<state.logs.length;i++)noteEvicted(state.logs[i]);
      state.logs.length=LOG_MAX;
    }
    return entry;
  }
  // 业务事件（0 元）：业务层不再直接拼装流水
  function event(desc,src,extra){
    const entry={id:uid(),time:now(),st:'',amt:0,desc:desc,src:src||'',dom:''};
    if(extra)Object.assign(entry,extra);
    return pushLog(entry);
  }
  // 追加到末尾：历史重放需要保持时间顺序时不走 unshift。
  // 注意：append 不做 LOG_MAX 裁剪（重放期间必须保留完整历史），允许临时超出上限，
  // 下一次 pushLog 会统一截断到 LOG_MAX。
  function append(entry){state.logs.push(entry);attachAgg(entry);return entry;}
  // 移除流水（撤销/回收统一入口）：先按流水贡献反向扣减统计计数，再移出日志
  // 移除可见流水：既要从统计里扣回贡献，也要把该条对账户的贡献转入 ext.stats.evicted
  // （撤销时是先按隐形反向补账、再删流水，残差必须先记入 evicted，否则“余额 vs 流水”会对不上）
  function removeLogs(pred){
    const kept=[];
    state.logs.forEach(function(l){if(pred(l))kept.push(l);else{detachAgg(l);noteEvicted(l);}});
    state.logs=kept;
    return state.logs;
  }
  // 事务快照：排除 ext.audit（审计只追加、不参与回滚）
  // 回滚时把原审计数组接回，并保留失败事务产生的审计记录（尝试痕迹）
  function snapshotState(){
    const copy=Object.assign({},state);
    if(copy.ext)copy.ext=Object.assign({},copy.ext,{audit:[]});
    return clone(copy);
  }
  function restoreState(snap,attemptedAudit){
    const aud=(state.ext&&state.ext.audit)?state.ext.audit:[];
    setState(snap);
    if(!state.ext)return;
    state.ext.audit=aud;
    if(attemptedAudit&&attemptedAudit.length){
      state.ext.audit=(state.ext.audit||[]).concat(attemptedAudit).slice(-AUDIT_MAX);
    }
  }

  function fail(code,info){const e=new Error(code);e.__txn=true;e.code=code;e.info=info||{};throw e;}
  function accountInfo(key){
    if(key==='vitality')return{get:function(){return state.scores.vitality;},set:function(v){state.scores.vitality=v;},st:'vitality',dom:''};
    if(key==='achievement')return{get:function(){return state.scores.achievement;},set:function(v){state.scores.achievement=v;},st:'achievement',dom:''};
    if(key.indexOf('progress:')===0){
      const did=key.slice(9);
      return{get:function(){return state.scores.progress[did]||0;},set:function(v){state.scores.progress[did]=v;},st:'progress',dom:did};
    }
    if(key.indexOf('card:')===0){
      const cid=key.slice(5);
      return{get:function(){return state.cards[cid]||0;},set:function(v){state.cards[cid]=v;},st:'card',dom:''};
    }
    fail('INVALID_ACCOUNT',{account:key});
  }
  function audit(rec){
    if(!tx||!state.ext||state.ext.features&&state.ext.features.audit===false)return;
    tx.audit.push(rec);
  }
  function noteWatermark(key,after){
    if(!state.ext||!state.ext.watermarks)return;
    const w=state.ext.watermarks;
    if(key==='vitality'||key==='achievement'){
      if(after>w[key].best)w[key]={best:after,at:now()};
      return;
    }
    if(key.indexOf('progress:')===0){
      const did=key.slice(9);
      const cur=w.progress[did]||defaultWatermark();
      if(after>cur.best)w.progress[did]={best:after,at:now()};
    }
  }
  function pickExtra(reason){
    const o={};
    Object.keys(reason||{}).forEach(function(k){
      if(k!=='desc'&&k!=='src'&&k!=='dom'&&k!=='name')o[k]=reason[k];
    });
    return o;
  }
  function writeEntry(op,acct,delta,reason){
    if(op.visible===false)return null;
    let entry;
    if(op.entry){
      entry=Object.assign({id:uid(),time:now()},op.entry);
    }else{
      entry={id:uid(),time:now(),st:op.st||acct.st,amt:delta,desc:(reason&&reason.desc)||'',src:(reason&&reason.src)||'',dom:(reason&&reason.dom!==undefined)?reason.dom:(acct.dom||'')};
      Object.assign(entry,pickExtra(reason));
    }
    return pushLog(entry);
  }
  function post(op){
    if(!tx){
      const r=txn(function(){return post(op);},{save:'none',render:false,label:'auto'});
      return r.ok?r.value:{ok:false,error:r.error};
    }
    const reason=op.reason||{};
    if(op.op==='transfer'){
      const a=accountInfo(op.from),b=accountInfo(op.to);
      const amt=Number(op.delta)||0;
      const beforeA=Number(a.get())||0,beforeB=Number(b.get())||0;
      a.set(beforeA-amt);b.set(beforeB+amt);
      tx.accounts.add(op.from);tx.accounts.add(op.to);
      const entry=writeEntry(op,b,amt,reason);
      if(op.visible===false){
        // 隐形转账同样要留下可追溯痕迹，并计入 invisible 累计用于自检对账
        noteInvisible(op.from,-amt);
        noteInvisible(op.to,amt);
        const lb=shadowLabel(reason.src,reason.desc);
        shadowPush({id:uid(),ts:now(),acct:op.from,delta:-amt,before:beforeA,after:beforeA-amt,src:reason.src||'',label:lb});
        shadowPush({id:uid(),ts:now(),acct:op.to,delta:amt,before:beforeB,after:beforeB+amt,src:reason.src||'',label:lb});
      }
      audit({id:entry?entry.id:uid(),ts:now(),txn:tx.label,op:'transfer',from:op.from,to:op.to,delta:amt,src:reason.src||''});
      noteWatermark(op.to,beforeB+amt);
      return {ok:true,entryId:entry?entry.id:null,before:beforeA,after:beforeA-amt};
    }
    const acct=accountInfo(op.account);
    const before=Number(acct.get())||0;
    let delta;
    if(op.op==='adjust')delta=(Number(op.target)||0)-before;
    else delta=Number(op.delta)||0;
    if(!isFinite(delta))fail('INVALID_AMOUNT',{account:op.account,delta:op.delta});
    if(op.idemKey){
      if(tx.idem[op.idemKey])return{ok:true,deduped:true,entryId:null,before:before,after:before};
      tx.idem[op.idemKey]=true;
    }
    const after=before+delta;
    acct.set(after);
    tx.accounts.add(op.account);
    if(acct.dom)tx.domains[acct.dom]=true;
    if(op.visible===false){
      // 隐形增减：计入差额累计，并写一条余额调整记录（银行页可见）
      noteInvisible(op.account,delta);
      shadowPush({id:uid(),ts:now(),acct:op.account,delta:delta,before:before,after:after,src:reason.src||'',label:shadowLabel(reason.src,reason.desc)});
    }
    const entry=writeEntry(op,acct,delta,reason);
    attachAgg(entry);
    audit({id:entry?entry.id:uid(),ts:now(),txn:tx.label,op:op.op,acct:op.account,delta:delta,before:before,after:after,visible:op.visible!==false,src:reason.src||''});
    noteWatermark(op.account,after);
    if(policies.afterPost.length){
      policies.afterPost.forEach(function(p){
        try{p.fn({entry:entry,account:op.account,before:before,after:after,txn:tx});}catch(e){console.warn('policy failed',p.name,e);}
      });
    }
    return {ok:true,entryId:entry?entry.id:null,before:before,after:after};
  }
  // 多科目拆分：一次可见流水（用于 checkin 的 both 型与多领域 progress 分摊）
  function postSplits(op){
    if(!tx){
      const r=txn(function(){return postSplits(op);},{save:'none',render:false,label:'auto'});
      return r.ok?r.value:{ok:false,error:r.error};
    }
    const reason=op.reason||{};
    const splits=op.splits||[];
    const beforeOf={};
    const domainSplits=[];
    const shadowRecs=[];
    let total=0;
    splits.forEach(function(s){
      if(s.account){
        const a=accountInfo(s.account);
        beforeOf[s.account]=Number(a.get())||0;
        const d=Number(s.delta)||0;
        a.set(beforeOf[s.account]+d);
        tx.accounts.add(s.account);
        if(a.dom)tx.domains[a.dom]=true;
        if(op.visible===false)shadowRecs.push({acct:s.account,delta:d,before:beforeOf[s.account],after:beforeOf[s.account]+d});
        total+=d;
      }else if(s.domainIds&&s.domainIds.length){
        // 精确到分的平均分摊：各领域之和与原额逐分相等（尾差按顺序归前几个领域）
        const parts=splitCents(Number(s.delta)||0,s.domainIds.length);
        s.domainIds.forEach(function(did,i){
          const key='progress:'+did;
          const a=accountInfo(key);
          beforeOf[key]=Number(a.get())||0;
          const d=parts[i];
          a.set(beforeOf[key]+d);
          tx.accounts.add(key);
          tx.domains[did]=true;
          domainSplits.push({dom:did,amt:d});
          if(op.visible===false)shadowRecs.push({acct:key,delta:d,before:beforeOf[key],after:beforeOf[key]+d});
        });
        total+=Number(s.delta)||0;
      }
    });
    if(op.visible===false&&shadowRecs.length){
      const lb=shadowLabel(reason.src,reason.desc);
      shadowRecs.forEach(function(r){
        noteInvisible(r.acct,r.delta);
        shadowPush({id:uid(),ts:now(),acct:r.acct,delta:r.delta,before:r.before,after:r.after,src:reason.src||'',label:lb});
      });
    }
    const entry=writeEntry(op,{st:op.st||'vitality',dom:''},total,reason);
    // 分配明细落盘在流水自身，撤销时按原比例逐领域退回（不依赖 ext.audit）
    if(entry&&domainSplits.length)entry.splits=domainSplits;
    // 统计计数在分配明细落盘后再折叠，保证按领域分摊口径与流水一致
    attachAgg(entry);
    audit({id:entry?entry.id:uid(),ts:now(),txn:tx.label,op:'splits',accounts:Object.keys(beforeOf),delta:total,visible:op.visible!==false,src:reason.src||''});
    Object.keys(beforeOf).forEach(function(k){noteWatermark(k,Number(accountInfo(k).get())||0);});
    return {ok:true,entryId:entry?entry.id:null,accounts:Object.keys(beforeOf)};
  }
  // txn 选项：save==='none' 跳过落盘，其它值（含 undefined）统一走 save()（200ms 防抖写盘）；
  // render===false 跳过全量渲染。不要新增第三种 save 语义。
  function txn(fn,opts){
    opts=opts||{};
    if(tx){return {ok:true,value:fn(tx),nested:true};}
    const snap=(opts.snapshot===false)?null:snapshotState();
    tx={label:opts.label||'',accounts:new Set(),domains:{},audit:[],idem:{}};
    let value,error=null;
    try{value=fn(tx);}
    catch(e){
      if(e&&e.__txn){error={code:e.code||'ABORTED',message:e.message,info:e.info||{}};}
      else{const attempted=tx?tx.audit:null;if(snap)restoreState(snap,attempted);tx=null;throw e;}
    }
    if(error){
      if(snap)restoreState(snap,tx.audit);
      tx=null;
      return {ok:false,error:error};
    }
    const accounts=Array.from(tx.accounts);
    try{
      if(tx.audit.length){
        state.ext.audit=(state.ext.audit||[]).concat(tx.audit).slice(-AUDIT_MAX);
      }
      state.ext.stats.updatedAt=now();
      if(accounts.some(function(k){return k.indexOf('progress:')===0;})){
        const tp=totalProgress();
        if(tp>state.ext.watermarks.totalProgress.best)state.ext.watermarks.totalProgress={best:tp,at:now()};
      }
    }catch(e){}
    const domains=Object.keys(tx.domains);
    const entries=tx.audit.map(function(a){return a.id;});
    const label=tx.label;
    tx=null;
    if(policies.onTxnEnd.length){
      policies.onTxnEnd.forEach(function(p){try{p.fn({ok:true,label:label,accounts:accounts,entries:entries});}catch(e){console.warn('policy failed',p.name,e);}});
    }
    if(opts.save!=='none')save();
    if(opts.render!==false)render();
    return {ok:true,value:value,accounts:accounts,domains:domains,entries:entries};
  }
  function grant(account,amount,reason,opts){
    return post(Object.assign({op:'grant',account:account,delta:amount,reason:reason},opts||{}));
  }
  function spend(account,amount,reason,opts){
    return post(Object.assign({op:'spend',account:account,delta:-Math.abs(Number(amount)||0),reason:reason},opts||{}));
  }
  function transfer(from,to,amount,reason,opts){
    return post(Object.assign({op:'transfer',from:from,to:to,delta:Math.abs(Number(amount)||0),reason:reason},opts||{}));
  }
  function adjust(account,target,reason,opts){
    return post(Object.assign({op:'adjust',account:account,target:target,reason:reason},opts||{}));
  }
  const liability={
    open:function(o){
      o=o||{};
      const loan={id:o.id||uid(),amount:Number(o.amount)||0,debtRate:Number(o.debtRate)||0,currency:o.currency||'vitality',productId:o.productId||'',productName:o.productName||'',date:o.date||now(),lastInterestAt:o.lastInterestAt||o.date||now()};
      state.loans.push(loan);
      audit({id:uid(),ts:now(),txn:tx?tx.label:'',op:'liability-open',liability:loan.id,delta:loan.amount,src:(o.reason&&o.reason.src)||''});
      return loan;
    },
    mutate:function(id,factor,reason){
      const l=state.loans.find(function(x){return x.id===id;});
      if(!l)return null;
      const before=l.amount;
      l.amount=typeof factor==='function'?factor(before):(Number(factor)||0);
      audit({id:uid(),ts:now(),txn:tx?tx.label:'',op:'liability-mutate',liability:id,delta:l.amount-before,before:before,after:l.amount,visible:false,src:(reason&&reason.src)||''});
      return l;
    },
    close:function(id,reason){
      const i=state.loans.findIndex(function(x){return x.id===id;});
      if(i<0)return false;
      const l=state.loans[i];
      state.loans.splice(i,1);
      audit({id:uid(),ts:now(),txn:tx?tx.label:'',op:'liability-close',liability:id,amount:l.amount,src:(reason&&reason.src)||''});
      return true;
    }
  };
  function registerPolicy(p){
    if(!p||!policies[p.phase])return;
    policies[p.phase].push(p);
    policies[p.phase].sort(function(a,b){return (a.priority||0)-(b.priority||0);});
  }
  // 购买前门槛：策略返回 {deny:true,code,reason} 时抛事务错误，由 txn 统一回滚
  function runPolicies(phase,ctx){
    const list=policies[phase]||[];
    for(let i=0;i<list.length;i++){
      const p=list[i];
      let r;
      try{r=p.fn(ctx);}
      catch(e){
        console.warn('policy failed',p.name,e);
        // 购买前门槛 fail-closed：策略本身异常时不能放行，否则等于门槛失效。
        if(phase==='beforePurchase'){
          return{deny:true,code:'POLICY_ERROR',reason:'购买校验异常，已阻止本次购买'};
        }
        continue;
      }
      if(r&&r.deny)return r;
    }
    return null;
  }
  function checkPurchase(product){
    const r=runPolicies('beforePurchase',{product:product});
    if(r&&r.deny)fail('PURCHASE_DENIED',{code:r.code||'GATE',reason:r.reason||'购买条件未满足',reasons:r.reasons||[]});
    return true;
  }
  return{
    txn:txn,post:post,postSplits:postSplits,grant:grant,spend:spend,transfer:transfer,adjust:adjust,
    liability:liability,registerPolicy:registerPolicy,accountInfo:accountInfo,
    event:event,append:append,removeLogs:removeLogs,checkPurchase:checkPurchase,
    // 流水被原地改写（领域迁移/历史重算）后重算它对统计计数的贡献
    reagg:reaggEntry,rebuildStats:rebuildStats,
    inTxn:function(){return !!tx;},
    balance:function(key){return Number(accountInfo(key).get())||0;},
    entries:function(){return state.logs;},
    // 复用撤销适配器注册表；业务层不直接触碰适配器实现
    reverse:function(logId){return _reverseHandler? _reverseHandler(logId): undefined;}
  };
})();

// 打卡流水重放：按流水金额向账务引擎反向发放（撤销/历史重算共用）
// 第六轮从 utils.js 移到账务引擎旁：它只依赖 Ledger 与 state，留在 utils 会造成 utils ↔ ledger 循环。
function applyCheckinGain(log,mult){
  const types=log.st==='both'?['vitality','progress']:[log.st];
  types.forEach(st=>{
    const amt=logAmt(log,st);
    if(st==='vitality'){
      Ledger.post({op:'grant',account:'vitality',delta:mult*amt,visible:false,reason:{src:'checkin-replay'}});
    }else if(st==='progress'){
      // 优先按流水自带的分配明细精确反向；无明细时回退到按领域均分
      if(Array.isArray(log.splits)&&log.splits.length){
        log.splits.forEach(function(sp){
          Ledger.post({op:'grant',account:'progress:'+(sp.dom||'d_default'),delta:mult*(Number(sp.amt)||0),visible:false,reason:{src:'checkin-replay'}});
        });
      }else{
        let dids=(log.dom||'').split(',').filter(Boolean);
        if(dids.length===0&&log.taskId){const t=state.tasks.find(x=>x.id===log.taskId);if(t)dids=getTaskDomainIds(t);}
        if(dids.length===0)dids=['d_default'];
        Ledger.postSplits({splits:[{domainIds:dids,delta:mult*amt}],visible:false,reason:{src:'checkin-replay'}});
      }
    }
  });
}

export { Ledger, applyCheckinGain, setReverseHandler };
