// 生成 Tauri 所需的应用图标（无第三方依赖：手写 PNG 编码 + ICO 封装）。
// 图形：奶油色圆角方块 + 暖炭灰小鱼（鱼记得）。
// 用法: node scripts/gen-icons.mjs

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "src-tauri", "icons");
mkdirSync(outDir, { recursive: true });

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 每行前置 filter byte 0
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy ? null : 0;
    for (let x = 0; x < width * 4; x++) {
      raw[y * (width * 4 + 1) + 1 + x] = rgba[y * width * 4 + x];
    }
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 绘图（SDF + 超采样抗锯齿） ----------
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

function sdRing(px, py, cx, cy, r, halfW) {
  return Math.hypot(px - cx, py - cy) - r; // |dist - r| 由调用方处理
}

function drawIcon(S) {
  const rgba = Buffer.alloc(S * S * 4);
  const NOTE = [240, 219, 140]; // #F0DB8C 奶油黄
  const FISH = [87, 83, 77]; // #57534D 暖炭灰
  const SS = 4; // 4x4 超采样（硬边缘 + 高倍采样 = 平滑轮廓）

  const sample = (x, y) => {
    // 便签主体（圆角矩形是真 SDF，可平滑）
    const note = clamp01(0.5 - sdRoundRect(x, y, S / 2, S / 2, S * 0.40, S * 0.40, S * 0.14));
    if (note === 0) return [0, 0, 0, 0];
    // 鱼（硬覆盖判定，靠 4x4 总超采样获得平滑边缘）
    const inBody = Math.hypot((x - S * 0.44) / (S * 0.26), (y - S * 0.53) / (S * 0.16)) <= 1;
    const inTail = (Math.abs(x - S * 0.78) + Math.abs(y - S * 0.53)) / S <= 0.13;
    const inEye = Math.hypot(x - S * 0.315, y - S * 0.49) <= S * 0.035;
    if (inEye && inBody) return [NOTE[0], NOTE[1], NOTE[2], Math.round(255 * note)];
    if (inBody || inTail) return [FISH[0], FISH[1], FISH[2], Math.round(255 * note)];
    return [NOTE[0], NOTE[1], NOTE[2], Math.round(255 * note)];
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      const n = SS * SS;
      const i = (y * S + x) * 4;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(b / n);
      rgba[i + 3] = Math.round(a / n);
    }
  }
  return rgba;
}

/** 渲染 2x 再盒式降采样，得到平滑的 target 尺寸图 */
function renderDownsampled(target) {
  const big = 2 * target;
  const raw = drawIcon(big);
  const out = Buffer.alloc(target * target * 4);
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            sum += raw[((y * 2 + dy) * big + (x * 2 + dx)) * 4 + c];
          }
        }
        out[(y * target + x) * 4 + c] = Math.round(sum / 4);
      }
    }
  }
  return out;
}

const png256 = encodePNG(renderDownsampled(256), 256, 256);
writeFileSync(join(outDir, "32x32.png"), encodePNG(renderDownsampled(32), 32, 32));
writeFileSync(join(outDir, "128x128.png"), encodePNG(renderDownsampled(128), 128, 128));
writeFileSync(join(outDir, "128x128@2x.png"), png256);
writeFileSync(join(outDir, "icon.png"), encodePNG(renderDownsampled(512), 512, 512));

// ICO：256px PNG 直接嵌入
const ico = Buffer.alloc(6 + 16);
ico.writeUInt16LE(0, 0); // reserved
ico.writeUInt16LE(1, 2); // type: icon
ico.writeUInt16LE(1, 4); // count
const entry = ico.subarray(6, 22);
entry[0] = 0; // width 256 → 0
entry[1] = 0; // height 256 → 0
entry[2] = 0; // palette
entry[3] = 0; // reserved
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(png256.length, 8);
entry.writeUInt32LE(22, 12); // data offset
writeFileSync(join(outDir, "icon.ico"), Buffer.concat([ico, png256]));

console.log("icons written to", outDir);
