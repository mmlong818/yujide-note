// 应用状态中心：单一可变状态 + 订阅通知。
// editorRev 仅在“结构性变化”（增删块/加解锁/选中等）时递增；
// 纯文本输入不递增，编辑器因此不会在打字时重建 DOM（保持焦点）。

import {
  countUnlocked,
  emptyStore,
  NOTE_COLORS,
  stripPlaintext,
  type Block,
  type Note,
  type SecureBlock,
  type Settings,
  type Store,
  type SyncConfig,
  type TextBlock,
} from "@/types";
import {
  decryptWithSession,
  encryptText,
  encryptWithRoot,
  isSessionUnlocked,
  latestSessionRoot,
  lockAllSession,
  relockBlock,
  unlockWithPassword,
  WrongPasswordError,
} from "@/crypto";
import { loadJSON, saveJSON } from "@/bridge";
import { sortNotes } from "@/merge";

export interface SyncStatus {
  status: "unconfigured" | "idle" | "syncing" | "ok" | "error";
  lastSyncAt: number | null;
  error: string | null;
}

interface AppState {
  store: Store;
  settings: Settings;
  selectedNoteId: string | null;
  search: string;
  /** 列表视图：正常列表或垃圾桶 */
  view: "list" | "trash";
  editorRev: number;
  sync: SyncStatus;
}

let state: AppState = {
  store: emptyStore(),
  settings: {},
  selectedNoteId: null,
  search: "",
  view: "list",
  editorRev: 0,
  sync: { status: "unconfigured", lastSyncAt: null, error: null },
};

const listeners = new Set<() => void>();

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState(): AppState {
  return state;
}

export function emit(): void {
  for (const fn of [...listeners]) fn();
}

let emitTimer: ReturnType<typeof setTimeout> | null = null;
/** 打字等高频操作用的防抖通知 */
export function emitSoon(delay = 250): void {
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    emit();
  }, delay);
}

function touchEditor(): void {
  state.editorRev++;
}

// ---------- 初始化 ----------

export async function initState(): Promise<void> {
  const [notes, settings] = await Promise.all([
    loadJSON<Store>("notes.json"),
    loadJSON<Settings>("settings.json"),
  ]);
  state.store = notes ? stripPlaintext(notes) : emptyStore();
  state.settings = settings ?? {};
  if (getSyncCfg()) state.sync.status = "idle";
}

// ---------- 派生数据 ----------

export function getSyncCfg(): SyncConfig | null {
  const s = state.settings.sync;
  return s && s.owner && s.repo && s.token ? s : null;
}

export function visibleNotes(): Note[] {
  const q = state.search.trim().toLowerCase();
  const alive = state.store.notes.filter((n) => n.deletedAt === undefined);
  if (!q) return sortNotes(alive);
  return sortNotes(
    alive.filter((n) => {
      if (n.title.toLowerCase().includes(q)) return true;
      return n.blocks.some((b) => {
        if (b.kind === "text") return b.content.toLowerCase().includes(q);
        // 加密块的显示名称是明文，参与搜索便于定位
        return !!b.label && b.label.toLowerCase().includes(q);
      });
    })
  );
}

export function getSelectedNote(): Note | null {
  return (
    state.store.notes.find(
      (n) => n.id === state.selectedNoteId && n.deletedAt === undefined
    ) ?? null
  );
}

/** 垃圾桶里的便签（已删除且未彻底删除），按删除时间倒序 */
export function trashNotes(): Note[] {
  return state.store.notes
    .filter((n) => n.deletedAt !== undefined && n.purgedAt === undefined)
    .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
}

export function getView(): "list" | "trash" {
  return state.view;
}

export function setView(view: "list" | "trash"): void {
  state.view = view;
  if (view === "trash") state.selectedNoteId = null;
  touchEditor();
  emit();
}

export function totalUnlocked(): number {
  return state.store.notes.reduce(
    (sum, n) => (n.deletedAt === undefined ? sum + countUnlocked(n) : sum),
    0
  );
}

// ---------- 持久化 ----------

let storeRev = 0;
export function getStoreRev(): number {
  return storeRev;
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistChain: Promise<void> = Promise.resolve();

function persistSoon(): void {
  storeRev++;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void flushPersist(), 400);
}

