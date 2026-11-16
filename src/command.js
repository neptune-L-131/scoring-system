import { Ledger } from './ledger.js';
import { save } from './persist.js';
import { render } from './render.js';
import { toast } from './toast.js';
// command.js —— 命令层：事务 + 落盘 + 渲染 + 提示的统一入口（第五轮 S1-A）
//
// 为什么需要它：引擎函数原先各自调 save()/render()/toast()，失败时还要记得
// "回滚后不落盘"这类约定，容易漏。命令层把这件事收成一个入口：
//   - 统一开 Ledger.txn（nested 时直接复用外层事务，不重复快照）；
//   - run 里只做纯状态与账务写入，通过返回值描述要给用户的提示；
//   - 成功才 save()/render()，失败统一回滚并只提示一次。
// Ledger.txn 本身不改：它已经负责快照、还原、audit 与统计折叠。

function abort(code, reason) {
  const e = new Error(code);
  e.__txn = true;
  e.code = code;
  e.info = { reason: reason || '' };
  return e;
}

function showToast(t) {
  if (!t) return;
  if (typeof t === 'string') toast(t);
  else toast(t.msg, t.type);
}

// 失败文案：failText 显式返回空串表示“静默失败”（行为与迁移前一致：不提示）。
function failMessage(o, e) {
  const raw = (e && e.info && e.info.reason) || (typeof o.failText === 'function' ? o.failText(e) : o.failText);
  if (raw === '') return '';
  return raw || '操作失败';
}

// opts:
//   label       事务标签（写入 audit）
//   run(tx)     事务体；返回 {ok:true,...} 或 {ok:false,reason,code}
//   reject      run 之前就拒绝的动作（未开事务，只提示）
//   failText    失败文案；可传函数 (error) => string
//   onFail(err) 失败收尾（例如回填自动记账草稿）
//   toast       成功后的事务外提示（可选）
//   save/render 默认 true
//   preToasts   引擎返回的、需要在成功提示之前给出的提示（字符串或 {msg,type}）
function runCommand(opts) {
  const o = opts || {};
  if (o.reject) {
    showToast(o.reject.toast);
    if (o.render === true) render();
    return { ok: false, reason: o.reject.reason || '' };
  }
  // 嵌套调用（外层已经开着事务）：失败必须抛回外层，由外层事务边界统一回滚。
  // 若在这里兜底吞掉异常，外层会误判成功并提交，回滚语义就断了。
  const nested = Ledger.inTxn();
  let out = null;
  let txr;
  try {
    txr = Ledger.txn(function (tx) {
      const r = o.run(tx);
      // 引擎用 {ok:false} 表达的业务失败也必须整单回滚
      if (r && r.ok === false) throw abort(r.code || 'ABORTED', r.reason);
      out = r;
      return r;
    }, { label: o.label || 'command', save: 'none', render: false });
  } catch (e) {
    // Ledger 对非 __txn 异常会先还原快照再原样抛出，这里同样兜底
    if (o.onFail) o.onFail(e);
    if (nested) throw e;
    const msg = failMessage(o, e);
    if (msg && !o.silentFail) showToast({ msg: msg, type: 'err' });
    return { ok: false, reason: msg, error: e };
  }
  if (!txr.ok) {
    const msg = failMessage(o, txr.error);
    if (o.onFail) o.onFail(txr.error);
    if (msg && !o.silentFail) showToast({ msg: msg, type: 'err' });
    return { ok: false, reason: msg, error: txr.error };
  }
  // 嵌套事务：外层负责落盘与渲染，这里只补提示，绝不重复 save/render
  const pre = (out && out.preToasts) || [];
  pre.forEach(showToast);
  if (o.toast) showToast(o.toast);
  if (out && out.toast) showToast(out.toast);
  if (txr.nested) return { ok: true, value: out, nested: true };
  if (o.save !== false) save();
  if (o.render !== false) render();
  return { ok: true, value: out };
}

export { runCommand, showToast };
