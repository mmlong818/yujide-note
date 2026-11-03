// 轻量 DOM 辅助

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

/** textarea 自动长高 */
export function autoGrow(area: HTMLTextAreaElement): void {
  const grow = (): void => {
    area.style.height = "auto";
    area.style.height = area.scrollHeight + "px";
  };
  area.addEventListener("input", grow);
  // 首次测量必须等元素挂载到文档（未挂载时 scrollHeight 恒为 0）
  requestAnimationFrame(grow);
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${p(d.getDate())}`;
}
