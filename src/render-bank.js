import { registerRenderer } from './render.js';
import { eachStatsBucket, weekScore } from './conditions.js';
import { LOG_DISPLAY } from './constants.js';
import { delDomain, delMetric, openMetricModal, renameDomain } from './library.js';
import { openAchModal } from './modals.js';
import { dayKey, weekStartTs, logAmt, esc, fmt, fmtTime, now } from './pure.js';
import { achCardHTML, setScoreCell } from './render-work.js';
import { state } from './state.js';
import { accountLabel, shadowLabel } from './stats.js';
import { addDays, dayDiff, dayStart as dayStartOf, weekStart } from './time.js';
import { drag, toggleCollapse } from './ui-events.js';
import { UNDO_ADAPTERS, undoLog } from './undo.js';
import { domainName, domainProgress, metricValue, totalProgress } from './utils.js';
// render-bank.js —— 渲染：银行页（图表/雷达）
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== Render: Bank =====
function renderBank(){
  setScoreCell('bVitality',state.scores.vitality);
  setScoreCell('bProgress',totalProgress());
  setScoreCell('bAchievement',state.scores.achievement);

  // Radar (domain capability) + metric chips
  renderRadar();
  renderMetricChips();

  // Loan display
  const lb=document.getElementById('loanBox');
  if(state.loans&&state.loans.length>0){
    lb.style.display='block';
    let lhtml='<div class="lb-title">贷款 ('+state.loans.length+'笔)</div>';
    lhtml+=state.loans.map(l=>{
      const cn=l.currency==='vitality'?'活力点':'成果点';
      const days=l.date?Math.max(0,dayDiff(now(),l.date)):0;
      const dailyInterest=l.debtRate>0?l.amount*(l.debtRate/100):0;
      return '<div class="loan-item">'
        +'<div class="li-name">'+esc(l.productName)+' · '+cn+(l.debtRate>0?' · 债率'+fmt(l.debtRate)+'%/天':'')+'</div>'
        +'<div class="li-amt">欠 '+fmt(l.amount)+(days>0?' · 已借'+days+'天':'')+(dailyInterest>0?' · 日息-'+fmt(dailyInterest):'')+'</div>'
        +'</div>';
    }).join('');
    lb.innerHTML=lhtml;
  }else{
    lb.style.display='none';
  }

  // Stats：全部读 ext.stats 生命周期计数器（不再扫 state.logs，日志截断后仍稳定）
  const stat=state.ext.stats;
  const vIn=Number(stat.lifetimeVitalityIn)||0,vOut=-(Number(stat.lifetimeVitalityOut)||0);
  const pIn=Number(stat.lifetimeProgressIn)||0;
  const aIn=Number(stat.lifetimeAchievementIn)||0,aOut=-(Number(stat.lifetimeAchievementOut)||0);
  const totalCI=Number(stat.totalCheckins)||0;
  const unlocked=state.achievements.filter(a=>a.unlocked).length;
  const purchases=Number(stat.totalPurchases)||0;

  const vIncomeEl=document.getElementById('vIncome');
  vIncomeEl.textContent=fmt(vIn);
  vIncomeEl.classList.toggle('neg',vIn<0);
  document.getElementById('vSpend').textContent=fmt(vOut);
  const pIncomeEl=document.getElementById('pIncome');
  pIncomeEl.textContent=fmt(pIn);
  pIncomeEl.classList.toggle('neg',pIn<0);
  document.getElementById('totalCheckins').textContent=totalCI;
  const aIncomeEl=document.getElementById('aIncome');
  aIncomeEl.textContent=fmt(aIn);
  aIncomeEl.classList.toggle('neg',aIn<0);
  document.getElementById('achUnlocked').textContent=unlocked;
  const aSpendEl=document.getElementById('aSpend');
  aSpendEl.textContent=fmt(aOut);
  aSpendEl.classList.toggle('neg',aOut<0);
  document.getElementById('totalPurchases').textContent=purchases;

  document.getElementById('bVitalitySub').textContent='收入'+fmt(vIn)+' / 消费'+fmt(vOut);
  document.getElementById('bProgressSub').textContent=state.domains.length+'个领域';
  document.getElementById('bAchSub').textContent='收入'+fmt(aIn)+' / 消费'+fmt(aOut);

  // Milestones grouped by domain
  const ag=document.getElementById('achGroups');
  if(!state.achievements.length){
    ag.innerHTML='<div class="empty"><p>设定里程碑，领域进度达标后自动解锁成果点</p><button class="btn btn-sm" onclick="openAchModal()">新建里程碑</button></div>';
  }else{
    let ahtml='';
    state.domains.forEach(d=>{
      const achs=state.achievements.filter(a=>a.domainId===d.id);
      if(achs.length===0)return;
      const isCollapsed=(state.collapsedAchDoms||[]).includes(d.id);
      const showHeader=state.domains.length>1;
      ahtml+='<div class="ach-dom-group'+(isCollapsed?' collapsed':'')+'" data-dom-id="'+d.id+'">';
      if(showHeader){
        ahtml+='<div class="coll-header" onclick="toggleCollapse(\'ach-domain\',\''+d.id+'\')">';
        ahtml+='<div class="coll-name"><span class="coll-toggle">▼</span>'+esc(d.name)+' <span class="coll-count">'+achs.length+'个里程碑</span></div>';
        ahtml+='<div class="coll-actions" onclick="event.stopPropagation()">';
        ahtml+='<span class="drag-handle" title="拖拽领域">⋮⋮</span>';
        if(d.id!=='d_default'){
          ahtml+='<button onclick="renameDomain(\''+d.id+'\')">重命名</button><button onclick="delDomain(\''+d.id+'\')">删除</button>';
        }
        ahtml+='<button onclick="openAchModal(null,\''+d.id+'\')">+ 里程碑</button>';
        ahtml+='</div>';
        ahtml+='</div>';
      }
      ahtml+='<div class="coll-body">';
      ahtml+=achs.map(a=>achCardHTML(a,d.id)).join('');
      ahtml+='</div>';
      ahtml+='</div>';
    });
    ag.innerHTML=ahtml;
  }

  drawChart();
  drawVitalityFlowChart();
  drawWeekCompareChart();

  // Logs
  const logTotal=state.logs.length;
  document.getElementById('logMeta').textContent=logTotal+' 条'+(logTotal>LOG_DISPLAY?'（仅显示最近 '+LOG_DISPLAY+' 条）':'');
  const ll=document.getElementById('logList');
  if(!state.logs.length){
    ll.innerHTML='<div class="empty" style="padding:24px"><p style="margin:0">暂无记录</p></div>';
  }else{
    // 可撤销白名单直接来自适配器注册表：新增一种可撤销类型只需在 UNDO_ADAPTERS 加 key
    const undoableSrc=Object.keys(UNDO_ADAPTERS);
    ll.innerHTML=state.logs.slice(0,LOG_DISPLAY).map(l=>{
      const isBoth=l.st==='both';
      const cls=l.amt>0?'pos'+(isBoth||l.st==='progress'?' p':l.st==='achievement'?' a':''):l.amt<0?'neg':'zero';
      const dotCls=isBoth?'p':l.st==='vitality'?'v':l.st==='progress'?'p':l.st==='achievement'?'a':'s';
      let amtTxt='',unit='';
      if(isBoth){
        // both 型打卡两个分值可能不同：分别显示，避免只看净活力误解进度收入
        const av=logAmt(l,'vitality'),ap=logAmt(l,'progress');
        amtTxt=(av>0?'+':'')+fmt(av)+' 活力 / '+(ap>0?'+':'')+fmt(ap)+' 进度';
      }else{
        const sign=l.amt>0?'+':'';
        amtTxt=l.amt!==0?sign+fmt(l.amt):'—';
        unit=l.st==='vitality'?' 活力':l.st==='progress'?' 进度':l.st==='achievement'?' 成果':l.st==='card'?' 张':'';
      }
      const canUndo=undoableSrc.includes(l.src);
      return '<div class="log-item">'
        +'<div class="log-dot '+dotCls+'"></div>'
        +'<div class="log-desc">'+esc(l.desc)+'</div>'
        +'<div class="log-amt '+cls+'">'+amtTxt+unit+'</div>'
        +'<div class="log-time">'+fmtTime(l.time)+'</div>'
        +(canUndo?'<button class="log-undo" onclick="undoLog(\''+l.id+'\')">撤销</button>':'')
        +'</div>';
    }).join('');
  }

  renderShadowList();
}
// 余额调整记录：visible:false 的账户增减在这里留痕（贷款放款、撤销、活动回收、删除搬运、重算等）
function toggleShadowList(){
  const el=document.getElementById('shadowList');
  if(!el)return;
  el.style.display=el.style.display==='none'?'block':'none';
}
function renderShadowList(){
  const el=document.getElementById('shadowList');
  const meta=document.getElementById('shadowMeta');
  if(!el)return;
  const list=(state.ext&&Array.isArray(state.ext.shadow))?state.ext.shadow:[];
  if(meta)meta.textContent=list.length?(list.length+' 条'):'暂无';
  if(!list.length){
    el.innerHTML='<div class="empty" style="padding:16px"><p style="margin:0">暂无余额调整（贷款、撤销、活动回收等会记录在这里）</p></div>';
    return;
  }
  el.innerHTML=list.map(function(r){
    const d=Number(r.delta)||0;
    const unit=r.acct==='vitality'?' 活力':r.acct==='achievement'?' 成果':r.acct.indexOf('progress:')===0?' 进度':r.acct.indexOf('card:')===0?' 张':'';
    const amt=(d>0?'+':'')+fmt(d)+unit;
    const cls=d>0?'pos':d<0?'neg':'zero';
    const range=(r.before!==null&&r.before!==undefined)?(' · '+fmt(r.before)+' → '+fmt(r.after)):'';
    return '<div class="log-item">'
      +'<div class="log-dot s"></div>'
      +'<div class="log-desc">'+esc(r.label||shadowLabel(r.src,''))+'<span style="color:var(--text-3);font-size:11px"> · '+esc(accountLabel(r.acct||''))+range+'</span></div>'
      +'<div class="log-amt '+cls+'">'+amt+'</div>'
      +'<div class="log-time">'+fmtTime(r.ts)+'</div>'
      +'</div>';
  }).join('');
}

