// 弹窗与轻提示：密码弹窗（解锁/设置）、确认、设置、欢迎引导

import { el } from "./dom";
import { getSyncCfg, getState, saveSyncCfg, saveSettings, verifyPasswordForDeletion } from "@/state";
import { syncNow } from "@/engine";
import { GitHubSync } from "@/sync";
import { WrongPasswordError } from "@/crypto";
import type { Note } from "@/types";

// ---------- 基础模态 ----------

interface ModalHandle {
  close: () => void;
}

function openModal(content: HTMLElement): ModalHandle {
  const overlay = el("div", "modal-overlay");
  const dialog = el("div", "modal");
  dialog.append(content);
  overlay.append(dialog);
  const onKey = (e: KeyboardEvent): void => {
    // 中文输入法组合中按 Esc 是取消候选词，不能把弹窗一起关掉
    if (e.key === "Escape") {
      if (e.isComposing || e.keyCode === 229) return;
      close();
    }
  };
  const close = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
  return { close };
}

export type PasswordResult = string | { password: string; hint?: string; label?: string } | null;

/**
 * 密码弹窗。
 * mode=unlock：输入密码解锁，返回 string | null(取消)
 * mode=set：设置主密码（含确认+提示语），返回 { password, hint } | null
 */
export function passwordModal(opts: {
  mode: "set" | "unlock";
  hint?: string;
}): Promise<PasswordResult> {
  return new Promise((outerResolve) => {
    let settled = false;
    const resolve = (v: PasswordResult): void => {
      if (settled) return;
      settled = true;
      outerResolve(v);
    };

    const box = el("div", "pw-box");
    const err = el("div", "field-error");
    let modal: ModalHandle;
    const finish = (v: PasswordResult): void => {
      resolve(v);
      modal.close();
    };
    const showErr = (input: HTMLInputElement, msg: string): void => {
      err.textContent = msg;
      input.classList.add("invalid", "shake");
      void input.offsetWidth; // 重启动画
      input.focus();
      input.select();
    };

    let inputs: HTMLInputElement[] = [];
    if (opts.mode === "unlock") {
      box.append(el("h3", null, "🔒 输入主密码解锁"));
      if (opts.hint) box.append(el("p", "desc", `提示：${opts.hint}`));
      const pw = el("input") as HTMLInputElement;
      pw.type = "password";
      pw.placeholder = "主密码";
      inputs = [pw];
      box.append(pw);
      const row = el("div", "modal-actions");
      const cancel = el("button", "btn btn-ghost", "取消");
      const ok = el("button", "btn", "解锁");
      cancel.onclick = () => finish(null);
      ok.onclick = () => {
        if (!pw.value) return showErr(pw, "密码不能为空");
        finish(pw.value);
      };
      pw.onkeydown = (e) => {
        if (e.key === "Enter") ok.click();
      };
      row.append(cancel, ok);
      box.append(row, err);
    } else {
      box.append(el("h3", null, "🔒 加密此内容块"));
      box.append(
        el(
          "p",
          "desc",
          "主密码不会存储在任何地方，忘记后对应内容将无法解开。显示名称在锁定状态下可见（明文），请勿把敏感信息写在这里。"
        )
      );
      const name = el("input") as HTMLInputElement;
      name.type = "text";
      name.placeholder = "显示名称（可选，如“银行卡密码”）";
      const pw = el("input") as HTMLInputElement;
      const pw2 = el("input") as HTMLInputElement;
      const hint = el("input") as HTMLInputElement;
      pw.type = pw2.type = "password";
      hint.type = "text";
      pw.placeholder = "主密码";
      pw2.placeholder = "再输入一次";
      hint.placeholder = "密码提示（可选）";
      inputs = [pw, pw2];
      box.append(name, pw, pw2, hint);
      const row = el("div", "modal-actions");
      const cancel = el("button", "btn btn-ghost", "取消");
      const ok = el("button", "btn", "加密");
      cancel.onclick = () => finish(null);
      ok.onclick = () => {
        if (!pw.value) return showErr(pw, "密码不能为空");
        if (pw.value !== pw2.value) return showErr(pw2, "两次输入的密码不一致");
        finish({
          password: pw.value,
          hint: hint.value.trim() || undefined,
          label: name.value.trim() || undefined,
        });
      };
      row.append(cancel, ok);
      box.append(row, err);
    }
    modal = openModal(box);
    // Esc / 点遮罩关闭 → 视为取消
    const origClose = modal.close.bind(modal);
    modal.close = () => {
      resolve(null);
      origClose();
    };
    inputs[0]?.focus();
  });
}

