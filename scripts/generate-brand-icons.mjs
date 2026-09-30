import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";

const iconSizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = iconSizes.map((size) => ({ size, png: encodePng(size, renderIcon(size)) }));
const output = path.join(process.cwd(), "resources", "branding");
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "evren-codex-bridge.png"), pngs.at(-1).png);
await writeFile(path.join(output, "evren-codex-bridge.ico"), encodeIco(pngs));

function renderIcon(size) {
  const scale = 4;
  const canvasSize = size * scale;
  const pixels = Buffer.alloc(canvasSize * canvasSize * 4);
  const unit = canvasSize / 256;
  const fillPixel = (x, y, color) => {
    if (x < 0 || y < 0 || x >= canvasSize || y >= canvasSize) return;
    const index = (y * canvasSize + x) * 4;
    for (let channel = 0; channel < 4; channel += 1) pixels[index + channel] = color[channel];
  };
  for (let y = 0; y < canvasSize; y += 1) {
    for (let x = 0; x < canvasSize; x += 1) {
      if (!insideRoundedSquare(x, y, 13 * unit, 13 * unit, 230 * unit, 230 * unit, 48 * unit)) continue;
      const highlight = Math.max(0, 1 - Math.hypot(x - 184 * unit, y - 48 * unit) / (220 * unit));
      fillPixel(x, y, [Math.round(5 + highlight * 9), Math.round(16 + highlight * 22), Math.round(29 + highlight * 38), 255]);
    }
  }

  drawGlow(pixels, canvasSize, 172 * unit, 77 * unit, 78 * unit, [26, 143, 232], 0.12);
  drawPolygon(pixels, canvasSize, points([[67, 57], [103, 57], [103, 199], [67, 199]], unit), [222, 246, 255, 255]);
  drawPolygon(pixels, canvasSize, points([[92, 57], [190, 57], [178, 89], [92, 89]], unit), [80, 193, 255, 255]);
  drawPolygon(pixels, canvasSize, points([[92, 112], [169, 112], [158, 143], [92, 143]], unit), [53, 158, 235, 255]);
  drawPolygon(pixels, canvasSize, points([[92, 167], [190, 167], [178, 199], [92, 199]], unit), [105, 112, 242, 255]);
  return downsample(pixels, canvasSize, size);
}

function points(values, unit) { return values.map(([x, y]) => [x * unit, y * unit]); }

function drawGlow(pixels, size, centerX, centerY, radius, color, opacity) {
  const left = Math.max(0, Math.floor(centerX - radius));
  const right = Math.min(size, Math.ceil(centerX + radius));
  const top = Math.max(0, Math.floor(centerY - radius));
  const bottom = Math.min(size, Math.ceil(centerY + radius));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const strength = Math.max(0, 1 - Math.hypot(x - centerX, y - centerY) / radius) * opacity;
      if (!strength) continue;
      const index = (y * size + x) * 4;
      if (!pixels[index + 3]) continue;
      for (let channel = 0; channel < 3; channel += 1) pixels[index + channel] = Math.round(pixels[index + channel] * (1 - strength) + color[channel] * strength);
    }
  }
}

function drawPolygon(pixels, size, polygon, color) {
  const minX = Math.max(0, Math.floor(Math.min(...polygon.map(([x]) => x))));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(...polygon.map(([x]) => x))));
  const minY = Math.max(0, Math.floor(Math.min(...polygon.map(([, y]) => y))));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(...polygon.map(([, y]) => y))));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (!insidePolygon(x + 0.5, y + 0.5, polygon)) continue;
      const index = (y * size + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) pixels[index + channel] = color[channel];
    }
  }
}

function insidePolygon(x, y, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const [xi, yi] = polygon[index];
    const [xj, yj] = polygon[previous];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function downsample(source, sourceSize, targetSize) {
  const factor = sourceSize / targetSize;
  const output = Buffer.alloc(targetSize * targetSize * 4);
  for (let y = 0; y < targetSize; y += 1) {
    for (let x = 0; x < targetSize; x += 1) {
      const totals = [0, 0, 0, 0];
      for (let sy = 0; sy < factor; sy += 1) for (let sx = 0; sx < factor; sx += 1) {
        const sourceIndex = ((y * factor + sy) * sourceSize + x * factor + sx) * 4;
        for (let channel = 0; channel < 4; channel += 1) totals[channel] += source[sourceIndex + channel];
      }
      const targetIndex = (y * targetSize + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) output[targetIndex + channel] = Math.round(totals[channel] / (factor * factor));
    }
  }
  return output;
}

function encodePng(width, rgba) {
  const scanlines = Buffer.alloc((width * 4 + 1) * width);
  for (let y = 0; y < width; y += 1) rgba.copy(scanlines, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr(width, width)),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(images) {
  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = headerSize;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

function insideRoundedSquare(x, y, left, top, width, height, radius) {
  const nearestX = Math.max(left + radius, Math.min(x, left + width - radius));
  const nearestY = Math.max(top + radius, Math.min(y, top + height - radius));
  return (x - nearestX) ** 2 + (y - nearestY) ** 2 <= radius ** 2;
}

function ihdr(width, height) {
  const value = Buffer.alloc(13);
  value.writeUInt32BE(width, 0);
  value.writeUInt32BE(height, 4);
  value[8] = 8;
  value[9] = 6;
  return value;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const value = Buffer.alloc(data.length + 12);
  value.writeUInt32BE(data.length, 0);
  name.copy(value, 4);
  data.copy(value, 8);
  value.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return value;
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
