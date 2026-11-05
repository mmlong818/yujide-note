// 便签数据模型。secure 块只存密文（salt/iv/cipher，均为 base64）；
// plain 字段只在解锁后存在于内存中，持久化与同步前必须剥离。

export type BlockKind = "text" | "secure";

export interface TextBlock {
  id: string;
  kind: "text";
  content: string;
  updatedAt: number;
}

export interface SecureBlock {
  id: string;
  kind: "secure";
  /** PBKDF2 盐，base64 */
  salt: string;
  /** AES-GCM IV，base64 */
  iv: string;
  /** 密文，base64 */
  cipher: string;
  /** 锁定状态下对外显示的名称（明文，如“银行卡密码”），便于识别 */
  label?: string;
  /** 可选的密码提示 */
  hint?: string;
  updatedAt: number;
  /** 解锁后的明文。仅存在于内存，绝不落盘/上传 */
  plain?: string;
}

export type Block = TextBlock | SecureBlock;

export interface Note {
  id: string;
  title: string;
  color: string;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
  /** 墓碑：移入垃圾桶的时间戳 */
  deletedAt?: number;
  /** 旧版彻底删除标记（仅兼容旧数据用，新数据不再写入） */
  purgedAt?: number;
  blocks: Block[];
}

export interface Store {
  version: 1;
  notes: Note[];
  /**
   * 彻底删除记录：noteId -> 删除时间戳。
   * 彻底删除会立即移除便签内容，仅保留此轻量记录（id+时间戳）30 天，
   * 用于把删除传播到其他设备（避免离线设备把旧数据推回来）。
   */
  purged?: Record<string, number>;
}

export interface SyncConfig {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  /** GitHub fine-grained PAT（Contents read/write） */
  token: string;
}

export interface Settings {
  sync?: SyncConfig;
  /** 是否已展示过欢迎引导 */
  welcomed?: boolean;
}

export const NOTE_COLORS = [
  "#FBFAF2", // 白
  "#E9E8F2", // 紫
] as const;

export function emptyStore(): Store {
  return { version: 1, notes: [], purged: {} };
}

/** 序列化前的清洗：剥离所有解锁明文，保证明文永不落盘/上传 */
export function stripPlaintext(store: Store): Store {
  return {
    version: 1,
    purged: store.purged ?? {},
    notes: store.notes.map((n) => ({
      ...n,
      blocks: n.blocks.map((b) => {
        if (b.kind === "secure" && b.plain !== undefined) {
          const { plain: _plain, ...rest } = b;
          return rest;
        }
        return b;
      }),
    })),
  };
}

export function noteSummary(note: Note, maxLen = 40): string {
  const firstText = note.blocks.find(
    (b): b is TextBlock => b.kind === "text" && b.content.trim() !== ""
  );
  const firstLabel = note.blocks.find(
    (b): b is SecureBlock => b.kind === "secure" && !!b.label
  );
  const base = (firstText?.content ?? firstLabel?.label ?? "").trim().replace(/\s+/g, " ");
  return base.length > maxLen ? base.slice(0, maxLen) + "…" : base;
}

export function hasSecureBlocks(note: Note): boolean {
  return note.blocks.some((b) => b.kind === "secure");
}

export function countUnlocked(note: Note): number {
  return note.blocks.filter((b) => b.kind === "secure" && b.plain !== undefined).length;
}
