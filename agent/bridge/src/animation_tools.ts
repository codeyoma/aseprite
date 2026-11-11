// Animation helpers as tools (#42): in-betweens for rigid parts along an
// arc, clean rotation, squash and stretch, smear frames. Each writes a
// layer's cels through the document; no new colors are made.
import * as z from "zod/v4";
import { along, ease, imageColors, smear, squashStretch, subpixelShift, transform, type Easing } from "./animation.js";
import { documentOf } from "./document.js";
import { failure, text, type Tool } from "./tool.js";
import { judgeWalk, limbMask, readLimb, type ContactReading, type LimbSelector, type WalkContract } from "./walk_check.js";

const limb = z.object({
  layer: z.string().optional().describe("The limb's part layer (name or id)."),
  colors: z.array(z.string()).optional().describe("Its colors (hex), alone or within the layer."),
  rows: z.tuple([z.number().int(), z.number().int()]).optional().describe("Rows [y0, y1] it is in (an arm above the hip, a leg below)."),
}).optional();

const sel = (l: any): LimbSelector | undefined => (l ? { layer: l.layer, colors: l.colors, rows: l.rows } : undefined);
const hasSel = (l?: LimbSelector) => !!l && (!!l.layer || !!l.colors?.length);
const selText = (l: LimbSelector) => [l.layer && `layer "${l.layer}"`, l.colors?.length && `colors ${l.colors.join(" ")}`, l.rows && `rows ${l.rows[0]}-${l.rows[1]}`].filter(Boolean).join(", ");

const moveSchema = z.object({
  dx: z.number().optional().describe("Pixels right."),
  dy: z.number().optional().describe("Pixels down."),
  angle: z.number().optional().describe("Degrees clockwise."),
  scale_x: z.number().min(0.1).max(4).optional(),
  scale_y: z.number().min(0.1).max(4).optional(),
  pivot_x: z.number().optional().describe("Rotation/scale pivot in sprite pixels (e.g. a shoulder). Default: canvas center."),
  pivot_y: z.number().optional(),
});

