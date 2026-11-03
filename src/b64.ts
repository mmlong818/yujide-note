// UTF-8 安全的 base64 编解码（btoa 直接处理中文会产生乱码/异常）

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8ToB64(text: string): string {
  return bytesToB64(new TextEncoder().encode(text));
}

export function b64ToUtf8(b64: string): string {
  return new TextDecoder().decode(b64ToBytes(b64));
}

/**
 * 把 Uint8Array 转成 WebCrypto 需要的 ArrayBuffer。
 * 我们的字节数组要么整段持有 buffer，要么做一次切片拷贝。
 */
export function asBuffer(b: Uint8Array): ArrayBuffer {
  if (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength) {
    return b.buffer as ArrayBuffer;
  }
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}
