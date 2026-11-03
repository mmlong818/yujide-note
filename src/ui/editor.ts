// 右侧编辑区：一张按便签颜色着色的“大便利贴”，内容按块堆叠

import { el, autoGrow } from "./dom";
import { toast, passwordModal, confirmModal, confirmDeletionPassword } from "./modals";
import {
  addTextBlock,
  encryptBlock,
  getSelectedNote,
  lockAll,
  lockBlock,
  removeBlock,
  setColor,
  updateSecurePlain,
  tryUnlock,
  unlockBlock,
  updateText,
  updateTitle,
  togglePin,
  deleteNote,
  createNote,
  verifyPasswordForBlock,
} from "@/state";
import { WrongPasswordError, isSessionUnlocked } from "@/crypto";
import { NOTE_COLORS, type Block, type Note, type SecureBlock, type TextBlock } from "@/types";

export function renderEditor(main: HTMLElement): void {
  main.innerHTML = "";
  const note = getSelectedNote();
  if (!note) {
    main.append(emptyState());
    return;
  }

  const paper = el("div", "paper");
  paper.style.setProperty("--paper-color", note.color);

  // ---- 头部：标题 + 置顶/删除 ----
  const title = el("input", "paper-title") as HTMLInputElement;
  title.value = note.title;
  title.placeholder = "标题";
  title.oninput = () => updateTitle(note.id, title.value);

  const pinBtn = el("button", "icon-btn paper-action", note.pinned ? "📌" : "📍") as HTMLButtonElement;
  pinBtn.title = note.pinned ? "取消置顶" : "置顶";
  pinBtn.onclick = () => togglePin(note.id);

  const delBtn = el("button", "icon-btn paper-action", "🗑") as HTMLButtonElement;
  delBtn.title = "删除便签（移入垃圾桶）";
  delBtn.onclick = async () => {
    if (!(await confirmDeletionPassword(note, "删除"))) return;
    deleteNote(note.id);
    toast("已移入垃圾桶，可在侧栏垃圾桶恢复 🗑");
  };

  const headRight = el("div", "paper-actions", pinBtn, delBtn);
  const head = el("div", "paper-head", title, headRight);

  // ---- 颜色 ----
  const dots = el("div", "color-dots");
  for (const c of NOTE_COLORS) {
    const dot = el("button", "color-dot" + (c === note.color ? " active" : "")) as HTMLButtonElement;
    dot.style.background = c;
    dot.title = "更换颜色";
    dot.onclick = () => setColor(note.id, c);
    dots.append(dot);
  }

  // ---- 内容块 ----
  const blocks = el("div", "blocks");
  for (const block of note.blocks) blocks.append(renderBlock(note, block));

  const addBtn = el("button", "add-block-btn", "＋ 添加内容块") as HTMLButtonElement;
  addBtn.onclick = () => addTextBlock(note.id);

  paper.append(head, dots, blocks, addBtn);
  main.append(paper);
}

// ---------- 空状态 ----------

function emptyState(): HTMLElement {
  const wrap = el("div", "editor-empty");
  const newBtn = el("button", "btn", "＋ 新建便签") as HTMLButtonElement;
  newBtn.onclick = () => createNote();
  wrap.append(
    el("div", "editor-empty-emoji", "📝"),
    el("div", "editor-empty-title", "选中左侧便签，或新建一张"),
    newBtn
  );
  return wrap;
}

// ---------- 内容块渲染 ----------

function renderBlock(note: Note, block: Block): HTMLElement {
  if (block.kind === "text") return renderTextBlock(note, block);
  return block.plain === undefined
    ? renderSealedBlock(note, block)
    : renderOpenSecureBlock(note, block);
}

function blockActions(...btns: HTMLElement[]): HTMLElement {
  return el("div", "block-actions", ...btns);
}

function iconBtn(text: string, title: string): HTMLButtonElement {
  const b = el("button", "icon-btn", text) as HTMLButtonElement;
  b.title = title;
  return b;
}

