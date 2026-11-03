// 加密设计（全局主密码 · 会话缓存）：
//   root  = PBKDF2-SHA256(password, 固定应用盐, 310k 次)  → 32B，仅存在于内存会话缓存
//   key   = HKDF-SHA256(root, 盐=每块独立随机盐, info)     → AES-256-GCM 密钥
// 密码本身永不缓存；缓存的是派生 root，因此同一会话内其它块解锁无需重复输入。
// HKDF 无迭代成本，逐块派生开销可忽略。

import { bytesToB64, b64ToBytes, asBuffer } from "./b64";
import type { SecureBlock } from "./types";

const PBKDF2_ITERATIONS = 310_000;
const ROOT_INFO_APP_SALT = "dbq-root-salt-v1";
const HKDF_INFO = "dbq-block-enc-v1";

/** 会话内已解锁的 root 密钥集合（最新的排最前） */
const sessionRoots: Uint8Array[] = [];

export function isSessionUnlocked(): boolean {
  return sessionRoots.length > 0;
}

export function lockAllSession(): void {
  sessionRoots.length = 0;
}

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("当前环境不支持 WebCrypto");
  return c.subtle;
}

function randomB64(len: number): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return bytesToB64(buf);
}

async function deriveRootBits(password: string): Promise<Uint8Array> {
  const keyMat = await subtle().importKey(
    "raw",
    asBuffer(new TextEncoder().encode(password)),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await subtle().deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: asBuffer(new TextEncoder().encode(ROOT_INFO_APP_SALT)),
      iterations: PBKDF2_ITERATIONS,
    },
    keyMat,
    256
  );
  return new Uint8Array(bits);
}

async function deriveBlockKey(root: Uint8Array, saltB64: string): Promise<CryptoKey> {
  const hkdfKey = await subtle().importKey("raw", asBuffer(root), "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: asBuffer(b64ToBytes(saltB64)), info: asBuffer(new TextEncoder().encode(HKDF_INFO)) },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function addSessionRoot(root: Uint8Array): void {
  const idx = sessionRoots.findIndex((r) => r.length === root.length && r.every((v, i) => v === root[i]));
  if (idx !== -1) sessionRoots.splice(idx, 1); // 提到最前，保持“最近使用的密码优先”
  sessionRoots.unshift(root);
}

export interface SecureBlockData {
  salt: string;
  iv: string;
  cipher: string;
}

/** 把明文加密成 secure 块数据。password 同时进入会话缓存。 */
export async function encryptText(password: string, text: string): Promise<SecureBlockData> {
  const root = await deriveRootBits(password);
  addSessionRoot(root);
  return encryptWithRoot(root, text);
}

/** 用已缓存的 root 加密（上锁被编辑过的块时使用，不再弹密码） */
export async function encryptWithRoot(root: Uint8Array, text: string): Promise<SecureBlockData> {
  const salt = randomB64(16);
  const iv = randomB64(12);
  const key = await deriveBlockKey(root, salt);
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv: asBuffer(b64ToBytes(iv)) },
    key,
    asBuffer(new TextEncoder().encode(text))
  );
  return { salt, iv, cipher: bytesToB64(new Uint8Array(ct)) };
}

export class WrongPasswordError extends Error {
  constructor() {
    super("密码错误");
  }
}

/** 依次尝试会话缓存的 root，成功则返回明文 */
export async function decryptWithSession(block: Pick<SecureBlock, "salt" | "iv" | "cipher">): Promise<string> {
  for (const root of [...sessionRoots]) {
    const plain = await tryDecrypt(root, block);
    if (plain !== null) return plain;
  }
  throw new WrongPasswordError();
}

/** 用输入的密码解锁一个块；成功后密码进入会话缓存（后续块免输入） */
export async function unlockWithPassword(
  password: string,
  block: Pick<SecureBlock, "salt" | "iv" | "cipher">
): Promise<string> {
  const root = await deriveRootBits(password);
  const plain = await tryDecrypt(root, block);
  if (plain === null) throw new WrongPasswordError();
  addSessionRoot(root);
  return plain;
}

async function tryDecrypt(
  root: Uint8Array,
  block: Pick<SecureBlock, "salt" | "iv" | "cipher">
): Promise<string | null> {
  try {
    const key = await deriveBlockKey(root, block.salt);
    const pt = await subtle().decrypt(
      { name: "AES-GCM", iv: asBuffer(b64ToBytes(block.iv)) },
      key,
      asBuffer(b64ToBytes(block.cipher))
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null; // GCM 校验失败 = 密码不对或密文被篡改
  }
}

/** 重新上锁：明文可能已被编辑，用缓存 root 重新加密（沿用原 salt，换新 iv） */
export async function relockBlock(root: Uint8Array, block: SecureBlock): Promise<SecureBlock> {
  const { salt, iv, cipher } = await encryptWithRoot(root, block.plain ?? "");
  const { plain: _plain, ...rest } = block;
  return { ...rest, salt, iv, cipher, updatedAt: Date.now() };
}

/** 取“最近使用”的会话 root（上锁时需要） */
export function latestSessionRoot(): Uint8Array | null {
  return sessionRoots[0] ?? null;
}
