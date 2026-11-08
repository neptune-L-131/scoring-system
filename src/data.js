import { BudgetEngine } from './budget.js';
import { BACKUP_KEY, SCHEMA_VERSION } from './constants.js';
import { loadIssue, parseState, setLoadIssue, setPersistBlocked } from './normalize.js';
import { commit } from './persist.js';
import { setState, state } from './state.js';
import { toast } from './toast.js';
// data.js —— 导出/导入
// 由 app.js 按功能拆分（第五轮可维护性重构），行为不变。

// ===== Export / Import =====
function markBackup(){try{localStorage.setItem(BACKUP_KEY,String(Date.now()));}catch(e){}}
function maybeBackupReminder(){
  let last=0;
  try{last=Number(localStorage.getItem(BACKUP_KEY))||0;}catch(e){}
  if(!last)return;
  const days=(Date.now()-last)/864e5;
  if(days>=7){
    toast('已 '+Math.floor(days)+' 天未备份数据，建议「导出」一份备份','warn');
  }
}
function exportData(){
  const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;a.download='计分系统_'+new Date().toISOString().slice(0,10)+'.json';
  a.click();URL.revokeObjectURL(url);
  markBackup();
  toast('数据已导出');
}
function importData(ev){
  const f=ev.target.files[0];if(!f)return;
  const r=new FileReader();
  r.onload=function(e){
    const raw=e.target.result;
    try{
      const probe=JSON.parse(raw);
      // 只接受当前 schema 的导出：低版本数据不再导入时迁移，避免两套迁移口径漂移
      if(!probe||typeof probe!=='object'||Array.isArray(probe)||!probe.scores||!probe.schema||probe.schema.v!==SCHEMA_VERSION)throw 0;
    }catch(err){toast('导入失败：仅支持当前版本（v'+SCHEMA_VERSION+'）导出的数据','err');return;}
    // 统一走 parseState 的迁移口径，避免导入/加载两套迁移规则漂移
    setLoadIssue(null);
    const s=parseState(raw);
    if(loadIssue){toast('导入失败：格式不正确','err');return;}
    setState(s);
    // 用户已显式导入：解除读档失败造成的写入暂停
    setPersistBlocked(false);
    const rb=document.getElementById('recoverBar');if(rb)rb.style.display='none';
    // 导入后补一次预算结算：导入的历史周期应立刻结清，不必等下次记账
    BudgetEngine.reconcileAll();
    commit('导入成功');
  };
  r.readAsText(f);ev.target.value='';
}

export { markBackup, maybeBackupReminder, exportData, importData };
