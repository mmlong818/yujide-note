// GitHub 同步客户端单测：全部走注入的 mock fetch，不发真实网络请求

import { describe, expect, it, vi } from "vitest";
import { GitHubSync, SyncConflictError, SyncError } from "@/sync";
import { utf8ToB64, b64ToUtf8 } from "@/b64";
import type { Store } from "@/types";

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const REPO_URL = "https://api.github.com/repos/alice/notes";
const CREATE_REPO_URL = "https://api.github.com/user/repos";

const cfg = { owner: "alice", repo: "notes", branch: "main", path: "notes.json", token: "t0k" };

function store(n: number): Store {
  return {
    version: 1,
    notes: [
      {
        id: `n${n}`,
        title: `便签${n}`,
        color: "#f6d860",
        createdAt: 1000,
        updatedAt: 2000 + n,
        blocks: [{ id: `b${n}`, kind: "text", content: "内容", updatedAt: 2000 + n }],
      },
    ],
  };
}

/** 显式控制 id 与 updatedAt 的便签（用于同一条的新旧版本对比） */
function ver(id: string, updatedAt: number, title: string): Store {
  return {
    version: 1,
    notes: [
      {
        id,
        title,
        color: "#f6d860",
        createdAt: 1000,
        updatedAt,
        blocks: [{ id: id + "-b", kind: "text", content: title, updatedAt }],
      },
    ],
  };
}

/** 可编程的模拟远端：记录调用、可制造一次 PUT 冲突 */
function serverState(initial?: { store: Store; sha: string }) {
  let current = initial ?? null;
  let putCount = 0;
  let conflictFirstPut = false;
  const calls: { method: string; url: string; body: any }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method: init?.method ?? "GET", url, body });

    if (url === REPO_URL) return jsonRes(200, { full_name: "alice/notes" });
    if (url === CREATE_REPO_URL) return jsonRes(201, { full_name: "alice/notes" });

    if (init?.method === "PUT") {
      putCount++;
      if (conflictFirstPut && putCount === 1) return jsonRes(409, { message: "sha does not match" });
      if (current !== null && body?.sha !== current.sha) return jsonRes(409, { message: "sha does not match" });
      if (current === null && body?.sha) return jsonRes(409, { message: "sha does not match" });
      current = { store: JSON.parse(b64ToUtf8(body.content)) as Store, sha: "sha-" + putCount };
      return jsonRes(201, { content: { sha: current.sha } });
    }

    // GET 文件
    if (!current) return jsonRes(404, { message: "Not Found" });
    return jsonRes(200, {
      sha: current.sha,
      encoding: "base64",
      content: utf8ToB64(JSON.stringify(current.store)),
    });
  });
  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    calls,
    conflictFirstPut: () => (conflictFirstPut = true),
    get putCalls() {
      return calls.filter((c) => c.method === "PUT");
    },
    get current() {
      return current;
    },
  };
}

describe("GitHubSync.pull", () => {
  it("远端无文件 → null", async () => {
    const s = serverState();
    const sync = new GitHubSync(cfg, s.fetchImpl);
    expect(await sync.pull()).toBeNull();
  });

  it("拉取并解析远端 JSON", async () => {
    const s = serverState({ store: store(7), sha: "abc" });
    const sync = new GitHubSync(cfg, s.fetchImpl);
    const out = await sync.pull();
    expect(out!.sha).toBe("abc");
    expect(out!.store.notes[0].title).toBe("便签7");
  });

  it("401 → 友好错误", async () => {
    const fetchImpl = (async () => jsonRes(401, { message: "Bad credentials" })) as unknown as typeof fetch;
    const sync = new GitHubSync(cfg, fetchImpl);
    await expect(sync.pull()).rejects.toThrow(SyncError);
    await expect(sync.pull()).rejects.toThrow(/Token 无效/);
  });
});

