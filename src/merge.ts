// 同步合并：按“便签”为粒度的 Last-Writer-Wins。
// 规则：
//   - 两侧按 note.id 取并集
//   - 两侧都有 → updatedAt 新者胜
//   - 胜者是墓碑（deletedAt）而败者的 updatedAt 晚于墓碑时间 → 败者复活
//     （删除后另一台设备的旧改动不会复活便签，但更新的改动会）
//   - 彻底删除记录（store.purged）无条件生效：内容立即从数据中移除，
//     记录本身保留 30 天以传播到长时间离线的设备
//   - 墓碑超过 30 天自动转为彻底删除记录（垃圾桶自动清理）

import type { Note, Store } from "./types";

export const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;
export const PURGE_RECORD_TTL_MS = 30 * 24 * 3600 * 1000;

export function mergeNotes(local: Note, remote: Note): Note {
  if (!remote) return local;
  if (!local) return remote;
  if (local.updatedAt >= remote.updatedAt) {
    if (isResurrect(local, remote)) return remote;
    return local;
  }
  if (isResurrect(remote, local)) return local;
  return remote;
}

/** winner 是墓碑、loser 在删除之后还有修改 → loser 复活 */
function isResurrect(winner: Note, loser: Note): boolean {
  return winner.deletedAt !== undefined && loser.deletedAt === undefined && loser.updatedAt > (winner.deletedAt ?? 0);
}

function mergePurged(
  local: Record<string, number> | undefined,
  remote: Record<string, number> | undefined
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, ts] of Object.entries(remote ?? {})) out[id] = ts;
  for (const [id, ts] of Object.entries(local ?? {})) out[id] = Math.max(out[id] ?? 0, ts);
  return out;
}

export function mergeStores(local: Store, remote: Store): Store {
  const now = Date.now();
  const purged = mergePurged(local.purged, remote.purged);

  const byId = new Map<string, Note>();
  for (const n of remote.notes) byId.set(n.id, n);
  for (const n of local.notes) {
    const other = byId.get(n.id);
    byId.set(n.id, other ? mergeNotes(n, other) : n);
  }

  // 彻底删除记录无条件生效：该便签从所有设备移除
  // （id 为 UUID 不会复用，不存在“删除后新建同名便签”的冲突）
  for (const id of Object.keys(purged)) byId.delete(id);

  // 旧版兼容（note.purgedAt）与墓碑 TTL 自动清理 → 统一转为彻底删除记录
  // 记录时间戳取转换时刻（now），保证 30 天传播窗口从此刻起算
  const notes: Note[] = [];
  for (const n of byId.values()) {
    if (n.purgedAt !== undefined) {
      purged[n.id] = Math.max(purged[n.id] ?? 0, now);
      continue;
    }
    if (n.deletedAt !== undefined && now - n.deletedAt > TOMBSTONE_TTL_MS) {
      purged[n.id] = Math.max(purged[n.id] ?? 0, now);
      continue;
    }
    notes.push(n);
  }

  // 记录只含 id 与时间戳，超过 TTL 后清除（此后离线超过 TTL 的设备
  // 可能重新推回旧数据——与旧的墓碑 TTL 行为一致，时间窗口相同）
  for (const [id, ts] of Object.entries(purged)) {
    if (now - ts > PURGE_RECORD_TTL_MS) delete purged[id];
  }

  // 按 id 排序保证合并结果与两侧传入顺序无关（可交换），UI 层再按置顶/时间排序
  notes.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { version: 1, notes, purged };
}

export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}