// ===== Chart state & interactivity =====
var chartState={trendMode:'cumulative',hiddenSeries:{vitality:false,progress:false,achievement:false}};

function toggleChartSeries(type){
  chartState.hiddenSeries[type]=!chartState.hiddenSeries[type];
  // Update legend visual state
  document.querySelectorAll('.ch-legend .clickable').forEach(el=>{
    const map={'活力':'vitality','进度':'progress','成果':'achievement'};
    const t=map[el.textContent.trim()];
    if(t)el.classList.toggle('dimmed',chartState.hiddenSeries[t]);
  });
  drawChart();
}

function toggleTrendMode(){
  chartState.trendMode=chartState.trendMode==='cumulative'?'daily':'cumulative';
  document.getElementById('trendModeBtn').textContent=chartState.trendMode==='cumulative'?'日增':'累积';
  drawChart();
}

function showChartTip(e,html){
  const tip=document.getElementById('chartTooltip');
  tip.innerHTML=html;
  tip.style.display='block';
  tip.style.left=(e.clientX+12)+'px';
  tip.style.top=(e.clientY-10)+'px';
}
function hideChartTip(){
  document.getElementById('chartTooltip').style.display='none';
}

function drawChart(){
  const svg=document.getElementById('trendChart');
  const days=7;
  const todayTs=dayStartOf(now());
  const dayLabels=[],dayStart=[],dayEnd=[];
  for(let i=days-1;i>=0;i--){
    const ts=addDays(todayTs,-i);
    const d=new Date(ts);
    dayLabels.push((d.getMonth()+1)+'/'+d.getDate());
    dayStart.push(ts);
    dayEnd.push(addDays(ts,1));
  }
  const types=['vitality','progress','achievement'];
  const typeNames={vitality:'活力',progress:'进度',achievement:'成果'};
  // 取色直接读主题 CSS 变量，避免深/浅色再硬编码一份
  const rootStyle=getComputedStyle(document.documentElement);
  function cssVar(name,fallback){const v=(rootStyle.getPropertyValue(name)||'').trim();return v||fallback;}
  const colors={
    vitality:cssVar('--vitality','#5b9a6e'),
    progress:cssVar('--progress','#5b7fa8'),
    achievement:cssVar('--achievement','#b08640')
  };
  const gridColor=cssVar('--border','#e0e0e0');
  const labelColor=cssVar('--text-3','#aaa');
  const zeroColor=cssVar('--border-2','#ccc');
  // 统计日桶一次遍历（每类每天净额）；累计模式再做前缀和，不再扫描 state.logs
  const windowStart=dayStart[0];
  const windowEnd=dayEnd[days-1];
  const before={};
  const daily={};
  types.forEach(type=>{before[type]=0;daily[type]=new Array(days).fill(0);});
  const dayIndex={};
  dayStart.forEach(function(ts,i){dayIndex[dayKey(ts)]=i;});
  const typeKey={vitality:'v',progress:'p',achievement:'a'};
  const st=state.ext&&state.ext.stats;
  if(st&&st.daily){
    const startKey=dayKey(windowStart);
    Object.keys(st.daily).forEach(function(k){
      const b=st.daily[k];
      if(!b)return;
      if(k<startKey){
        types.forEach(type=>{before[type]+=Number(b[typeKey[type]])||0;});
        return;
      }
      const i=dayIndex[k];
      if(i===undefined)return;
      types.forEach(type=>{daily[type][i]+=Number(b[typeKey[type]])||0;});
    });
  }
  const series={};
  types.forEach(type=>{
    series[type]=[];
    let run=before[type];
    for(let i=0;i<days;i++){
      if(chartState.trendMode==='cumulative'){
        run+=daily[type][i];
        series[type].push(run);
      }else{
        series[type].push(daily[type][i]);
      }
    }
  });
  let maxVal=1;
  types.forEach(type=>{
    if(chartState.hiddenSeries[type])return;
    series[type].forEach(v=>{if(Math.abs(v)>maxVal)maxVal=Math.abs(v)});
  });
  const W=700,H=140,padL=36,padR=8,padT=8,padB=22;
  const cW=W-padL-padR,cH=H-padT-padB,stepX=cW/(days-1);
  // 基线：任一可见序列出现负值（负债）时，0 线居中、上下对称展开；
  // daily 与 cumulative 都适用，避免累计模式下负值折线跑到图表下方
  const hasNeg=types.some(t=>!chartState.hiddenSeries[t]&&series[t].some(v=>v<0));
  const baseline=hasNeg?padT+cH/2:padT+cH;
  function pt(type,i){
    const x=padL+i*stepX;
    const y=baseline-(series[type][i]/maxVal)*(hasNeg?cH/2:cH);
    return[x,y];
  }
  let s='';
  // Grid lines
  for(let g=0;g<=4;g++){
    const y=padT+(cH/4)*g;
    // 有负值时纵轴从 +maxVal 到 -maxVal，0 刻度正好落在居中基线上
    const val=hasNeg?Math.round(maxVal-(maxVal/2)*g):Math.round(maxVal-(maxVal/4)*g);
    s+='<line x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'" stroke="'+gridColor+'" stroke-width="1"/>';
    s+='<text x="'+(padL-5)+'" y="'+(y+3)+'" text-anchor="end" font-size="9" fill="'+labelColor+'">'+val+'</text>';
  }
  // 0 线（daily / cumulative 有负值时均绘制）
  if(hasNeg){
    s+='<line x1="'+padL+'" y1="'+baseline+'" x2="'+(W-padR)+'" y2="'+baseline+'" stroke="'+zeroColor+'" stroke-width="1.5"/>';
  }
  // X axis labels
  dayLabels.forEach((label,i)=>{
    const x=padL+i*stepX;
    s+='<text x="'+x+'" y="'+(H-5)+'" text-anchor="middle" font-size="9" fill="'+labelColor+'">'+label+'</text>';
  });
  // Draw lines and dots for each visible series
  types.forEach(type=>{
    if(chartState.hiddenSeries[type])return;
    let path='';
    series[type].forEach((v,i)=>{
      const[x,y]=pt(type,i);
      path+=(i===0?'M':'L')+x+','+y+' ';
    });
    s+='<path class="svg-line" d="'+path+'" fill="none" stroke="'+colors[type]+'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>';
    series[type].forEach((v,i)=>{
      const[x,y]=pt(type,i);
      const tipHtml=typeNames[type]+' · '+dayLabels[i]+'<br><b>'+fmt(v)+'</b>';
      s+='<circle class="svg-dot" cx="'+x+'" cy="'+y+'" r="3" fill="'+colors[type]+'" onmouseover="showChartTip(event,\''+tipHtml.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
    });
  });
  svg.innerHTML=s;
}