function renderTextBlock(note: Note, block: TextBlock): HTMLElement {
  const row = el("div", "block-row");
  const area = el("textarea", "block-input") as HTMLTextAreaElement;
  area.value = block.content;
  area.placeholder = "写点什么…";
  area.oninput = () => updateText(note.id, block.id, area.value);
  autoGrow(area);

  const enc = iconBtn("🔒", "加密此块");
  enc.onclick = () => void onEncrypt(note, block);
  const del = iconBtn("🗑", "删除此块");
  del.onclick = async () => {
    if (!block.content.trim() || (await confirmModal("删除这个内容块？", { okText: "删除", danger: true }))) {
      removeBlock(note.id, block.id);
    }
  };

  row.append(area, blockActions(enc, del));
  return row;
}

/** 删除加密内容块（锁定/解锁状态均可）：确认 + 重新输入主密码 */
async function onDeleteSecureBlock(note: Note, block: SecureBlock): Promise<void> {
  const ok = await confirmModal("删除这个加密内容块？（密文将被移除并同步）", {
    okText: "删除",
    danger: true,
  });
  if (!ok) return;
  const pw = await passwordModal({ mode: "unlock" });
  if (pw === null || typeof pw !== "string") return;
  try {
    await verifyPasswordForBlock(note.id, block.id, pw);
  } catch {
    toast("密码错误，未删除", "error");
    return;
  }
  removeBlock(note.id, block.id);
  toast("已删除加密块");
}

/** 锁定的保密块：深色卡片，点击解锁；右侧 🗑 删除（需密码） */
function renderSealedBlock(note: Note, block: SecureBlock): HTMLElement {
  const card = el("div", "sealed");
  card.append(el("span", "sealed-icon", "🔒"));
  const textWrap = el("div", "sealed-text");
  textWrap.append(el("div", "sealed-title", "已加密内容"));
  if (block.hint) textWrap.append(el("div", "sealed-hint", `提示：${block.hint}`));
  const del = iconBtn("🗑", "删除此块（需主密码）");
  del.classList.add("sealed-del");
  del.onclick = (e) => {
    e.stopPropagation();
    void onDeleteSecureBlock(note, block);
  };
  card.append(textWrap, del, el("span", "sealed-go", "点击解锁 ›"));
  card.onclick = () => void onUnlock(note, block);
  const row = el("div", "block-row sealed-row", card);
  return row;
}

/** 已解锁的保密块：可编辑文本 + 块尾常显 🔓 */
function renderOpenSecureBlock(note: Note, block: SecureBlock): HTMLElement {
  const row = el("div", "block-row secure-open-row");
  const area = el("textarea", "block-input secure-open") as HTMLTextAreaElement;
  area.value = block.plain ?? "";
  area.placeholder = "保密内容（仅本会话可见）";
  area.oninput = () => updateSecurePlain(note.id, block.id, area.value);
  autoGrow(area);

  const lockToggle = el("button", "lock-toggle", "🔓") as HTMLButtonElement;
  lockToggle.title = "上锁";
  lockToggle.onclick = () => void lockBlock(note.id, block.id);

  const del = iconBtn("🗑", "删除此块（需主密码）");
  del.onclick = () => void onDeleteSecureBlock(note, block);

  row.append(area, lockToggle, blockActions(del));
  return row;
}

// ---------- 加解锁流程 ----------

async function onEncrypt(note: Note, block: TextBlock): Promise<void> {
  if (!block.content.trim()) {
    toast("先写点内容再加密");
    return;
  }
  if (isSessionUnlocked()) {
    // 会话已解锁：直接用缓存主密码加密
    await encryptBlock(note.id, block.id);
    return;
  }
  const res = await passwordModal({ mode: "set" });
  if (!res || typeof res === "string") return;
  await encryptBlock(note.id, block.id, res.password, res.hint);
}

async function onUnlock(note: Note, block: SecureBlock): Promise<void> {
  try {
    const r = await tryUnlock(note.id, block.id);
    if (r === "ok") return; // emit 已触发重渲染
  } catch {
    // 会话密钥不匹配 → 走密码输入
  }
  const pw = await passwordModal({ mode: "unlock", hint: block.hint });
  if (pw === null || typeof pw !== "string") return;
  try {
    await unlockBlock(note.id, block.id, pw);
  } catch (e) {
    if (e instanceof WrongPasswordError) toast("密码错误，请重试", "error");
    else toast("解锁失败", "error");
  }
}

/** 供状态栏调用 */
export async function lockEverything(): Promise<void> {
  await lockAll();
  toast("已全部上锁 🔒");
}
