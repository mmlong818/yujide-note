// 加密模块单测：往返、错密码、防篡改、会话缓存语义

import { beforeEach, describe, expect, it } from "vitest";
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
import type { SecureBlock } from "@/types";

function asBlock(data: { salt: string; iv: string; cipher: string }, extra: Partial<SecureBlock> = {}): SecureBlock {
  return { id: "b1", kind: "secure", updatedAt: 0, ...data, ...extra };
}

beforeEach(() => lockAllSession());

describe("encryptText / unlockWithPassword", () => {
  it("往返解密（含中文与 emoji）", async () => {
    const data = await encryptText("主密码123", "机密内容 ✅ 账号 abc");
    const plain = await unlockWithPassword("主密码123", asBlock(data));
    expect(plain).toBe("机密内容 ✅ 账号 abc");
  });

  it("错误密码抛 WrongPasswordError", async () => {
    const data = await encryptText("正确密码", "秘密");
    await expect(unlockWithPassword("错误密码", asBlock(data))).rejects.toThrow(WrongPasswordError);
  });

  it("密文被篡改 → 解密失败（GCM 防篡改）", async () => {
    const data = await encryptText("pw", "秘密");
    const corrupted = { ...data, cipher: data.cipher.slice(0, -4) + "AAAA" };
    await expect(unlockWithPassword("pw", asBlock(corrupted))).rejects.toThrow(WrongPasswordError);
  });

  it("同密码两次加密产生不同盐和密文", async () => {
    const a = await encryptText("pw", "同一段话");
    const b = await encryptText("pw", "同一段话");
    expect(a.salt).not.toBe(b.salt);
    expect(a.cipher).not.toBe(b.cipher);
  });
});

describe("会话缓存", () => {
  it("解锁后 isSessionUnlocked 为真，lockAll 清空", async () => {
    expect(isSessionUnlocked()).toBe(false);
    const data = await encryptText("pw", "内容");
    await unlockWithPassword("pw", asBlock(data));
    expect(isSessionUnlocked()).toBe(true);
    lockAllSession();
    expect(isSessionUnlocked()).toBe(false);
  });

  it("会话解锁后其它块可 decryptWithSession 免密解锁", async () => {
    const d1 = await encryptText("pw", "第一块");
    await unlockWithPassword("pw", asBlock(d1));
    const d2 = await encryptText("pw", "第二块");
    const plain = await decryptWithSession(asBlock(d2));
    expect(plain).toBe("第二块");
  });

  it("会话未解锁时 decryptWithSession 抛错", async () => {
    const d = await encryptText("pw", "内容");
    lockAllSession();
    await expect(decryptWithSession(asBlock(d))).rejects.toThrow(WrongPasswordError);
  });

  it("换密码后旧块用新会话密码解不开，需旧密码", async () => {
    const old = await encryptText("旧密码", "旧内容");
    await unlockWithPassword("新密码", asBlock(await encryptText("新密码", "新内容")));
    // 模拟另一台设备的新会话：缓存里只有新密码
    lockAllSession();
    await unlockWithPassword("新密码", asBlock(await encryptText("新密码", "新内容")));
    await expect(decryptWithSession(asBlock(old))).rejects.toThrow(WrongPasswordError);
    // 输入旧密码仍然能解开
    expect(await unlockWithPassword("旧密码", asBlock(old))).toBe("旧内容");
    // 两个 root 都在缓存里，现在两块都能免密解锁
    expect(await decryptWithSession(asBlock(old))).toBe("旧内容");
  });
});

describe("relockBlock", () => {
  it("用缓存 root 重新上锁后可再次解锁", async () => {
    const d = await encryptText("pw", "原文");
    const root = latestSessionRoot();
    expect(root).not.toBeNull();
    const block = asBlock(d, { plain: "原文（已编辑）" });
    const locked = await relockBlock(root!, block);
    expect(locked.plain).toBeUndefined();
    expect(locked.cipher).not.toBe(d.cipher);
    expect(await unlockWithPassword("pw", locked)).toBe("原文（已编辑）");
  });
});

describe("encryptWithRoot", () => {
  it("直接用 root 加密并解锁", async () => {
    const d0 = await encryptText("pw", "x");
    const root = latestSessionRoot()!;
    const d = await encryptWithRoot(root, "用根密钥加密");
    expect(await unlockWithPassword("pw", asBlock(d))).toBe("用根密钥加密");
    expect(await unlockWithPassword("pw", asBlock(d0))).toBe("x");
  });
});