/**
 * 单行文本输入弹窗（如：修改加密块显示名称）
 */
export function textPromptModal(opts: {
  title: string;
  placeholder?: string;
  value?: string;
  okText?: string;
}): Promise<string | null> {
  return new Promise((outerResolve) => {
    let settled = false;
    const resolve = (v: string | null): void => {
      if (settled) return;
      settled = true;
      outerResolve(v);
    };

    const box = el("div", "pw-box");
    box.append(el("h3", null, opts.title));
    const input = el("input") as HTMLInputElement;
    input.type = "text";
    input.placeholder = opts.placeholder ?? "";
    input.value = opts.value ?? "";
    box.append(input);
    const row = el("div", "modal-actions");
    const cancel = el("button", "btn btn-ghost", "取消");
    const ok = el("button", "btn", opts.okText ?? "保存");
    let modal: ModalHandle;
    cancel.onclick = () => {
      resolve(null);
      modal.close();
    };
    ok.onclick = () => {
      resolve(input.value);
      modal.close();
    };
    input.onkeydown = (e) => {
      if (e.key === "Enter") ok.click();
    };
    row.append(cancel, ok);
    box.append(row);
    modal = openModal(box);
    const origClose = modal.close.bind(modal);
    modal.close = () => {
      resolve(null);
      origClose();
    };
    input.focus();
    input.select();
  });
}

export function confirmModal(
  message: string,
  opts: { okText?: string; danger?: boolean } = {}
): Promise<boolean> {
  return new Promise((outerResolve) => {
    let settled = false;
    const resolve = (v: boolean): void => {
      if (settled) return;
      settled = true;
      outerResolve(v);
    };

    const box = el("div", "pw-box");
    box.append(el("h3", null, message));
    const row = el("div", "modal-actions");
    const cancel = el("button", "btn btn-ghost", "取消");
    const ok = el("button", "btn" + (opts.danger ? " btn-danger" : ""), opts.okText ?? "确定");
    let modal: ModalHandle;
    cancel.onclick = () => {
      resolve(false);
      modal.close();
    };
    ok.onclick = () => {
      resolve(true);
      modal.close();
    };
    row.append(cancel, ok);
    box.append(row);
    modal = openModal(box);
    const origClose = modal.close.bind(modal);
    modal.close = () => {
      resolve(false);
      origClose();
    };
    ok.focus();
  });
}

// ---------- 设置弹窗 ----------

