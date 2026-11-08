import { ACTIVITY_MAX_DAYS, BUDGET_LEDGER_MAX, LOG_MAX } from './constants.js';
import { Ledger } from './ledger.js';
import { dayKey, logAmt, clone, fmt, getTaskDomainIds, logHasType } from './pure.js';
import { state } from './state.js';
import { computeEntryAgg } from './stats.js';
// debug.js —— 一致性自检（#debug）
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== 一致性自检（#debug / 手动）=====
// 只报告、不自动修复：所有结论都基于当前内存状态与日志，发现差异时输出到 console 与 #debug 面板。
function renderDebugReport(report){
  if(location.hash!=='#debug')return;
  let box=document.getElementById('debugCheckPanel');
  if(!box){
    box=document.createElement('pre');
    box.id='debugCheckPanel';
    box.style.cssText='position:fixed;left:8px;bottom:8px;max-width:60vw;max-height:40vh;overflow:auto;z-index:9999;background:var(--bg-2,#111);color:var(--text-1,#eee);border:1px solid var(--border,#333);padding:8px;font-size:12px;white-space:pre-wrap';
    document.body.appendChild(box);
  }
  const bad=report.filter(function(r){return !r.ok;});
  const skipped=report.filter(function(r){return r.skip;}).length;
  box.textContent='一致性自检 '+(bad.length?('发现 '+bad.length+' 处差异'):'全部通过')+(skipped?('（'+skipped+' 项因日志截断跳过）'):'')+'\n'+
    report.map(function(r){return (r.skip?'[--] ':(r.ok?'[OK] ':'[!!] '))+r.label+(r.detail?'：'+r.detail:'');}).join('\n');
}
function runConsistencyChecks(verbose){
  const report=[];
  const add=function(label,ok,detail){report.push({label:label,ok:!!ok,detail:detail||''});};
  const near=function(a,b){return Math.abs((Number(a)||0)-(Number(b)||0))<0.005;};
  const st=(state.ext&&state.ext.stats)||{};
  const truncatedLogs=(state.logs||[]).length>=LOG_MAX;
  const invisible=st.invisible||{vitality:0,achievement:0,progress:{},cards:{}};
  const evicted=st.evicted||{vitality:0,achievement:0,progress:{},cards:{}};

  // 1) 各账户余额 vs 可见流水求和 + 隐形差额 + 已截断差额
  // 三者相加恒等于余额，因此隐形操作（贷款/撤销/扩容/搬运）与 LOG_MAX 裁剪都不会再造成误报。
  const visSum={vitality:0,achievement:0,progress:{}};
  (state.logs||[]).forEach(function(l){
    if(logHasType(l,'vitality'))visSum.vitality+=(Number(logAmt(l,'vitality'))||0);
    if(l.st==='achievement')visSum.achievement+=(Number(l.amt)||0);
    const agg=computeEntryAgg(l);
    Object.keys(agg.pd||{}).forEach(function(d){visSum.progress[d]=(visSum.progress[d]||0)+agg.pd[d];});
  });
  const expectV=visSum.vitality+(Number(invisible.vitality)||0)+(Number(evicted.vitality)||0);
  const expectA=visSum.achievement+(Number(invisible.achievement)||0)+(Number(evicted.achievement)||0);
  add('活力点余额 vs 流水合计',near(state.scores.vitality,expectV),
    '余额 '+fmt(state.scores.vitality)+' / 可见 '+fmt(visSum.vitality)+' + 隐形 '+fmt(invisible.vitality||0)+' + 截断 '+fmt(evicted.vitality||0));
  add('成果点余额 vs 流水合计',near(state.scores.achievement,expectA),
    '余额 '+fmt(state.scores.achievement)+' / 可见 '+fmt(visSum.achievement)+' + 隐形 '+fmt(invisible.achievement||0)+' + 截断 '+fmt(evicted.achievement||0));
  state.domains.forEach(function(d){
    const bal=Number(state.scores.progress[d.id])||0;
    const sum=Number(visSum.progress[d.id])||0;
    const inv=Number((invisible.progress||{})[d.id]||0)||0;
    const evi=Number((evicted.progress||{})[d.id]||0)||0;
    add('进度账户「'+d.name+'」vs 流水合计',near(bal,sum+inv+evi),
      '余额 '+fmt(bal)+' / 可见 '+fmt(sum)+' + 隐形 '+fmt(inv)+' + 截断 '+fmt(evi));
  });

  // 2) periods.spent vs budget ledger 求和（按分类、按周期，仅统计未撤销账目）
  const bd=state.ext&&state.ext.budgets;
  const ledger=bd&&Array.isArray(bd.ledger)?bd.ledger:[];
  const ledgerTrunc=!!(bd&&bd.settings&&ledger.length>=Number(bd.settings.ledgerMax||BUDGET_LEDGER_MAX));
  if(bd&&bd.periods){
    Object.keys(bd.periods).forEach(function(catId){
      const map=bd.periods[catId]||{};
      Object.keys(map).forEach(function(key){
        const p=map[key];
        if(!p)return;
        const sum=ledger.reduce(function(s,e){
          if(!e||e.categoryId!==catId||e.periodKey!==key||e.status==='reversed')return s;
          return s+(Number(e.amount)||0);
        },0);
        add('预算周期 '+catId+'/'+key+' spent',near(p.spent,sum),
          '周期 '+fmt(p.spent)+' / 账目 '+fmt(sum)+(ledgerTrunc?'（账目明细已截断）':''));
      });
    });
  }

  // 3) ext.activity 桶 vs 打卡日志（最近 90 天）
  const expectedActivity={};
  const actCut=dayKey(Date.now()-(ACTIVITY_MAX_DAYS-1)*864e5);
  (state.logs||[]).forEach(function(l){
    if(!l||l.src!=='checkin')return;
    const key=dayKey(Number(l.time)||0);
    if(key<actCut)return;
    let dids=String(l.dom||'').split(',').filter(Boolean);
    if(!dids.length&&l.taskId){
      const t=(state.tasks||[]).find(function(x){return x.id===l.taskId;});
      if(t)dids=getTaskDomainIds(t);
    }
    dids.forEach(function(d){
      if(!expectedActivity[d])expectedActivity[d]={};
      expectedActivity[d][key]=(expectedActivity[d][key]||0)+1;
    });
  });
  const activity=state.ext&&state.ext.activity||{};
  if(truncatedLogs){
    // 日志已截断时无法还原 90 天完整打卡记录：降级为 console 提示，不参与 bad 判定
    console.log('[自检] 活跃度桶检查跳过：日志已截断（'+LOG_MAX+' 条上限），无法还原最近 '+ACTIVITY_MAX_DAYS+' 天完整打卡记录');
    report.push({label:'活跃度桶 vs 打卡日志',ok:true,skip:true,detail:'日志已截断，跳过严格比对'});
  }else{
    const actDoms=new Set(Object.keys(expectedActivity).concat(Object.keys(activity)));
    actDoms.forEach(function(d){
      const keys=new Set(Object.keys(expectedActivity[d]||{}).concat(Object.keys(activity[d]||{})));
      let diff=0;
      keys.forEach(function(k){if(k>=actCut)diff+=Math.abs((Number((activity[d]||{})[k])||0)-(Number((expectedActivity[d]||{})[k])||0));});
      add('活跃度桶「'+d+'」vs 打卡日志',diff<1e-9,'差异合计 '+fmt(diff));
    });
  }

  // 4) penalizedOverspend vs penaltyOverspendDelta 累计（仅未撤销账目）
  if(bd&&bd.periods){
    Object.keys(bd.periods).forEach(function(catId){
      const map=bd.periods[catId]||{};
      Object.keys(map).forEach(function(key){
        const p=map[key];
        if(!p)return;
        const sum=ledger.reduce(function(s,e){
          if(!e||e.categoryId!==catId||e.periodKey!==key||e.status==='reversed')return s;
          return s+(Number(e.penaltyOverspendDelta)||0);
        },0);
        add('惩罚水位 '+catId+'/'+key,near(p.penalizedOverspend,sum),
          '水位 '+fmt(p.penalizedOverspend)+' / 累计 '+fmt(sum)+(ledgerTrunc?'（账目明细已截断）':''));
      });
    });
  }

  // 5) ext.stats vs 从当前日志重建的值（日志截断时只要求计数器不小于重建值）
  try{
    const savedStats=clone(state.ext.stats);
    const savedAggs=(state.logs||[]).map(function(l){return l.agg;});
    Ledger.rebuildStats();
    const rebuilt=clone(state.ext.stats);
    state.ext.stats=savedStats;
    (state.logs||[]).forEach(function(l,i){l.agg=savedAggs[i];});
    const cmp=function(label,k){
      const cur=Number(savedStats[k])||0,reb=Number(rebuilt[k])||0;
      const ok=truncatedLogs?(cur+0.005>=reb):near(cur,reb);
      add('统计计数器 '+label,ok,'计数器 '+fmt(cur)+' / 重建 '+fmt(reb)+(truncatedLogs?'（日志已截断）':''));
    };
    cmp('活力收入','lifetimeVitalityIn');
    cmp('活力支出','lifetimeVitalityOut');
    cmp('进度收入','lifetimeProgressIn');
    cmp('进度支出','lifetimeProgressOut');
    cmp('成果收入','lifetimeAchievementIn');
    cmp('成果支出','lifetimeAchievementOut');
    cmp('打卡次数','totalCheckins');
    cmp('购买次数','totalPurchases');
  }catch(e){
    add('统计计数器重建',false,'重建异常：'+(e&&e.message||e));
  }

  // 6) achievementCounted vs 成就日志（计数器不得小于现有日志可证明的解锁金额）
  const counted=state.ext&&state.ext.achievementCounted||{};
  const logMax={};
  (state.logs||[]).forEach(function(l){
    if(!l||l.src!=='achievement'||!l.achId)return;
    const amt=Number(l.amt)||0;
    if(amt>0)logMax[l.achId]=Math.max(logMax[l.achId]||0,amt);
  });
  Object.keys(logMax).forEach(function(id){
    const c=Number(counted[id])||0;
    add('成就计数 '+id,c+0.005>=logMax[id],'已计入 '+fmt(c)+' / 日志 '+fmt(logMax[id]));
  });

  const bad=report.filter(function(r){return !r.ok;});
  if(verbose||location.hash==='#debug'){
    if(bad.length)bad.forEach(function(r){console.warn('[自检] '+r.label+'：'+r.detail);});
    else console.log('[自检] 全部通过（'+report.length+' 项）');
    renderDebugReport(report);
  }else if(bad.length){
    console.warn('[自检] 发现 '+bad.length+' 处不一致：'+bad.map(function(r){return r.label;}).join('；'));
  }
  if(typeof window!=='undefined')window.__debugChecks=report;
  return report;
}

