/**
 * scheduler.js — 受限并发请求调度器
 * 批量扫描时逐只拉取数据，控制同时在途请求数，避免打爆 AxData。
 * 支持中途取消。
 */

/**
 * 创建并发调度器。
 * @param {function} taskRunner 异步任务函数：(item, index) => Promise<any>
 * @param {object} opts { concurrency = 3, onProgress(done, total, lastResult) }
 * @returns {{ run: (items) => Promise<array>, cancel: () => void }}
 */
export function createScheduler(taskRunner, opts = {}) {
  const concurrency = Math.max(1, Math.min(10, opts.concurrency || 3));
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  let cancelled = false;

  return {
    /** 依次执行所有任务（保序返回结果数组，失败项为 {__error} 标记对象） */
    async run(items) {
      const list = Array.isArray(items) ? items : [];
      const results = new Array(list.length);
      let cursor = 0;
      let done = 0;

      const worker = async () => {
        while (!cancelled) {
          const i = cursor++;
          if (i >= list.length) return;
          try {
            results[i] = await taskRunner(list[i], i);
          } catch (err) {
            results[i] = { __error: err };
          }
          done++;
          if (onProgress) {
            try { onProgress(done, list.length, results[i], i); } catch { /* 回调异常不影响调度 */ }
          }
        }
      };

      const workers = Array.from({ length: Math.min(concurrency, list.length) }, () => worker());
      await Promise.all(workers);
      return results;
    },

    /** 取消剩余任务（已完成的结果保留） */
    cancel() {
      cancelled = true;
    }
  };
}
