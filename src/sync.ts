// GitHub Contents API 同步客户端。
// 同步协议：仓库里一个 JSON 文件（默认 notes.json）
//   GET  /repos/{owner}/{repo}/contents/{path}?ref={branch}  → { content(base64), sha } | 404
//   PUT  /repos/{owner}/{repo}/contents/{path}               → 需要 sha；改动时携带，被抢改则 409/422 冲突
// 冲突处理：重新拉取 → mergeStores → 再推送（最多 3 轮）。
// 认证：PAT 走 Bearer 头。api.github.com 支持浏览器 CORS，全部逻辑可跑在前端。

import { utf8ToB64, b64ToUtf8 } from "./b64";
import { mergeStores } from "./merge";
import type { Store, SyncConfig } from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const API = "https://api.github.com";
const MAX_ROUNDS = 3;

export class SyncError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export interface SyncOutcome {
  /** 合并后的最新数据（本地应采纳） */
  store: Store;
  sha: string | null;
  /** 本轮是否向远端推送了内容 */
  pushed: boolean;
  pulledFromRemote: boolean;
}

export interface ConnectionReport {
  ok: boolean;
  message: string;
}

export class GitHubSync {
  constructor(
    public cfg: SyncConfig,
    private fetchImpl: FetchLike = (input, init) => fetch(input, init)
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private repoUrl(): string {
    return `${API}/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}`;
  }

  private getUrl(): string {
    // 时间戳查询参数进一步防缓存（GitHub 忽略未知参数）
    return `${this.repoUrl()}/contents/${encodePath(this.cfg.path)}?ref=${encodeURIComponent(this.cfg.branch)}&_=${Date.now()}`;
  }

  private putUrl(): string {
    return `${this.repoUrl()}/contents/${encodePath(this.cfg.path)}`;
  }

  /** 拉取远端。文件不存在返回 null（首次同步）。其它错误抛 SyncError。 */
  async pull(): Promise<{ store: Store; sha: string } | null> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.getUrl(), { method: "GET", headers: this.headers(), cache: "no-store" } as RequestInit);
    } catch {
      throw new SyncError("网络错误，无法连接 GitHub");
    }
    if (res.status === 404) return null; // 文件尚不存在
    if (res.status === 401) throw new SyncError("Token 无效或已过期");
    if (res.status === 403) throw new SyncError("无访问权限或超出 GitHub 速率限制");
    if (!res.ok) throw new SyncError(`拉取失败（HTTP ${res.status}）`);

    const data = (await res.json()) as { content?: string; sha: string; encoding?: string };
    if (data.encoding !== "base64" || typeof data.content !== "string") {
      throw new SyncError("远端文件格式异常");
    }
    let remote: Store;
    try {
      remote = JSON.parse(b64ToUtf8(data.content.replace(/\s/g, ""))) as Store;
    } catch {
      throw new SyncError("远端数据解析失败");
    }
    return { store: remote, sha: data.sha };
  }

  /** 推送本地数据。sha 为 null 表示首次创建。冲突抛 SyncConflictError。 */
  async push(store: Store, sha: string | null): Promise<string> {
    const body: Record<string, unknown> = {
      message: `sync: ${new Date().toISOString()}`,
      content: utf8ToB64(JSON.stringify(store)),
      branch: this.cfg.branch,
    };
    if (sha !== null) body.sha = sha;

    let res: Response;
    try {
      res = await this.fetchImpl(this.putUrl(), {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify(body),
        cache: "no-store",
      } as RequestInit);
    } catch {
      throw new SyncError("网络错误，无法连接 GitHub");
    }
    if (res.status === 200 || res.status === 201) {
      const data = (await res.json()) as { content: { sha: string } };
      return data.content.sha;
    }
    if (res.status === 409 || isShaMismatch(await safeJson(res))) {
      throw new SyncConflictError();
    }
    if (res.status === 401) throw new SyncError("Token 无效或已过期");
    if (res.status === 403) throw new SyncError("无写入权限或超出 GitHub 速率限制");
    if (res.status === 422) throw new SyncError("推送被拒绝：分支或路径可能不存在");
    throw new SyncError(`推送失败（HTTP ${res.status}）`);
  }

  /**
   * 完整同步一轮：拉取 → 合并 → （有差异则）推送。
   * 返回合并后的数据，调用方负责写回本地。
   */
  async syncOnce(localStore: Store): Promise<SyncOutcome> {
    let conflictRounds = 0;
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const remote = await this.pull();
      if (remote === null) {
        // 远端还没有文件：直接推本地
        const sha = await this.push(localStore, null);
        return { store: localStore, sha, pushed: true, pulledFromRemote: false };
      }
      const merged = mergeStores(localStore, remote.store);
      if (canonical(merged) === canonical(remote.store)) {
        // 远端已包含全部本地改动，无需推送
        return { store: merged, sha: remote.sha, pushed: false, pulledFromRemote: true };
      }
      try {
        const sha = await this.push(merged, remote.sha);
        return { store: merged, sha, pushed: true, pulledFromRemote: true };
      } catch (e) {
        if (e instanceof SyncConflictError && ++conflictRounds < MAX_ROUNDS) continue; // 别人刚推过，重拉再试
        throw e;
      }
    }
    throw new SyncError("冲突反复出现，已停止同步，请稍后重试");
  }

  /** 设置页「测试连接」：校验 token，仓库不存在时尝试自动创建私有仓库 */
  async testConnection(): Promise<ConnectionReport> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.repoUrl(), { method: "GET", headers: this.headers(), cache: "no-store" } as RequestInit);
    } catch {
      return { ok: false, message: "网络错误，无法连接 GitHub" };
    }
    if (res.status === 401) return { ok: false, message: "Token 无效或已过期" };
    if (res.status === 403) return { ok: false, message: "Token 无仓库访问权限" };

    if (res.status === 404) {
      const created = await this.fetchImpl(`${API}/user/repos`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ name: this.cfg.repo, private: true }),
      });
      if (created.ok || created.status === 422) {
        return { ok: true, message: `仓库 ${this.cfg.owner}/${this.cfg.repo} 已就绪（${created.ok ? "已自动创建私有仓库" : "已存在"}）` };
      }
      return {
        ok: false,
        message: `仓库不存在且自动创建失败（HTTP ${created.status}）。请在 GitHub 手动创建私有仓库 ${this.cfg.repo}，或给 Token 仓库管理权限。`,
      };
    }
    if (!res.ok) return { ok: false, message: `连接失败（HTTP ${res.status}）` };
    return { ok: true, message: `连接成功：${this.cfg.owner}/${this.cfg.repo}` };
  }
}

export class SyncConflictError extends SyncError {
  constructor() {
    super("远端有更新的数据");
  }
}

/** 规范化比较：排序后的 notes + 统一的 purged 字段，避免键序/缺省差异造成误判 */
function canonical(s: Store): string {
  return JSON.stringify({
    version: 1,
    notes: [...s.notes].sort((a, b) => (a.id < b.id ? -1 : 1)),
    purged: s.purged ?? {},
  });
}

async function safeJson(res: Response): Promise<{ message?: string }> {
  try {
    return (await res.json()) as { message?: string };
  } catch {
    return {};
  }
}

function isShaMismatch(data: { message?: string }): boolean {
  return !!data.message && data.message.includes("does not match");
}

function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}
