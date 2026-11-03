// Tauri 命令桥接。非 Tauri 环境（浏览器开发/冒烟测试）自动降级到 localStorage，
// 因此 UI 可以在纯浏览器里完整跑起来。

import { invoke } from "@tauri-apps/api/core";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export const isTauri =
  typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

export async function loadJSON<T>(file: string): Promise<T | null> {
  if (isTauri) {
    const raw = await invoke<string | null>("read_data", { file });
    return raw ? (JSON.parse(raw) as T) : null;
  }
  const raw = localStorage.getItem("dbq:" + file);
  return raw ? (JSON.parse(raw) as T) : null;
}

export async function saveJSON(file: string, value: unknown): Promise<void> {
  const raw = JSON.stringify(value);
  if (isTauri) {
    await invoke("write_data", { file, content: raw });
    return;
  }
  localStorage.setItem("dbq:" + file, raw);
}

export async function openDataDir(): Promise<void> {
  if (!isTauri) {
    console.info("[dbq] 非 Tauri 环境，数据在 localStorage");
    return;
  }
  await invoke("open_data_dir");
}