export const ANIMATION_TOOLS: Tool[] = [
  {
    name: "walk_check",
    title: "Walk limb check",
    description:
      "Check a side-view walk's arms against its legs on the two contact frames: the near arm must swing opposite the " +
      "near leg, and each must change sides between the contacts (rule:anim.walk.limbs). Name the near arm and near " +
      "leg once (part layers, or colors with rows); they are stored on the sprite, so later calls (and reviews) need no " +
      "arguments. Layers named like 'near arm' and 'near leg' are found without naming them. Reports ok, errors, or " +
      "unverifiable (a limb missing or hanging straight), with each limb's shoulder/hip and hand/foot positions.",
    input: z.object({
      tag: z.string().optional().describe("The walk's tag. Default 'walk'."),
      facing: z.enum(["right", "left"]).optional().describe("Default right."),
      contacts: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional()
        .describe("The two contact frames. Default the tag's first frame and the one halfway."),
      near_arm: limb,
      near_leg: limb,
    }),
    kind: "edit",
    label: () => "Check the walk's arms and legs",
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const info = await doc.info();
      let spec: Record<string, any> = {};
      try { spec = info.pixelSpec ? JSON.parse(info.pixelSpec) : {}; } catch { spec = {}; }
      const stored: Partial<WalkContract> = spec.walk ?? {};
      const tagName = input.tag ?? stored.tag ?? "walk";
      const tag = info.tags.find((t) => t.name.toLowerCase() === tagName.toLowerCase());
      if (!tag) return failure(`No tag "${tagName}": tag the walk's frames first, or pass tag.`);
      const n = tag.to - tag.from + 1;
      const named = (re: RegExp) => info.layers.find((l) => re.test(l.name))?.name;
      const contract: WalkContract = {
        tag: tag.name,
        facing: input.facing ?? stored.facing ?? "right",
        contacts: input.contacts ?? stored.contacts ?? [tag.from, tag.from + Math.floor(n / 2)],
        nearArm: sel(input.near_arm) ?? stored.nearArm ?? { layer: named(/near[ _-]?arm/i) },
        nearLeg: sel(input.near_leg) ?? stored.nearLeg ?? { layer: named(/near[ _-]?leg/i) },
      };
      if (!hasSel(contract.nearArm) || !hasSel(contract.nearLeg)) {
        return failure("Name the near arm and near leg: near_arm and near_leg as part layers, or as colors with rows " +
          "(the arm's rows above the hip, the leg's below), or name the part layers 'near arm' and 'near leg'.");
      }
      for (const f of contract.contacts) if (f < 1 || f > info.durations.length) return failure(`Frame ${f} doesn't exist.`);
      const readings: ContactReading[] = [];
      for (const frame of contract.contacts) {
        const read = async (l: LimbSelector) => {
          const img = await doc.pixels(l.layer, frame);
          return readLimb(limbMask(img, l), img.width, contract.facing);
        };
        readings.push({ frame, arm: await read(contract.nearArm), leg: await read(contract.nearLeg) });
      }
      const verdict = judgeWalk(readings);
      const changed = JSON.stringify(spec.walk) !== JSON.stringify(contract);
      if (changed) await doc.putImages([], { spec: JSON.stringify({ ...spec, walk: contract }), label: "Walk limbs" });
      const lim = (r: ContactReading["arm"]) => r.offset === undefined ? `${r.pixels} px, not measurable`
        : `root ${r.root![0]},${r.root![1]} tip ${r.tip![0]},${r.tip![1]}: ${r.offset > 0 ? "+" : ""}${r.offset} px (${Math.abs(r.offset) < 1 ? "straight" : r.offset > 0 ? "forward" : "back"})`;
      return {
        content: [text([
          `WALK CHECK: ${verdict.status}`,
          `Walk "${contract.tag}" facing ${contract.facing}, contacts ${contract.contacts.join(" and ")}; near arm: ${selText(contract.nearArm)}; near leg: ${selText(contract.nearLeg)}` +
            (changed ? " (stored on the sprite)." : "."),
          ...readings.map((r) => `frame ${r.frame}: near arm ${lim(r.arm)}; near leg ${lim(r.leg)}`),
          ...verdict.errors.map((e) => `error: ${e}`),
          ...verdict.unverifiable.map((u) => `unverifiable: ${u}`),
          verdict.status === "ok" ? "The arms swing opposite the legs." :
            verdict.status === "errors" ? "Redraw the near arm on the listed frames (its hand on the other side of the shoulder), then run walk_check again." :
            "Fix the selection (layer, colors, rows) or draw the limbs at the contacts with a clear swing, then run walk_check again.",
        ].join("\n"))],
        ...(verdict.status === "errors" ? { isError: true } : {}),
      };
    },
  },
  {
    name: "transform_layer",
    title: "In-between a part",
    description:
      "Animate a rigid part (a layer: an arm, a sword, a whole small sprite) from its drawing in from_frame through " +
      "to_frame: each frame gets the drawing moved/rotated/scaled a bit further along `move`, eased, optionally " +
      "along an arc bent upward by `arc` px. Rotation is RotSprite-style, so pixels stay clean and no new colors " +
      "appear. Frames must exist (add them with apply_timeline_text first). Overwrites the layer's cels after from_frame.",
    input: z.object({
      layer: z.string().describe("Layer name."),
      from_frame: z.number().int().min(1),
      to_frame: z.number().int().min(1),
      move: moveSchema.describe("The full change at to_frame."),
      arc: z.number().optional().describe("Bend the path upward by this many pixels at the middle."),
      easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]).optional().describe("Default ease-in-out."),
    }),
    kind: "edit",
    label: (a) => (a.layer ? `In-between ${a.layer}` : "In-between"),
    async run(input, aseprite) {
      if (input.to_frame <= input.from_frame) return failure("to_frame must come after from_frame.");
      const doc = documentOf(aseprite);
      if (input.to_frame > (await doc.info()).durations.length) return failure("to_frame is past the last frame; add frames first.");
      const base = await doc.pixels(input.layer, input.from_frame);
      const m = input.move;
      const to = { dx: m.dx, dy: m.dy, angle: m.angle, sx: m.scale_x, sy: m.scale_y, px: m.pivot_x, py: m.pivot_y };
      const n = input.to_frame - input.from_frame;
      // Every frame in one write (#101): one transaction, one undo step, nothing half done.
      const items = [];
      for (let f = input.from_frame + 1; f <= input.to_frame; f++) {
        const t = (f - input.from_frame) / n;
        items.push({ image: transform(base, along(to, t, input.arc ?? 0, (input.easing ?? "ease-in-out") as Easing)), layer: input.layer, frame: f });
      }
      await doc.putImages(items, { label: `In-between ${input.layer}` });
      return { content: [text(`Animated ${input.layer} over frames ${input.from_frame + 1}-${input.to_frame} (${n} steps, ${input.easing ?? "ease-in-out"}${input.arc ? `, arc ${input.arc}px` : ""}).`)] };
    },
  },
  {
    name: "rotate_layer",
    title: "Rotate cleanly",
    description: "Rotate a layer's drawing in some frames by an angle around a pivot, RotSprite-style (clean edges, no new colors).",
    input: z.object({
      layer: z.string(),
      frames: z.array(z.number().int().min(1)).min(1),
      angle: z.number().describe("Degrees clockwise."),
      pivot_x: z.number().optional(),
      pivot_y: z.number().optional(),
    }),
    kind: "edit",
    label: (a) => `Rotate ${a.layer ?? ""} ${a.angle ?? ""}°`.trim(),
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      // Each frame once, all in one write (#101): one undo step; a frame listed twice is rotated once.
      const frames = [...new Set(input.frames as number[])];
      const items = [];
      for (const f of frames) {
        const img = await doc.pixels(input.layer, f);
        items.push({ image: transform(img, { angle: input.angle, px: input.pivot_x, py: input.pivot_y }), layer: input.layer, frame: f });
      }
      await doc.putImages(items, { label: `Rotate ${input.layer}` });
      return { content: [text(`Rotated ${input.layer} by ${input.angle}° in ${frames.length} frame(s).`)] };
    },
  },
  {
    name: "squash_stretch",
    title: "Squash and stretch",
    description: "Squash (amount < 0, e.g. -0.2 on landing) or stretch (> 0, e.g. 0.2 on take-off) a layer's drawing in a frame, keeping its area and its feet on the ground.",
    input: z.object({ layer: z.string(), frame: z.number().int().min(1), amount: z.number().min(-0.6).max(0.6) }),
    kind: "edit",
    label: (a) => ((a.amount ?? 0) < 0 ? "Squash" : "Stretch"),
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const img = await doc.pixels(input.layer, input.frame);
      await doc.putImage(squashStretch(img, input.amount), { layer: input.layer, frame: input.frame, label: input.amount < 0 ? "Squash" : "Stretch" });
      return { content: [text(`${input.amount < 0 ? "Squashed" : "Stretched"} ${input.layer} in frame ${input.frame} by ${Math.abs(input.amount * 100).toFixed(0)}%.`)] };
    },
  },
  {
    name: "smear_frame",
    title: "Smear frame",
    description:
      "Turn a frame into a smear: the layer's drawing at to_frame swept back along the path from from_frame, so a " +
      "fast move (a swing, a dash) reads in one frame. Writes into `frame` (usually between the two).",
    input: z.object({
      layer: z.string(),
      frame: z.number().int().min(1),
      from_frame: z.number().int().min(1),
      to_frame: z.number().int().min(1),
      steps: z.number().int().min(2).max(16).optional(),
    }),
    kind: "edit",
    label: () => "Smear frame",
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const a = await doc.pixels(input.layer, input.from_frame);
      const b = await doc.pixels(input.layer, input.to_frame);
      await doc.putImage(smear(a, b, input.steps), { layer: input.layer, frame: input.frame, label: "Smear" });
      return { content: [text(`Frame ${input.frame} of ${input.layer} is now a smear from frame ${input.from_frame} to ${input.to_frame}.`)] };
    },
  },
  {
    name: "subpixel_move",
    title: "Sub-pixel motion",
    description:
      "Move a layer's drawing by less than a pixel per frame without it jumping: each frame from from_frame+1 to " +
      "to_frame shifts it a fraction further toward (dx, dy) (e.g. dx 1 over 4 frames = quarter-pixel steps), with " +
      "edge pixels changing shade (colors from the sprite palette and the drawing) instead of moving. For small " +
      "sprites: breathing, bobbing, a slow drift, an eye or highlight sliding. Frames must exist. Overwrites the layer's cels after from_frame.",
    input: z.object({
      layer: z.string(),
      from_frame: z.number().int().min(1),
      to_frame: z.number().int().min(1),
      dx: z.number().min(-4).max(4).optional().describe("Total pixels right at to_frame (fractions welcome)."),
      dy: z.number().min(-4).max(4).optional().describe("Total pixels down at to_frame."),
      easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]).optional().describe("Default linear."),
    }),
    kind: "edit",
    label: (a) => (a.layer ? `Sub-pixel move ${a.layer}` : "Sub-pixel move"),
    async run(input, aseprite) {
      if (input.to_frame <= input.from_frame) return failure("to_frame must come after from_frame.");
      if (!input.dx && !input.dy) return failure("Give dx or dy.");
      const doc = documentOf(aseprite);
      const info = await doc.info();
      if (input.to_frame > info.durations.length) return failure("to_frame is past the last frame; add frames first.");
      const base = await doc.pixels(input.layer, input.from_frame);
      const colors = [...imageColors(base), ...info.palette];
      const n = input.to_frame - input.from_frame;
      const items = [];
      for (let f = input.from_frame + 1; f <= input.to_frame; f++) {
        const t = ease((f - input.from_frame) / n, (input.easing ?? "linear") as Easing);
        items.push({ image: subpixelShift(base, (input.dx ?? 0) * t, (input.dy ?? 0) * t, colors), layer: input.layer, frame: f });
      }
      await doc.putImages(items, { label: `Sub-pixel move ${input.layer}` });
      return { content: [text(`Moved ${input.layer} by (${input.dx ?? 0}, ${input.dy ?? 0}) px over frames ${input.from_frame + 1}-${input.to_frame} in sub-pixel steps of ${(Math.hypot(input.dx ?? 0, input.dy ?? 0) / n).toFixed(2)} px.`)] };
    },
  },
];
