import "@/ui/styles.css";
import { initState, flushPersist } from "@/state";
import { initSyncEngine } from "@/engine";
import { mountApp } from "@/ui/app";

async function boot(): Promise<void> {
  await initState();
  initSyncEngine();
  mountApp(document.getElementById("app")!);
  // 关闭窗口时若还有未落盘的防抖保存，尽力补一次
  window.addEventListener("beforeunload", () => void flushPersist());
}

void boot();
