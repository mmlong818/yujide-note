// 左侧栏：静态头部（搜索 + 新建 + 垃圾桶入口）与便签卡片列表 / 垃圾桶列表

import { el, fmtDate, fmtTime } from "./dom";
import {
  createNote,
  getState,
  getView,
  purgeNote,
  restoreNote,
  selectNote,
  setSearch,
  setView,
  trashNotes,
  visibleNotes,
} from "@/state";
import { hasSecureBlocks, noteSummary } from "@/types";
import { toast, confirmDeletionPassword } from "./modals";

export interface SidebarParts {
  root: HTMLElement;
  cards: HTMLElement;
}

let trashBtn: HTMLButtonElement | null = null;
let searchInput: HTMLInputElement | null = null;

/** 一次性搭建侧栏静态结构；只有卡片区域参与每次重渲染 */
export function buildSidebar(): SidebarParts {
  const root = el("aside", "sidebar");

  searchInput = el("input", "search-input") as HTMLInputElement;
  searchInput.type = "search";
  searchInput.placeholder = "搜索便签…";
  searchInput.oninput = () => setSearch(searchInput!.value);

  const newBtn = el("button", "new-note-btn", "＋ 新建便签");
  newBtn.onclick = () => createNote();

  trashBtn = el("button", "trash-toggle-btn", "🗑 垃圾桶") as HTMLButtonElement;
  trashBtn.onclick = () => setView(getView() === "trash" ? "list" : "trash");

  const header = el("div", "sidebar-header", searchInput, newBtn, trashBtn);
  const cards = el("div", "note-cards");
  root.append(header, cards);
  return { root, cards };
}

function updateHeaderForView(view: "list" | "trash"): void {
  const count = trashNotes().length;
  if (trashBtn) {
    trashBtn.textContent =
      view === "trash" ? "← 返回便签列表" : `🗑 垃圾桶${count ? ` (${count})` : ""}`;
    trashBtn.classList.toggle("active", view === "trash");
  }
  if (searchInput) {
    searchInput.disabled = view === "trash";
    searchInput.placeholder = view === "trash" ? "垃圾桶不支持搜索" : "搜索便签…";
  }
}

export function renderNoteCards(container: HTMLElement): void {
  const { store, search, selectedNoteId, view } = getState();
  container.innerHTML = "";
  updateHeaderForView(view);

  if (view === "trash") {
    renderTrashCards(container);
    return;
  }

  const alive = store.notes.filter((n) => n.deletedAt === undefined);
  const notes = visibleNotes(); // 已按搜索过滤 + 置顶/时间排序

  if (alive.length === 0) {
    container.append(
      el("div", "list-empty", "还没有便签", el("div", "list-empty-sub", "点上面的「＋ 新建便签」开始 ✍️"))
    );
    return;
  }
  if (notes.length === 0) {
    container.append(el("div", "list-empty", `没有包含「${search.trim()}」的便签`));
    return;
  }

  for (const note of notes) {
    const card = el("div", "note-card" + (note.id === selectedNoteId ? " selected" : ""));
    card.style.setProperty("--c", note.color);

    const dot = el("span", "card-dot");
    dot.style.background = note.color;
    const title = el("span", "card-title", note.title.trim() || "无标题");
    const top = el("div", "card-top", dot, title);
    if (note.pinned) top.append(el("span", "card-pin", "📌"));

    const secureCount = note.blocks.filter((b) => b.kind === "secure").length;
    const meta = el("div", "card-meta");
    if (hasSecureBlocks(note)) meta.append(el("span", "card-lock", `🔒 ${secureCount}`));
    meta.append(el("span", "card-date", fmtDate(note.updatedAt)));

    card.append(top, el("div", "card-snippet", noteSummary(note) || "空便签"), meta);
    card.onclick = () => selectNote(note.id);
    container.append(card);
  }
}

function renderTrashCards(container: HTMLElement): void {
  const items = trashNotes();
  if (items.length === 0) {
    container.append(
      el("div", "list-empty", "垃圾桶是空的", el("div", "list-empty-sub", "删除的便签会先放在这里"))
    );
    return;
  }
  for (const note of items) {
    const card = el("div", "note-card trash-card");
    card.style.setProperty("--c", note.color);

    const dot = el("span", "card-dot");
    dot.style.background = note.color;
    const top = el(
      "div",
      "card-top",
      dot,
      el("span", "card-title", note.title.trim() || "无标题")
    );

    const meta = el(
      "div",
      "card-snippet",
      `删除于 ${fmtDate(note.deletedAt ?? 0)} ${fmtTime(note.deletedAt ?? 0)} · ${
        noteSummary(note, 18) || "空便签"
      }`
    );

    const actions = el("div", "trash-actions");
    const restoreBtn = el("button", "btn btn-small btn-ghost", "恢复") as HTMLButtonElement;
    restoreBtn.onclick = (e) => {
      e.stopPropagation();
      restoreNote(note.id);
      toast("已恢复便签");
    };
    const purgeBtn = el("button", "btn btn-small btn-danger", "彻底删除") as HTMLButtonElement;
    purgeBtn.onclick = async (e) => {
      e.stopPropagation();
      if (!(await confirmDeletionPassword(note, "彻底删除"))) return;
      purgeNote(note.id);
      toast("已彻底删除，内容立即从本地与远端移除");
    };

    actions.append(restoreBtn, purgeBtn);
    card.append(top, meta, actions);
    container.append(card);
  }
}
