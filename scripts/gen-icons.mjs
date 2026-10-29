import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const GLYPH = [
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 1, 0, 1],
  [1, 1, 0, 1, 1],
  [0, 1, 0, 1, 0],
];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function insideRounded(x, y, size, radius) {
  const left = x < radius;
  const right = x >= size - radius;
  const top = y < radius;
  const bottom = y >= size - radius;
  if (!(left || right) || !(top || bottom)) return true;
  const cx = left ? radius : size - radius;
  const cy = top ? radius : size - radius;
  const dx = x + 0.5 - cx;
  const dy = y + 0.5 - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function makePng(size) {
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(size * stride);
  const radius = size * 0.22;
  const margin = Math.round(size * 0.24);
  const cell = (size - margin * 2) / 5;
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * stride + 1 + x * 4;
      const inside = insideRounded(x, y, size, radius);
      let r = 13, g = 148, b = 136, a = 255;
      if (!inside) {
        a = 0;
      } else {
        const gx = Math.floor((x - margin) / cell);
        const gy = Math.floor((y - margin) / cell);
        if (x >= margin && y >= margin && gx >= 0 && gx < 5 && gy >= 0 && gy < 5 && GLYPH[gy][gx]) {
          r = 255;
          g = 255;
          b = 255;
        }
      }
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(`public/icons/${size}.png`, makePng(size));
}
console.log('icons generated');