function drawVitalityFlowChart(){
  const svg=document.getElementById('flowChart');
  const weeks=4;
  const todayTs=dayStartOf(now());
  // Calculate week boundaries
  const weekRanges=[];
  for(let i=0;i<weeks;i++){
    const end=i===0?addDays(todayTs,1):weekRanges[i-1].start;
    const start=addDays(end,-7);
    weekRanges.push({start:start,end:end});
  }
  const weekLabels=weekRanges.map((wr,i)=>{
    if(i===0)return'本周';
    if(i===1)return'上周';
    return(i+1)+'周前';
  });
  // For each week, categorize vitality flow:
  // 产出: vitality earned from check-ins (src='checkin', st='vitality', amt>0)
  // 投资: vitality spent on progress task costs (src='cost', amt<0)
  // 消费: vitality spent on shop purchases (src='purchase', st='vitality', amt<0)
  const produceData=[],investData=[],consumeData=[];
  weekRanges.forEach(wr=>{
    let prod=0,inv=0,cons=0;
    eachStatsBucket(wr.start,wr.end,function(b){
      prod+=Number(b.prod)||0;
      inv+=Number(b.inv)||0;
      cons+=Number(b.cons)||0;
    });
    produceData.push(prod);
    investData.push(inv);
    consumeData.push(cons);
  });
  const maxVal=Math.max(1,...produceData,...investData,...consumeData);
  const isDark=document.documentElement.getAttribute('data-theme')==='dark';
  const colorProd=isDark?'#7ab088':'#5b9a6e';
  const colorInv=isDark?'#7894b5':'#5b7fa8';
  const colorCons=isDark?'#c47b6e':'#c2615a';
  const gridColor=isDark?'#42424a':'#e0e0e0';
  const labelColor=isDark?'#6e6e74':'#aaa';
  const W=700,H=180,padL=36,padR=8,padT=8,padB=30;
  const cW=W-padL-padR,cH=H-padT-padB;
  const groupW=cW/weeks;
  const barW=groupW*0.18;
  const gap=barW*0.25;
  let s='';
  // Grid lines
  for(let g=0;g<=4;g++){
    const y=padT+(cH/4)*g;
    const val=Math.round(maxVal-(maxVal/4)*g);
    s+='<line x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'" stroke="'+gridColor+'" stroke-width="1"/>';
    s+='<text x="'+(padL-5)+'" y="'+(y+3)+'" text-anchor="end" font-size="9" fill="'+labelColor+'">'+val+'</text>';
  }
  // Bars and labels for each week
  weekLabels.forEach((label,i)=>{
    const gc=padL+groupW*i+groupW/2;
    // Production bar (left)
    const pH=(produceData[i]/maxVal)*cH;
    const pX=gc-gap*1.5-barW;
    const pY=padT+cH-pH;
    const pTip='产出 · '+label+'<br><b>'+fmt(produceData[i])+'</b> 活力';
    s+='<rect class="svg-bar" x="'+pX+'" y="'+pY+'" width="'+barW+'" height="'+pH+'" fill="'+colorProd+'" rx="2" onmouseover="showChartTip(event,\''+pTip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
    // Investment bar (center)
    const iH=(investData[i]/maxVal)*cH;
    const iX=gc-barW/2;
    const iY=padT+cH-iH;
    const iTip='投资 · '+label+'<br><b>'+fmt(investData[i])+'</b> 活力 → 进度任务';
    s+='<rect class="svg-bar" x="'+iX+'" y="'+iY+'" width="'+barW+'" height="'+iH+'" fill="'+colorInv+'" rx="2" onmouseover="showChartTip(event,\''+iTip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
    // Consumption bar (right)
    const cH2=(consumeData[i]/maxVal)*cH;
    const cX=gc+gap*1.5;
    const cY=padT+cH-cH2;
    const cTip='消费 · '+label+'<br><b>'+fmt(consumeData[i])+'</b> 活力 → 商店购买';
    s+='<rect class="svg-bar" x="'+cX+'" y="'+cY+'" width="'+barW+'" height="'+cH2+'" fill="'+colorCons+'" rx="2" onmouseover="showChartTip(event,\''+cTip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
    // Week label
    s+='<text x="'+gc+'" y="'+(H-14)+'" text-anchor="middle" font-size="9" fill="'+labelColor+'">'+label+'</text>';
    // Efficiency rate below
    const totalSpend=investData[i]+consumeData[i];
    const rate=totalSpend>0?Math.round(investData[i]/totalSpend*100):0;
    const rateColor=rate>=50?colorInv:colorCons;
    s+='<text x="'+gc+'" y="'+(H-3)+'" text-anchor="middle" font-size="9" fill="'+rateColor+'" font-weight="600">投资率 '+rate+'%</text>';
  });
  // Baseline
  s+='<line x1="'+padL+'" y1="'+(padT+cH)+'" x2="'+(W-padR)+'" y2="'+(padT+cH)+'" stroke="'+(isDark?'#5a5a60':'#ccc')+'" stroke-width="1.5"/>';
  svg.innerHTML=s;
}

