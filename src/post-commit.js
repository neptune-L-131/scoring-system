// post-commit.js —— 事务提交后的副作用队列（叶子模块，不 import 任何业务模块）
//
// 用途：发起方（打卡/购买）在事务内把事件描述放进返回值，runCommand 在 Ledger.txn
// 成功提交之后调用 emitPostCommit；真正的执行器由 event-bus.js 在模块加载时注册。
// 这样调用链上不会出现 business → event-bus → flow-engine → flow-atoms → business 的环。
let handler = null;
let dispatching = false;

export function setPostCommitHandler(fn) {
  handler = (typeof fn === 'function') ? fn : null;
}

export function isPostCommitDispatching() {
  return dispatching;
}

// 事务已提交后调用。返回 ok:false 时发起方事务依然有效——这里永远不会向调用方抛错。
export function emitPostCommit(events, meta) {
  if (!Array.isArray(events) || !events.length) return { ok: true, handled: 0, skipped: true };
  if (!handler) return { ok: false, code: 'POST_COMMIT_NO_HANDLER' };
  if (dispatching) {
    // 重入：深度固定为 1，只登记事件、不再派发，绝不递归执行流
    try {
      handler(events, { nested: true });
      return { ok: true, handled: 0, nested: true };
    } catch (e) {
      return { ok: false, code: 'POST_COMMIT_ERROR', nested: true };
    }
  }
  dispatching = true;
  try {
    handler(events, { nested: false });
    return { ok: true, handled: events.length };
  } catch (e) {
    return { ok: false, code: 'POST_COMMIT_ERROR' };
  } finally {
    dispatching = false;
  }
}
