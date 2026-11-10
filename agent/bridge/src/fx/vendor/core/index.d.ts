// Types for the part of the vendored pixelfx core (index.js) that the TypeScript facade (../../index.ts) uses.
// Written for aseprite-agent; not part of pixelfx. The rest of the core is plain JS, used by effects only.

/** A frame: w x h pixels with its top-left at (ox, oy). Colors are 32-bit ABGR numbers (RGBA bytes in memory). */
export interface Frame {
  w: number;
  h: number;
  ox: number;
  oy: number;
  /** Opaque (or blended) color pixels. */
  color: Uint32Array;
  /** Additive light, composited over the color. */
  light: Uint32Array;
}

/** What an effect module exports (pixelfx's effect shape). */
export interface EffectMeta {
  name?: string;
  desc?: string;
  tags?: string[];
  /** Canvas [width, height] in pixels. */
  size: [number, number];
  /** Where the effect's origin sits on that canvas. */
  origin: [number, number];
  /** Seconds. */
  duration?: number;
  loop?: boolean;
  fps?: number;
  bg?: string;
  /** Needs a character (status effects): not supported by this vendored copy. */
  actor?: number;
  options?: Record<string, unknown>;
}

export interface EffectModule {
  meta: EffectMeta;
  /** A stateful effect: an instance that is stepped with update(dt) and drawn. */
  create?: (options: Record<string, unknown>) => unknown;
  /** A closed-form effect: drawn from time alone. */
  draw?: (painter: unknown, t: number, options: Record<string, unknown>) => void;
  drawBack?: (painter: unknown, t: number, options: Record<string, unknown>) => void;
}

/** A live effect instance. */
export interface FxInstance {
  readonly meta: EffectMeta;
  readonly options: Record<string, unknown>;
  readonly t: number;
  update(dt: number): void;
  draw(frame: Frame, layer?: "back" | "front"): void;
  stop(): void;
  done(): boolean;
}

export function createFrame(w: number, h: number, ox?: number, oy?: number): Frame;
export function clearFrame(f: Frame): Frame;
export function createFx(mod: EffectModule, options?: Record<string, unknown>): FxInstance;
export function composite<T extends Uint8Array | Uint8ClampedArray>(
  f: Frame,
  out: T,
  bg?: number | Uint32Array | null,
  lightK?: number,
): T;