// 开发期自检：确认日志写入口只存在于 Ledger 内部（#debug 下输出警告，避免业务层回潮直写）
function devAuditLogWrites(){
  if(location.hash!=='#debug')return;
  const bad=[];
  if(typeof addLog!=='undefined')bad.push('addLog 仍可从业务层调用');
  if(typeof pushLog!=='undefined')bad.push('pushLog 仍可从业务层调用');
  if(typeof Ledger.event!=='function')bad.push('Ledger.event 缺失');
  if(typeof Ledger.append!=='function')bad.push('Ledger.append 缺失');
  if(typeof Ledger.removeLogs!=='function')bad.push('Ledger.removeLogs 缺失');
  if(typeof Ledger.reverse!=='function')bad.push('Ledger.reverse 缺失');
  if(bad.length)console.warn('[dev] 日志写入口自检失败：'+bad.join('；'));
  // 源码级回潮检查：http(s) 下取样全部模块源码，确认日志数组直写次数没有超过 Ledger 内部与全量重置的既有额度
  // 连带改动：原来是 fetch('app.js') 读单文件，拆分后改为读取 src/ 下各模块并拼接。
  if(location.protocol==='http:'||location.protocol==='https:'){
    const files=['state.js','theme.js','normalize.js','persist.js','utils.js','stats.js','ledger.js','gate.js','budget.js','conditions.js','entities.js','business.js','library.js','shell.js','render-work.js','render-bank.js','render-shop.js','render-budget.js','cycle.js','cond-ui.js','ui-events.js','undo.js','modals.js','data.js','pwa.js','debug.js','startup.js'];
    Promise.all(files.map(function(f){
      return fetch('src/'+f).then(function(r){return r.ok?r.text():'';}).catch(function(){return '';});
    })).then(function(parts){
      const src=parts.join('\n');
      if(!src.trim())return;
      const quotas=[[/state\.logs\.unshift/g,1],[/state\.logs\.push/g,1],[/state\.logs\.length\s*=/g,1],[/state\.logs\s*=(?!=)/g,2]];
      const hits=[];
      quotas.forEach(function(q){
        const n=(src.match(q[0])||[]).length;
        if(n>q[1])hits.push(q[0].source+' ×'+n+'（上限 '+q[1]+'）');
      });
      if(hits.length)console.warn('[dev] 检测到日志直写回潮：'+hits.join('；'));
    }).catch(function(){});
  }
}

export { renderDebugReport, runConsistencyChecks, devAuditLogWrites };