/** 立即落盘（同步前调用，避免把未写入的数据推上去） */
export function flushPersist(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  const snapshot = JSON.stringify(stripPlaintext(state.store));
  persistChain = persistChain.then(() => saveJSON("notes.json", JSON.parse(snapshot)));
  return persistChain;
}

export async function saveSettings(settings: Settings): Promise<void> {
  state.settings = settings;
  await saveJSON("settings.json", settings);
  emit();
}

export function saveSyncCfg(cfg: SyncConfig | null): Promise<void> {
  const settings = { ...state.settings, sync: cfg ?? undefined };
  if (!cfg) delete (settings as Settings).sync;
  state.sync = cfg
    ? { status: "idle", lastSyncAt: state.sync.lastSyncAt, error: null }
    : { status: "unconfigured", lastSyncAt: null, error: null };
  return saveSettings(settings);
}

export function setSyncStatus(status: SyncStatus["status"], error: string | null = null): void {
  state.sync = {
    status,
    lastSyncAt: status === "ok" ? Date.now() : state.sync.lastSyncAt,
    error,
  };
  emit();
}

// ---------- 便签操作 ----------

function uid(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function newTextBlock(now: number): TextBlock {
  return { id: uid(), kind: "text", content: "", updatedAt: now };
}

function findNote(noteId: string): Note | null {
  return state.store.notes.find((n) => n.id === noteId && n.deletedAt === undefined) ?? null;
}

function findBlock(note: Note, blockId: string): Block | null {
  return note.blocks.find((b) => b.id === blockId) ?? null;
}

export function createNote(): Note {
  const now = Date.now();
  const note: Note = {
    id: uid(),
    title: "",
    color: NOTE_COLORS[state.store.notes.length % NOTE_COLORS.length],
    createdAt: now,
    updatedAt: now,
    blocks: [newTextBlock(now)],
  };
  state.store.notes.push(note);
  state.selectedNoteId = note.id;
  touchEditor();
  persistSoon();
  emit();
  return note;
}

export function selectNote(id: string | null): void {
  state.selectedNoteId = id;
  touchEditor();
  emit();
}

export function setSearch(q: string): void {
  state.search = q;
  emitSoon(120);
}

export function updateTitle(noteId: string, title: string): void {
  const note = findNote(noteId);
  if (!note) return;
  note.title = title;
  note.updatedAt = Date.now();
  persistSoon();
  emitSoon();
}

export function setColor(noteId: string, color: string): void {
  const note = findNote(noteId);
  if (!note) return;
  note.color = color;
  note.updatedAt = Date.now();
  touchEditor();
  persistSoon();
  emit();
}

export function togglePin(noteId: string): void {
  const note = findNote(noteId);
  if (!note) return;
  note.pinned = !note.pinned ? true : undefined;
  note.updatedAt = Date.now();
  touchEditor();
  persistSoon();
  emit();
}

export function deleteNote(noteId: string): void {
  const note = findNote(noteId);
  if (!note) return;
  const now = Date.now();
  note.deletedAt = now;
  delete note.purgedAt;
  note.updatedAt = now;
  if (state.selectedNoteId === noteId) state.selectedNoteId = null;
  touchEditor();
  persistSoon();
  emit();
}

/** 从垃圾桶恢复（清除墓碑；另一端会在合并时复活） */
export function restoreNote(noteId: string): void {
  const note = state.store.notes.find((n) => n.id === noteId);
  if (!note || note.deletedAt === undefined) return;
  const now = Date.now();
  delete note.deletedAt;
  delete note.purgedAt;
  note.updatedAt = now;
  state.selectedNoteId = noteId;
  state.view = "list";
  touchEditor();
  persistSoon();
  emit();
}

/**
 * 彻底删除：立即移除便签内容（本地与远端当前数据都不再保留），
 * 只写一条轻量删除记录（id+时间戳）用于把删除传播到其他设备。
 */
export function purgeNote(noteId: string): void {
  const note = state.store.notes.find((n) => n.id === noteId);
  if (!note) return;
  const now = Date.now();
  state.store.notes = state.store.notes.filter((n) => n.id !== noteId);
  state.store.purged = { ...(state.store.purged ?? {}), [noteId]: now };
  if (state.selectedNoteId === noteId) state.selectedNoteId = null;
  touchEditor();
  persistSoon();
  emit();
}

/**
 * 删除加密内容前的密码校验：对便签/块内任一加密块验密成功即放行。
 * （有意每次删除都要求重新输入，即使会话已解锁）
 */
export async function verifyPasswordForDeletion(
  note: Note,
  password: string
): Promise<void> {
  const secureBlocks = note.blocks.filter(
    (b): b is SecureBlock => b.kind === "secure"
  );
  if (secureBlocks.length === 0) return;
  let lastErr: unknown = new WrongPasswordError();
  for (const block of secureBlocks) {
    try {
      await unlockWithPassword(password, block);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** 校验密码对单个加密块有效（删除单个块时用） */
export async function verifyPasswordForBlock(
  noteId: string,
  blockId: string,
  password: string
): Promise<void> {
  const note = findNote(noteId);
  const block = note && findBlock(note, blockId);
  if (!note || !block || block.kind !== "secure") return;
  await unlockWithPassword(password, block);
}

export function addTextBlock(noteId: string): void {
  const note = findNote(noteId);
  if (!note) return;
  note.blocks.push(newTextBlock(Date.now()));
  note.updatedAt = Date.now();
  touchEditor();
  persistSoon();
  emit();
  // 聚焦到新块
  requestAnimationFrame(() => {
    const areas = document.querySelectorAll<HTMLTextAreaElement>(".block-row textarea");
    areas[areas.length - 1]?.focus();
  });
}

export function removeBlock(noteId: string, blockId: string): void {
  const note = findNote(noteId);
  if (!note) return;
  note.blocks = note.blocks.filter((b) => b.id !== blockId);
  if (note.blocks.length === 0) note.blocks.push(newTextBlock(Date.now()));
  note.updatedAt = Date.now();
  touchEditor();
  persistSoon();
  emit();
}

export function updateText(noteId: string, blockId: string, content: string): void {
  const note = findNote(noteId);
  const block = note && findBlock(note, blockId);
  if (!note || !block || block.kind !== "text") return;
  block.content = content;
  block.updatedAt = Date.now();
  note.updatedAt = Date.now();
  persistSoon();
  emitSoon();
}

export function updateSecurePlain(noteId: string, blockId: string, plain: string): void {
  const note = findNote(noteId);
  const block = note && findBlock(note, blockId);
  if (!note || !block || block.kind !== "secure") return;
  block.plain = plain;
  block.updatedAt = Date.now();
  note.updatedAt = Date.now();
  persistSoon();
  emitSoon();
}

/** 文本块 → 加密块。password 为空时使用会话缓存的主密码（须已解锁） */
export async function encryptBlock(
  noteId: string,
  blockId: string,
  password?: string,
  hint?: string,
  label?: string
): Promise<void> {
  const note = findNote(noteId);
  const block = note && findBlock(note, blockId);
  if (!note || !block || block.kind !== "text") return;
  const root = latestSessionRoot();
  if (!password && !root) throw new Error("需要主密码");
  const data = password
    ? await encryptText(password, block.content)
    : await encryptWithRoot(root!, block.content);
  const idx = note.blocks.indexOf(block);
  const secure: SecureBlock = {
    id: block.id,
    kind: "secure",
    salt: data.salt,
    iv: data.iv,
    cipher: data.cipher,
    updatedAt: Date.now(),
    ...(hint ? { hint } : {}),
    ...(label ? { label } : {}),
  };
  note.blocks[idx] = secure;
  note.updatedAt = Date.now();
  touchEditor();
  persistSoon();
  emit();
}

/** 修改加密块的对外显示名称（明文字段，锁定状态可见） */
export function renameSecureBlock(noteId: string, blockId: string, label: string): void {
  const note = findNote(noteId);
  const block = note && findBlock(note, blockId);
  if (!note || !block || block.kind !== "secure") return;
  const trimmed = label.trim();
  if (trimmed) block.label = trimmed;
  else delete block.label;
  block.updatedAt = Date.now();
  note.updatedAt = Date.now();
  touchEditor();
  persistSoon();
  emit();
}

/** 尝试用会话缓存解锁；缓存未命中返回 "need-password" */
export async function tryUnlock(noteId: string, blockId: string): Promise<"ok" | "need-password"> {
  const note = findNote(noteId);
  const block = note && findBlock(note, blockId);
  if (!note || !block || block.kind !== "secure") return "need-password";
  if (block.plain !== undefined) return "ok";
  if (!isSessionUnlocked()) return "need-password";
  block.plain = await decryptWithSession(block);
  note.updatedAt = Date.now();
  touchEditor();
  emit();
  return "ok";
}

/** 用输入的密码解锁（密码进入会话缓存） */
export async function unlockBlock(noteId: string, blockId: string, password: string): Promise<void> {
  const note = findNote(noteId);
  const block = note && findBlock(note, blockId);
  if (!note || !block || block.kind !== "secure") throw new WrongPasswordError();
  block.plain = await unlockWithPassword(password, block);
  note.updatedAt = Date.now();
  touchEditor();
  persistSoon();
  emit();
}

/** 上锁单个块：明文重新加密，内存中丢弃明文 */
export async function lockBlock(noteId: string, blockId: string): Promise<void> {
  const note = findNote(noteId);
  const block = note && findBlock(note, blockId);
  if (!note || !block || block.kind !== "secure" || block.plain === undefined) return;
  const idx = note.blocks.indexOf(block);
  if (latestSessionRoot()) {
    note.blocks[idx] = await relockBlock(latestSessionRoot()!, block);
  } else {
    note.blocks[idx] = { ...block, plain: undefined };
  }
  note.updatedAt = Date.now();
  touchEditor();
  persistSoon();
  emit();
}

/** 全部上锁：重加密所有已解锁块 + 清空会话密钥缓存 */
export async function lockAll(): Promise<void> {
  const root = latestSessionRoot();
  const now = Date.now();
  for (const note of state.store.notes) {
    if (note.deletedAt !== undefined) continue;
    for (let i = 0; i < note.blocks.length; i++) {
      const block = note.blocks[i];
      if (block.kind === "secure" && block.plain !== undefined) {
        note.blocks[i] = root
          ? await relockBlock(root, block)
          : { ...block, plain: undefined };
        note.updatedAt = now;
      }
    }
  }
  lockAllSession();
  touchEditor();
  persistSoon();
  emit();
}

// ---------- 同步结果写回 ----------

/**
 * 用合并结果替换本地数据。已解锁块的明文若对应密文未变化则保留，
 * 否则随新数据回到锁定态（明文绝不写入持久层）。
 */
export function replaceStore(merged: Store): void {
  // 合并前记录当前选中便签的可见内容快照
  const oldSel = getSelectedNote();
  const oldSnap = oldSel ? JSON.stringify(snapNote(oldSel)) : null;

  const oldPlain = new Map<string, { cipher: string; plain: string }>();
  for (const n of state.store.notes) {
    for (const b of n.blocks) {
      if (b.kind === "secure" && b.plain !== undefined) {
        oldPlain.set(b.id, { cipher: b.cipher, plain: b.plain });
      }
    }
  }
  state.store = stripPlaintext(merged);
  for (const n of state.store.notes) {
    for (const b of n.blocks) {
      if (b.kind === "secure") {
        const kept = oldPlain.get(b.id);
        if (kept && kept.cipher === b.cipher) b.plain = kept.plain;
      }
    }
  }
  if (state.selectedNoteId && !getSelectedNote()) state.selectedNoteId = null;

  // 选中便签的可见内容没变时不重建编辑器：
  // 同步在打字/输入法组合中途发生时，重建会让未上屏的输入“一闪消失”
  const newSel = getSelectedNote();
  const newSnap = newSel ? JSON.stringify(snapNote(newSel)) : null;
  if (newSnap !== oldSnap) touchEditor();
  persistSoon();
  emit();
}

/** 编辑器重建相关字段的快照（刻意排除 updatedAt 等纯元数据） */
function snapNote(n: Note): unknown {
  return {
    id: n.id,
    title: n.title,
    color: n.color,
    pinned: n.pinned,
    deletedAt: n.deletedAt,
    blocks: n.blocks.map((b) =>
      b.kind === "secure"
        ? { id: b.id, kind: b.kind, salt: b.salt, iv: b.iv, cipher: b.cipher, label: b.label, hint: b.hint }
        : { id: b.id, kind: b.kind, content: b.content }
    ),
  };
}

/** 供同步引擎读取的干净快照（无明文） */
export function getStoreForSync(): Store {
  return stripPlaintext(state.store);
}