function drawWeekCompareChart(){
  const svg=document.getElementById('weekCompareChart');
  if(!svg)return;
  const summaryEl=document.getElementById('weekCompareSummary');
  const weeks=6,anchor=1;
  const todayTs=dayStartOf(now());
  const ranges=[];
  for(let i=weeks-1;i>=0;i--){
    const start=addDays(weekStart(todayTs,anchor),-i*7);
    ranges.push({start:start,end:addDays(start,7)});
  }
  const data=ranges.map((r,i)=>{
    const w=weekScore(r.start,r.end);
    const label=i===weeks-1?'本周':i===weeks-2?'上周':((weeks-1-i)+'周前');
    return {label:label,score:w.score,investRate:w.investRate,prog:w.prog,vit:w.vit,ach:w.ach,checkins:w.checkins,invest:w.invest,consume:w.consume};
  });
  const cur=data[weeks-1],prev=data[weeks-2];
  if(summaryEl&&cur&&prev){
    const delta=cur.score-prev.score;
    const cls=delta>0?'up':delta<0?'down':'';
    const arrow=delta>0?'↑':delta<0?'↓':'＝';
    summaryEl.innerHTML='<b>'+fmt(cur.score)+'</b> vs <b>'+fmt(prev.score)+'</b> <span class="'+cls+'">'+arrow+' '+fmt(Math.abs(delta))+'</span>';
  }
  const isDark=document.documentElement.getAttribute('data-theme')==='dark';
  const colorBar=isDark?'#7894b5':'#5b7fa8';
  const colorNeg=isDark?'#c87060':'#c0564e';
  const colorLine=isDark?'#7ab088':'#5b9a6e';
  const gridColor=isDark?'#42424a':'#e0e0e0';
  const labelColor=isDark?'#6e6e74':'#aaa';
  let minScore=0,maxScore=1;
  data.forEach(d=>{if(d.score<minScore)minScore=d.score;if(d.score>maxScore)maxScore=d.score;});
  if(minScore>0)minScore=0;
  if(maxScore<=0)maxScore=1;
  const W=700,H=220,padL=42,padR=48,padT=14,padB=26;
  const cW=W-padL-padR,cH=H-padT-padB;
  const groupW=cW/weeks,barW=groupW*0.5;
  const range=(maxScore-minScore)||1;
  const yScore=v=>padT+cH-((v-minScore)/range)*cH;
  const yInvest=v=>padT+cH-(Math.max(0,Math.min(100,v))/100)*cH;
  const xCenter=i=>padL+groupW*i+groupW/2;
  let s='';
  for(let g=0;g<=4;g++){
    const y=padT+(cH/4)*g;
    const val=maxScore-(range/4)*g;
    s+='<line x1="'+padL+'" y1="'+y+'" x2="'+(W-padR)+'" y2="'+y+'" stroke="'+gridColor+'" stroke-width="1"/>';
    s+='<text x="'+(padL-5)+'" y="'+(y+3)+'" text-anchor="end" font-size="9" fill="'+labelColor+'">'+fmt(val)+'</text>';
  }
  if(minScore<0){
    const y0=yScore(0);
    s+='<line x1="'+padL+'" y1="'+y0+'" x2="'+(W-padR)+'" y2="'+y0+'" stroke="'+(isDark?'#5a5a60':'#ccc')+'" stroke-width="1.2"/>';
  }
  [['0','0%'],['50','50%'],['100','100%']].forEach(pair=>{
    const y=yInvest(Number(pair[0]));
    s+='<text x="'+(W-padR+6)+'" y="'+(y+3)+'" font-size="9" fill="'+labelColor+'">'+pair[1]+'</text>';
  });
  let ratePath='';
  data.forEach((d,i)=>{
    const x=xCenter(i),y=yInvest(d.investRate);
    ratePath+=(i===0?'M':'L')+x+','+y+' ';
  });
  s+='<path d="'+ratePath+'" fill="none" stroke="'+colorLine+'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>';
  data.forEach((d,i)=>{
    const x=xCenter(i),y=yInvest(d.investRate);
    const rTip=d.label+' 投资率 <b>'+fmt(d.investRate)+'%</b>';
    s+='<circle cx="'+x+'" cy="'+y+'" r="3" fill="'+colorLine+'" onmouseover="showChartTip(event,\''+rTip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
  });
  data.forEach((d,i)=>{
    const x=xCenter(i);
    const y0=yScore(0),yy=yScore(d.score);
    const yTop=Math.min(y0,yy),hBar=Math.max(1,Math.abs(yy-y0));
    const fill=d.score<0?colorNeg:colorBar;
    const tip='<b>'+d.label+'</b> 总分 '+fmt(d.score)
      +'<br>进度 +'+fmt(d.prog)+'　活力 '+fmt(d.vit)
      +'<br>成果 +'+fmt(d.ach)+'　打卡 '+d.checkins+'次'
      +'<br>投资 '+fmt(d.invest)+'　消费 '+fmt(d.consume)
      +'<br>投资率 '+fmt(d.investRate)+'%';
    s+='<rect class="svg-bar" x="'+(x-barW/2)+'" y="'+yTop+'" width="'+barW+'" height="'+hBar+'" fill="'+fill+'" rx="2" onmouseover="showChartTip(event,\''+tip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
    s+='<text x="'+x+'" y="'+(yTop-4)+'" text-anchor="middle" font-size="9" font-weight="600" fill="'+labelColor+'">'+fmt(d.score)+'</text>';
    s+='<text x="'+x+'" y="'+(H-8)+'" text-anchor="middle" font-size="9" fill="'+labelColor+'">'+d.label+'</text>';
  });
  svg.innerHTML=s;
}