export function settingsModal(): void {
  const cur = getSyncCfg();
  const box = el("div", "pw-box settings-box");
  box.append(
    el("h3", null, "⚙️ 同步设置"),
    el(
      "p",
      "desc",
      "便签数据将同步到你自己的 GitHub 私有仓库（单文件 JSON）。需要一个具备该仓库 Contents 读写权限的 fine-grained Token，创建地址：github.com/settings/personal-access-tokens/new"
    )
  );

  const mk = (label: string, input: HTMLInputElement): HTMLElement => {
    input.spellcheck = false;
    const wrap = el("div", "field");
    wrap.append(el("label", null, label), input);
    return wrap;
  };

  const token = el("input") as HTMLInputElement;
  token.type = "password";
  token.placeholder = "github_pat_…";
  const owner = el("input") as HTMLInputElement;
  owner.placeholder = "你的 GitHub 用户名";
  const repo = el("input") as HTMLInputElement;
  repo.placeholder = "仓库名（不存在会尝试自动创建私有仓库）";
  const branch = el("input") as HTMLInputElement;
  branch.placeholder = "main";
  const path = el("input") as HTMLInputElement;
  path.placeholder = "notes.json";

  if (cur) {
    token.value = cur.token;
    owner.value = cur.owner;
    repo.value = cur.repo;
    branch.value = cur.branch;
    path.value = cur.path;
  }

  const cfgNow = (): { owner: string; repo: string; branch: string; path: string; token: string } => ({
    owner: owner.value.trim(),
    repo: repo.value.trim(),
    branch: branch.value.trim() || "main",
    path: path.value.trim() || "notes.json",
    token: token.value.trim(),
  });

  const testMsg = el("div", "field-error");
  const testBtn = el("button", "btn btn-ghost", "测试连接") as HTMLButtonElement;
  testBtn.onclick = async () => {
    const c = cfgNow();
    if (!c.owner || !c.repo || !c.token) {
      testMsg.textContent = "请先填写 Token、所有者和仓库名";
      testMsg.classList.add("err");
      return;
    }
    testBtn.disabled = true;
    testBtn.textContent = "测试中…";
    testMsg.classList.remove("err");
    testMsg.textContent = "…";
    const r = await new GitHubSync(c).testConnection();
    testBtn.disabled = false;
    testBtn.textContent = "测试连接";
    testMsg.textContent = r.message;
    testMsg.classList.toggle("err", !r.ok);
  };

  const saveMsg = el("div", "field-error");
  const saveBtn = el("button", "btn", "保存并同步") as HTMLButtonElement;
  saveBtn.onclick = async () => {
    const c = cfgNow();
    if (!c.owner || !c.repo || !c.token) {
      saveMsg.textContent = "Token、所有者和仓库名为必填项";
      saveMsg.classList.add("err");
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";
    await saveSyncCfg(c);
    saveBtn.textContent = "已保存";
    modal.close();
    void syncNow("manual");
  };

  const actions = el("div", "modal-actions");
  const cancel = el("button", "btn btn-ghost", "取消");
  cancel.onclick = () => modal.close();
  actions.append(cancel, testBtn, saveBtn);

  box.append(
    mk("Token（仅保存在本机）", token),
    mk("仓库所有者 Owner", owner),
    mk("仓库名 Repo", repo),
    el("div", "field-row", mk("分支 Branch", branch), mk("文件路径 Path", path)),
    actions,
    saveMsg
  );
  const modal = openModal(box);
  token.focus();
}

// ---------- 欢迎引导（仅一次） ----------

export async function maybeWelcome(): Promise<void> {
  if (getState().settings.welcomed) return;
  const box = el("div", "pw-box");
  box.append(el("h3", null, "🐟 欢迎使用鱼记得 note"));
  const list = el("ul", "welcome-list");
  list.append(
    el("li", null, "便签里可以插入加密内容块：点 🔒 上锁、点击解锁，「全部上锁」一键锁好"),
    el("li", null, "数据可同步到你自己的 GitHub 私有仓库，多台设备自动保持一致"),
    el("li", null, "加密块在本机加密后才上传，GitHub 上永远只有密文")
  );
  box.append(list);
  const actions = el("div", "modal-actions");
  const later = el("button", "btn btn-ghost", "先开始用");
  const setup = el("button", "btn", "配置同步");
  later.onclick = () => finish();
  setup.onclick = () => {
    finish();
    settingsModal();
  };
  const finish = (): void => {
    void saveSettings({ ...getState().settings, welcomed: true });
    modal.close();
  };
  actions.append(later, setup);
  box.append(actions);
  const modal = openModal(box);
}

/**
 * 删除（含彻底删除）含加密内容的便签前的统一关卡：确认 + 重新输入主密码。
 * （即使会话已解锁，删除加密内容也要求再输一次密码）
 * 无加密内容时只走确认。返回 true = 允许删除。
 */
export async function confirmDeletionPassword(note: Note, action: string): Promise<boolean> {
  const secureCount = note.blocks.filter((b) => b.kind === "secure").length;
  const name = note.title.trim() || "无标题便签";
  const ok = await confirmModal(
    secureCount > 0
      ? `${action}「${name}」？含 ${secureCount} 个加密块，需输入主密码`
      : `${action}「${name}」？`,
    { okText: action, danger: true }
  );
  if (!ok) return false;
  if (secureCount === 0) return true;

  const pw = await passwordModal({ mode: "unlock" });
  if (pw === null || typeof pw !== "string") return false;
  try {
    await verifyPasswordForDeletion(note, pw);
    return true;
  } catch (e) {
    if (e instanceof WrongPasswordError) toast("密码错误，未删除", "error");
    else toast("校验失败，未删除", "error");
    return false;
  }
}

// ---------- 轻提示 ----------

let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(message: string, kind: "info" | "error" = "info"): void {
  document.querySelector(".toast")?.remove();
  const t = el("div", "toast" + (kind === "error" ? " toast-error" : ""), message);
  document.body.append(t);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2400);
}
