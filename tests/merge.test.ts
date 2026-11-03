// 便签合并逻辑单测

import { describe, expect, it } from "vitest";
import { mergeNotes, mergeStores, sortNotes } from "@/merge";
import type { Note, Store } from "@/types";

let seq = 0;
function note(overrides: Partial<Note> = {}): Note {
  seq++;
  const t = overrides.updatedAt ?? 1000 + seq;
  return {
    id: `n${seq}`,
    title: `便签${seq}`,
    color: "#f6d860",
    createdAt: t - 10,
    updatedAt: t,
    blocks: [{ id: `b${seq}`, kind: "text", content: `内容${seq}`, updatedAt: t }],
    ...overrides,
  };
}

function store(...notes: Note[]): Store {
  return { version: 1, notes };
}

describe("mergeNotes", () => {
  it("updatedAt 新者胜", () => {
    const older = note({ updatedAt: 100 });
    const newer = note({ id: older.id, updatedAt: 200, title: "新版" });
    expect(mergeNotes(older, newer).title).toBe("新版");
    expect(mergeNotes(newer, older).title).toBe("新版");
  });

  it("单侧存在则取该侧", () => {
    const a = note();
    expect(mergeNotes(a, undefined as unknown as Note)).toBe(a);
  });

  it("墓碑胜过删除前的旧改动", () => {
    const local = note({ updatedAt: 200 }); // 删除前的旧版本
    const tomb = note({ id: local.id, updatedAt: 300, deletedAt: 300 });
    expect(mergeNotes(local, tomb).deletedAt).toBeDefined();
  });

  it("删除之后另一端的更新修改 → 复活", () => {
    const local = note({ updatedAt: 400, title: "删除后还在编辑" }); // 晚于墓碑
    const tomb = note({ id: local.id, updatedAt: 300, deletedAt: 300 });
    const merged = mergeNotes(local, tomb);
    expect(merged.deletedAt).toBeUndefined();
    expect(merged.title).toBe("删除后还在编辑");
  });
});

describe("mergeStores", () => {
  it("并集合并", () => {
    const a = note();
    const b = note();
    const merged = mergeStores(store(a), store(b));
    expect(merged.notes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("同 id 冲突取新者", () => {
    const a = note({ updatedAt: 100, title: "旧" });
    const b = note({ id: a.id, updatedAt: 200, title: "新" });
    expect(mergeStores(store(a), store(b)).notes[0].title).toBe("新");
  });

  it("远端删除 + 本地无新改动 → 本地也进入墓碑", () => {
    const now = Date.now();
    const a = note({ updatedAt: now - 2000 });
    const tomb = note({ id: a.id, updatedAt: now - 1000, deletedAt: now - 1000 });
    const merged = mergeStores(store(a), store(tomb));
    expect(merged.notes.find((n) => n.id === a.id)?.deletedAt).toBeDefined();
  });

  it("超过 TTL 的墓碑 → 内容移除并转为彻底删除记录", () => {
    const longAgo = Date.now() - 31 * 24 * 3600 * 1000;
    const tomb = note({ updatedAt: longAgo, deletedAt: longAgo });
    const fresh = note();
    const merged = mergeStores(store(fresh), store(tomb));
    expect(merged.notes.map((n) => n.id)).toEqual([fresh.id]);
    // 记录时间戳为转换时刻，保证 30 天传播窗口从此刻起算
    expect(merged.purged?.[tomb.id]).toBeGreaterThan(longAgo);
  });

  it("彻底删除记录无条件移除另一端存活的便签", () => {
    const alive = note({ updatedAt: Date.now() }); // 对端还在编辑它也没用
    const local: Store = { version: 1, notes: [alive], purged: { [alive.id]: Date.now() - 100 } };
    const merged = mergeStores(local, store());
    expect(merged.notes).toHaveLength(0);
    expect(merged.purged?.[alive.id]).toBeDefined();
  });

  it("彻底删除记录跨合并传播（对端收到后同样移除并保留记录）", () => {
    const alive = note();
    const withRecord: Store = { version: 1, notes: [], purged: { [alive.id]: Date.now() - 1000 } };
    // 设备 B：本地有这条便签，远端带着删除记录来了
    const mergedB = mergeStores(store(alive), withRecord);
    expect(mergedB.notes).toHaveLength(0);
    expect(mergedB.purged?.[alive.id]).toBe(withRecord.purged![alive.id]);
    // 设备 B 再与第三方合并时记录仍在
    const another = note();
    const mergedC = mergeStores(mergedB, store(another));
    expect(mergedC.notes.map((n) => n.id)).toEqual([another.id]);
    expect(mergedC.purged?.[alive.id]).toBe(withRecord.purged![alive.id]);
  });

  it("旧版 purgedAt 标记兼容：转为删除记录并移除", () => {
    const old = note({ purgedAt: 12345, deletedAt: 12000, updatedAt: 12345 });
    const fresh = note();
    const merged = mergeStores(store(fresh), store(old));
    expect(merged.notes.map((n) => n.id)).toEqual([fresh.id]);
    expect(merged.purged?.[old.id]).toBeGreaterThan(12345);
  });

  it("超过 TTL 的删除记录被清理", () => {
    const longAgo = Date.now() - 31 * 24 * 3600 * 1000;
    const a: Store = { version: 1, notes: [], purged: { gone: longAgo } };
    const merged = mergeStores(a, store());
    expect(merged.purged?.gone).toBeUndefined();
  });

  it("两侧都有删除记录取较新者", () => {
    const t1 = Date.now() - 5000;
    const t2 = Date.now() - 1000;
    const a: Store = { version: 1, notes: [], purged: { x: t1 } };
    const b: Store = { version: 1, notes: [], purged: { x: t2 } };
    expect(mergeStores(a, b).purged?.x).toBe(t2);
    expect(mergeStores(b, a).purged?.x).toBe(t2);
  });

  it("合并满足交换律", () => {
    const a1 = note({ updatedAt: 100 });
    const b1 = note();
    const c1 = note();
    const a2 = { ...a1 };
    const b2 = { ...b1 };
    const c2 = { ...c1 };
    const s1 = mergeStores(store(a1, b1), store(c1));
    const s2 = mergeStores(store(c2), store(a2, b2));
    expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
  });
});

describe("sortNotes", () => {
  it("置顶优先，其余按更新时间倒序", () => {
    const x = note({ updatedAt: 100 });
    const y = note({ updatedAt: 300 });
    const p = note({ updatedAt: 100, pinned: true });
    const sorted = sortNotes([x, y, p]);
    expect(sorted.map((n) => n.id)).toEqual([p.id, y.id, x.id]);
  });
});
