// 应用装配：布局骨架 + 订阅渲染

import { getState, subscribe } from "@/state";
import { buildSidebar, renderNoteCards } from "./notelist";
import { renderEditor } from "./editor";
import { renderStatusbar } from "./statusbar";
import { maybeWelcome } from "./modals";
import { el } from "./dom";

export function mountApp(root: HTMLElement): void {
  root.innerHTML = "";
  const app = el("div", "app");

  const { root: sidebar, cards } = buildSidebar();
  const main = el("main", "main");
  const statusbar = el("footer", "statusbar");

  app.append(sidebar, main);
  root.append(app, statusbar);

  let lastRev = -1;
  const render = (): void => {
    renderNoteCards(cards);
    renderStatusbar(statusbar);
    if (lastRev !== getState().editorRev) {
      lastRev = getState().editorRev;
      renderEditor(main);
    }
  };
  subscribe(render);
  render();
  void maybeWelcome();
}
