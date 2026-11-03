// 底部状态栏：全部上锁 | 同步状态 · 设置 · 数据目录

import { el, fmtTime } from "./dom";
import { openDataDir } from "@/bridge";
import { getState, lockAll, totalUnlocked } from "@/state";
import { syncNow } from "@/engine";
import { settingsModal } from "./modals";
import { toast } from "./modals";

export function renderStatusbar(bar: HTMLElement): void {
  bar.innerHTML = "";
  const { sync } = getState();
  const unlocked = totalUnlocked();

  const lockBtn = el("button", "btn btn-small", "🔒 全部上锁") as HTMLButtonElement;
  lockBtn.disabled = unlocked === 0;
  lockBtn.title = unlocked === 0 ? "没有已解锁的保密块" : `上锁全部 ${unlocked} 个已解锁保密块`;
  lockBtn.onclick = async () => {
    await lockAll();
    toast("已全部上锁 🔒");
  };

  const left = el("div", "statusbar-left", lockBtn);

  const dot = el("span", "sync-dot sync-" + sync.status);
  const label = syncStatusText(sync.status, sync.lastSyncAt, sync.error);
  const chip = el("button", "sync-chip", dot, el("span", "sync-label", label)) as HTMLButtonElement;
  chip.title = sync.error ?? "点击立即同步";
  chip.disabled = sync.status === "syncing" || sync.status === "unconfigured";
  chip.onclick = () => void syncNow("manual");

  const gear = el("button", "icon-btn", "⚙️") as HTMLButtonElement;
  gear.title = "同步设置";
  gear.onclick = () => settingsModal();

  const folder = el("button", "icon-btn", "📁") as HTMLButtonElement;
  folder.title = "打开数据目录";
  folder.onclick = () => void openDataDir();

  const right = el("div", "statusbar-right", chip, gear, folder);
  bar.append(left, right);
}

function syncStatusText(
  status: "unconfigured" | "idle" | "syncing" | "ok" | "error",
  lastSyncAt: number | null,
  error: string | null
): string {
  switch (status) {
    case "unconfigured":
      return "未配置同步";
    case "syncing":
      return "同步中…";
    case "ok":
      return `已同步 ${lastSyncAt ? fmtTime(lastSyncAt) : ""}`;
    case "error":
      return error ? `同步失败（${error}）` : "同步失败";
    default:
      return "待同步";
  }
}
