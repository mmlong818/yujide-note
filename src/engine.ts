// 同步引擎：定时与触发的同步编排（启动拉取、改动防抖推送、5 分钟轮询、手动同步）

import { GitHubSync, SyncError } from "@/sync";
import {
  flushPersist,
  getStoreForSync,
  getStoreRev,
  getSyncCfg,
  replaceStore,
  setSyncStatus,
  subscribe,
} from "@/state";

const PUSH_DEBOUNCE_MS = 2000;
const POLL_INTERVAL_MS = 5 * 60 * 1000;

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let syncing = false;
let pendingAfterCurrent = false;
let lastSeenRev = -1;

export function initSyncEngine(): void {
  // 数据变化（持久化被触发）→ 防抖推送；同步过程中的 emit 不算
  subscribe(() => {
    if (syncing) return;
    const rev = getStoreRev();
    if (rev === lastSeenRev) return;
    lastSeenRev = rev;
    scheduleSyncPush();
  });
  // 启动稍等片刻先拉一次
  setTimeout(() => void syncNow("auto"), 1200);
  setInterval(() => void syncNow("auto"), POLL_INTERVAL_MS);
}

/** 本地有改动后调用：防抖推送 */
export function scheduleSyncPush(): void {
  if (!getSyncCfg()) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => void syncNow("push"), PUSH_DEBOUNCE_MS);
}

/** 手动/自动同步一轮。kind 仅影响结果展示，不影响协议。 */
export async function syncNow(kind: "auto" | "push" | "manual" = "auto"): Promise<void> {
  const cfg = getSyncCfg();
  if (!cfg) {
    setSyncStatus("unconfigured");
    return;
  }
  if (syncing) {
    pendingAfterCurrent = true; // 进行中又来了新改动：结束后补一轮
    return;
  }
  syncing = true;
  setSyncStatus("syncing");
  try {
    await flushPersist();
    const sync = new GitHubSync(cfg);
    const outcome = await sync.syncOnce(getStoreForSync());
    replaceStore(outcome.store);
    setSyncStatus("ok");
  } catch (e) {
    const msg =
      e instanceof SyncError
        ? e.message
        : e instanceof Error
          ? `同步失败：${e.message}`
          : "同步失败";
    setSyncStatus("error", msg);
    // 推送触发的失败不再自我重试（避免风暴），交给下一轮定时器
    void kind;
  } finally {
    syncing = false;
    lastSeenRev = getStoreRev();
    if (pendingAfterCurrent) {
      pendingAfterCurrent = false;
      scheduleSyncPush();
    }
  }
}
