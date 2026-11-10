import { PNG } from "pngjs";

export type Background = "checker" | "transparent" | string;

function parseHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Invalid background color: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Encode raw RGBA pixels from Aseprite as a PNG, upscaled with
 * nearest-neighbor so single pixels stay crisp and visible.
 */
export function encodeSnapshot(
  rgba: Buffer,
  width: number,
  height: number,
  scale: number,
  background: Background,
): Buffer {
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(`Snapshot size mismatch: got ${rgba.length} bytes, expected ${expected}`);
  }

  const outW = width * scale;
  const outH = height * scale;
  const png = new PNG({ width: outW, height: outH });
  const out = png.data;

  const solid = background !== "checker" && background !== "transparent" ? parseHex(background) : null;
  // Checker squares follow sprite pixels (at least 4 output pixels wide).
  const cell = Math.max(4, scale);

  for (let y = 0; y < outH; y++) {
    const sy = Math.floor(y / scale);
    for (let x = 0; x < outW; x++) {
      const sx = Math.floor(x / scale);
      const si = (sy * width + sx) * 4;
      const di = (y * outW + x) * 4;
      const r = rgba[si], g = rgba[si + 1], b = rgba[si + 2], a = rgba[si + 3];

      if (background === "transparent") {
        out[di] = r; out[di + 1] = g; out[di + 2] = b; out[di + 3] = a;
        continue;
      }

      let br: number, bg: number, bb: number;
      if (solid) {
        [br, bg, bb] = solid;
      } else {
        const light = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0;
        br = bg = bb = light ? 204 : 153;
      }
      const t = a / 255;
      out[di] = Math.round(r * t + br * (1 - t));
      out[di + 1] = Math.round(g * t + bg * (1 - t));
      out[di + 2] = Math.round(b * t + bb * (1 - t));
      out[di + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}