describe("GitHubSync.push", () => {
  it("远端已有文件但未带 sha → 冲突错误", async () => {
    const s = serverState({ store: store(1), sha: "abc" });
    const sync = new GitHubSync(cfg, s.fetchImpl);
    await expect(sync.push(store(2), null)).rejects.toThrow(SyncConflictError);
  });

  it("远端无文件却带了 sha → 冲突错误", async () => {
    const s = serverState();
    const sync = new GitHubSync(cfg, s.fetchImpl);
    await expect(sync.push(store(2), "ghost")).rejects.toThrow(SyncConflictError);
  });

  it("带正确 sha 推送成功并返回新 sha", async () => {
    const s = serverState({ store: store(1), sha: "abc" });
    const sync = new GitHubSync(cfg, s.fetchImpl);
    const sha = await sync.push(store(2), "abc");
    expect(sha).toMatch(/^sha-/);
    expect(s.current!.store.notes[0].id).toBe("n2");
  });
});

describe("GitHubSync.syncOnce", () => {
  it("首次同步：远端为空 → 推送本地", async () => {
    const s = serverState();
    const sync = new GitHubSync(cfg, s.fetchImpl);
    const out = await sync.syncOnce(store(1));
    expect(out.pushed).toBe(true);
    expect(out.pulledFromRemote).toBe(false);
    expect(out.sha).toMatch(/^sha-/);
  });

  it("远端较新（同一条便签的更新版）：合并结果等于远端，不推送", async () => {
    const s = serverState({ store: ver("n1", 3000, "远端新版"), sha: "s0" });
    const sync = new GitHubSync(cfg, s.fetchImpl);
    const out = await sync.syncOnce(ver("n1", 2000, "本地旧版"));
    expect(out.pulledFromRemote).toBe(true);
    expect(out.pushed).toBe(false);
    expect(out.store.notes[0].title).toBe("远端新版");
  });

  it("本地较新（同一条便签的更新版）：合并取本地并推送", async () => {
    const s = serverState({ store: ver("n1", 2000, "远端旧版"), sha: "s0" });
    const sync = new GitHubSync(cfg, s.fetchImpl);
    const out = await sync.syncOnce(ver("n1", 5000, "本地新版"));
    expect(out.pushed).toBe(true);
    expect(out.store.notes[0].title).toBe("本地新版");
    expect(s.current!.store.notes[0].title).toBe("本地新版");
  });

  it("本地+远端各有新便签：合并为两条并推送", async () => {
    const s = serverState({ store: store(1), sha: "s0" });
    const sync = new GitHubSync(cfg, s.fetchImpl);
    const out = await sync.syncOnce(store(5));
    expect(out.store.notes).toHaveLength(2);
    expect(out.pushed).toBe(true);
  });

  it("sha 冲突 → 自动重拉合并再推", async () => {
    const s = serverState({ store: store(1), sha: "s0" });
    s.conflictFirstPut();
    const sync = new GitHubSync(cfg, s.fetchImpl);
    const out = await sync.syncOnce(store(2));
    expect(out.pushed).toBe(true);
    expect(s.putCalls.length).toBe(2);
  });
});

describe("GitHubSync.testConnection", () => {
  it("仓库存在 → ok", async () => {
    const s = serverState({ store: store(1), sha: "abc" });
    const sync = new GitHubSync(cfg, s.fetchImpl);
    const r = await sync.testConnection();
    expect(r.ok).toBe(true);
    expect(r.message).toContain("连接成功");
  });

  it("仓库不存在且自动创建成功", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === REPO_URL) return jsonRes(404, { message: "Not Found" });
      if (url === CREATE_REPO_URL) return jsonRes(201, { full_name: "alice/notes" });
      throw new Error("unexpected " + url);
    });
    const sync = new GitHubSync(cfg, fetchImpl as unknown as typeof fetch);
    const r = await sync.testConnection();
    expect(r.ok).toBe(true);
    expect(r.message).toContain("已自动创建");
  });

  it("仓库不存在且创建被拒 → 给出手动指引", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === REPO_URL) return jsonRes(404, { message: "Not Found" });
      if (url === CREATE_REPO_URL) return jsonRes(403, { message: "forbidden" });
      throw new Error("unexpected " + url);
    });
    const sync = new GitHubSync(cfg, fetchImpl as unknown as typeof fetch);
    const r = await sync.testConnection();
    expect(r.ok).toBe(false);
    expect(r.message).toContain("手动创建");
  });
});