// ===== Render: Radar (domain capability) =====
function renderRadar(){
  const svg=document.getElementById('radarChart');
  const empty=document.getElementById('radarEmpty');
  const metrics=state.metrics||[];
  if(!metrics.length){
    svg.style.display='none';
    empty.style.display='block';
    empty.innerHTML='<p>尚未设定指标，雷达图将按指标汇总领域进度展示</p><button class="btn btn-sm" onclick="openMetricModal()">新建指标</button>';
    return;
  }
  svg.style.display='block';
  empty.style.display='none';
  empty.innerHTML='';
  // Radar rendering
  const isDark=document.documentElement.getAttribute('data-theme')==='dark';
  const colorMain=isDark?'#7894b5':'#5b7fa8';
  const colorFill=isDark?'rgba(120,148,181,.18)':'rgba(91,127,168,.15)';
  const colorNeg=isDark?'#c87060':'#c0564e';
  const gridColor=isDark?'#42424a':'#e0e0e0';
  const labelColor=isDark?'#6e6e74':'#888';
  const N=metrics.length;
  const vals=metrics.map(m=>metricValue(m));
  const maxVal=Math.max(1,...vals.map(v=>Math.abs(v)));
  const cx=150,cy=150,R=88;
  const ang=i=>-Math.PI/2+i*(2*Math.PI/N);
  const xyr=(i,r)=>{const a=ang(i);return[cx+Math.cos(a)*r,cy+Math.sin(a)*r]};
  // Radii for grid rings (clamp negatives to 0)
  const rad=i=>Math.max(0,Math.min(1,vals[i]/maxVal))*R;
  let s='';
  // Concentric grid polygons (4 rings)
  for(let ring=1;ring<=4;ring++){
    const rr=R*ring/4;
    let pts='';
    for(let i=0;i<N;i++){const[x,y]=xyr(i,rr);pts+=(i?' ':'')+x+','+y;}
    s+='<polygon points="'+pts+'" fill="none" stroke="'+gridColor+'" stroke-width="1"/>';
    // Ring value label (small, top-left)
    const ringVal=Math.round(maxVal*ring/4*100)/100;
    s+='<text x="'+(cx+8)+'" y="'+(cy-rr)+'" font-size="8" fill="'+labelColor+'">'+fmt(ringVal)+'</text>';
  }
  // Axis lines
  for(let i=0;i<N;i++){
    const[x,y]=xyr(i,R);
    s+='<line x1="'+cx+'" y1="'+cy+'" x2="'+x+'" y2="'+y+'" stroke="'+gridColor+'" stroke-width="1"/>';
  }
  // Data polygon
  let dataPts='';
  for(let i=0;i<N;i++){const[x,y]=xyr(i,rad(i));dataPts+=(i?' ':'')+x+','+y;}
  s+='<polygon points="'+dataPts+'" fill="'+colorFill+'" stroke="'+colorMain+'" stroke-width="1.5" stroke-linejoin="round"/>';
  // Vertices + labels + hit areas
  metrics.forEach((m,i)=>{
    const[x,y]=xyr(i,rad(i));
    const neg=vals[i]<0;
    const shortName=m.name.length>6?m.name.slice(0,6)+'…':m.name;
    // Axis name label (outside vertex)
    const lx2=cx+Math.cos(ang(i))*(R+18), ly2=cy+Math.sin(ang(i))*(R+18);
    const anchor=Math.abs(Math.cos(ang(i)))<0.3?'middle':(Math.cos(ang(i))>0?'start':'end');
    s+='<text x="'+lx2+'" y="'+ly2+'" text-anchor="'+anchor+'" font-size="10" fill="'+labelColor+'">'+esc(shortName)+'</text>';
    // Value label (inside/near vertex)
    const vx=cx+Math.cos(ang(i))*(rad(i)+14), vy=cy+Math.sin(ang(i))*(rad(i)+14);
    s+='<text x="'+vx+'" y="'+vy+'" text-anchor="middle" font-size="9" font-weight="600" fill="'+(neg?colorNeg:colorMain)+'">'+fmt(vals[i])+'</text>';
    // Vertex dot
    s+='<circle cx="'+x+'" cy="'+y+'" r="3" fill="'+(neg?colorNeg:colorMain)+'"/>';
    // Hit area for tooltip
    const tip='<b>'+esc(m.name)+'</b><br>总值 '+fmt(vals[i])
      +(m.domainIds||[]).map(did=>'<br>· '+esc(domainName(did))+' '+fmt(domainProgress(did))).join('');
    s+='<circle cx="'+x+'" cy="'+y+'" r="10" fill="transparent" style="cursor:pointer" onmouseover="showChartTip(event,\''+tip.replace(/'/g,'\\\'')+'\')" onmouseout="hideChartTip()"/>';
  });
  svg.innerHTML=s;
}
function renderMetricChips(){
  const mc=document.getElementById('metricChips');
  if(!mc)return;
  const metrics=state.metrics||[];
  let html=metrics.map(m=>{
    const val=metricValue(m);
    const doms=(m.domainIds||[]).map(did=>domainName(did)).join('、');
    return '<div class="metric-chip" onclick="openMetricModal(\''+m.id+'\')" title="领域：'+esc(doms)+'">'
      +'<span class="mc-name">'+esc(m.name)+'</span>'
      +'<span class="mc-val'+(val<0?' neg':'')+'">'+fmt(val)+'</span>'
      +'<button class="mc-del" title="删除指标" onclick="event.stopPropagation();delMetric(\''+m.id+'\')">×</button>'
      +'</div>';
  }).join('');
  html+='<div class="metric-chip add" onclick="openMetricModal()">+ 指标</div>';
  mc.innerHTML=html;
}

export { renderBank, toggleShadowList, renderShadowList, chartState, toggleChartSeries, toggleTrendMode, showChartTip, hideChartTip, drawChart, drawVitalityFlowChart, drawWeekCompareChart, renderRadar, renderMetricChips };

registerRenderer('bank', renderBank);
