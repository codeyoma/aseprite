// Curated FX recipes (#97): worked examples of the recipe format that read well at pixel scale, used by the
// pixel-fx skill as starting points and by the unit tests that exercise the whole FX workflow.
import type { Recipe } from "./recipe.js";

/**
 * A frost nova burst from a staff tip (anchor 'center'), built from three ideas:
 * - a clustered flash: a tight white core (a disc and a glow) with a few stars packed inside 3 px, gone by 0.1 s;
 * - directional shards: four streak emitters with trails, each aimed in a narrow cone (right and left along the
 *   thrust, two up-diagonals), the forward ones longer and faster, instead of a uniform ring of particles;
 * - asymmetric decay: the forward side lingers (longer shard life, frost vapour drifting forward) while the back
 *   side fades early; the light dies first and the ring eases out, so the burst thins from the back to the front.
 * Every particle's start + delay + spread + life stays inside the duration, so the one-shot ends empty.
 */
export const FROST_NOVA: Recipe = {
  name: "frost-nova", size: [112, 64], origin: [44, 32], duration: 0.6, fps: 30, seed: 7, anchor: "center",
  palette: ["#0e1a2e", "#1f4f8a", "#3f8fd0", "#9fdcff", "#ffffff"],
  phases: [
    { name: "flash", start: 0, end: 0.1,
      shapes: [{ type: "disc", radius: [5, 2], color: -1, alpha: [1, 0], ease: "out" }, { type: "glow", radius: 12, alpha: [0.9, 0] }],
      emitters: [{ kind: "star", count: 5, speed: [0, 10], life: [0.05, 0.1], radius: 3, color: -1 }],
      lights: [{ radius: 22, strength: 1.2, life: 0.12 }] },
    { name: "burst", start: 0, end: 0.3,
      rings: [{ radius: [3, 26], width: 1, color: "cool", alpha: [0.9, 0], ease: "out" }],
      emitters: [
        { kind: "streak", count: 7, angle: 0, spread: 18, speed: [130, 180], life: [0.22, 0.34], trail: 3, drag: 4 },
        { kind: "streak", count: 4, angle: 180, spread: 18, speed: [90, 130], life: [0.1, 0.16], trail: 2, drag: 4 },
        { kind: "streak", count: 4, angle: -40, spread: 14, speed: [100, 140], life: [0.15, 0.24], trail: 2, drag: 3 },
        { kind: "streak", count: 3, angle: -140, spread: 14, speed: [80, 110], life: [0.08, 0.14], trail: 2, drag: 4 },
      ] },
    { name: "decay", start: 0.12, end: 0.55,
      emitters: [
        { kind: "flake", count: 10, x: 10, radius: 8, angle: 0, spread: 60, speed: [10, 30], life: [0.2, 0.36], over: 0.06, gravity: 20, drag: 2 },
        { kind: "vapour", count: 6, x: 14, radius: 6, angle: 0, spread: 40, speed: [12, 24], life: [0.16, 0.28], over: 0.1, color: 2 },
        { kind: "flake", count: 4, x: -8, radius: 5, angle: 180, spread: 60, speed: [8, 16], life: [0.08, 0.14], gravity: 20 },
      ] },
  ],
};
