// Animation helpers as tools (#42): in-betweens for rigid parts along an
// arc, clean rotation, squash and stretch, smear frames. Each writes a
// layer's cels through the document; no new colors are made.
import * as z from "zod/v4";
import { along, ease, imageColors, smear, squashStretch, subpixelShift, transform, type Easing } from "./animation.js";
import { documentOf } from "./document.js";
import { failure, text, type Tool } from "./tool.js";
import { KINDS, MotionStore, defaultContacts, defaultKeys, deriveJoints, describeClip, describeRig, guessParent, kindOf, selText, type Rig, type RigPart } from "./motion_clip.js";
import { measureWalk, type ContactReading, type LimbSelector } from "./walk_check.js";

const limb = z.object({
  layer: z.string().optional().describe("The limb's part layer (name or id)."),
  colors: z.array(z.string()).optional().describe("Its colors (hex), alone or within the layer."),
  rows: z.tuple([z.number().int(), z.number().int()]).optional().describe("Rows [y0, y1] it is in (an arm above the hip, a leg below)."),
}).optional();

const sel = (l: any): LimbSelector | undefined => (l ? { layer: l.layer, colors: l.colors, rows: l.rows } : undefined);

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
    name: "motion_clip",
    title: "Motion clip",
    description:
      "The animation's plan as data on the sprite (#109), one clip per tag: kind, facing, loop, key frames with their " +
      "poses, contacts, root travel and followers (hair or a cape that lag), plus a rig per character (part layers, " +
      "parents, joints). 'plan' writes the clip and starts the keys stage: until 'advance', an edit may change only the " +
      "tag's key frames (any other edit is undone, execute_lua included). 'advance' moves on to the in-betweens once " +
      "every key has art, keys differ from the key before (unless marked hold) and, for a walk or run, walk_check's " +
      "contacts say ok. 'done' needs every frame of the tag drawn, no frame repeating the one before, and for a walk " +
      "the whole walk_check ok. 'rig' stores a character's parts (joints you give, or suggested from the pixels at " +
      "the base frame and marked derived: check them). No action: every clip and rig.",
    input: z.object({
      action: z.enum(["show", "plan", "advance", "done", "rig", "remove"]).optional(),
      tag: z.string().optional().describe("The clip's tag. Default: the clip in progress, else 'walk'."),
      kind: z.enum(KINDS).optional().describe("Default from the tag's name (walk, run, idle; else action)."),
      facing: z.enum(["right", "left"]).optional(),
      loop: z.boolean().optional().describe("Default: true for walk, run, idle and cycle."),
      keys: z.array(z.union([z.number().int().min(1), z.object({
        frame: z.number().int().min(1), pose: z.string().optional(), hold: z.boolean().optional(),
      })])).optional().describe("Key frames (sprite frame numbers), or {frame, pose, hold}. Default: a 6-frame walk's 1, 3, 4, 6 of the tag (contacts and passings); otherwise its first and middle frames."),
      contacts: z.array(z.number().int().min(1)).optional().describe("Frames where a planted foot carries the weight (sprite frames). Default for a walk: the tag's first and halfway frames."),
      root_travel: z.number().optional().describe("Pixels the body travels per loop (in place: how far a planted foot slides back)."),
      followers: z.array(z.object({ layer: z.string(), follows: z.string(), lag: z.number().min(0).max(4) })).optional(),
      character: z.string().optional().describe("The character (its rig) the clip animates."),
      staged: z.boolean().optional().describe("plan: start the keys stage (default true); false stores the clip without a gate."),
      base_frame: z.number().int().min(1).optional().describe("rig: the frame its joints are measured on. Default the character's first key, else 1."),
      parts: z.array(z.object({
        layer: z.string(), parent: z.string().optional(),
        joint: z.tuple([z.number(), z.number()]).optional(), end: z.tuple([z.number(), z.number()]).optional(), rigid: z.boolean().optional(),
      })).optional().describe("rig: the parts, root first. Missing parents are guessed from names (arms off the torso, a hand off its arm); missing joints are suggested from the pixels."),
    }),
    kind: "edit",
    label: (a) => `Motion clip${a.action && a.action !== "show" ? `: ${a.action}` : ""}`,
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      let store: MotionStore;
      try { store = await MotionStore.load(doc); } catch (e) { return failure((e as Error).message); }
      const action = input.action ?? "show";
      if (action === "show") {
        const { views, orphans } = store.views();
        const rigs = Object.entries(store.motion.rigs);
        if (!views.length && !rigs.length) return { content: [text("No motion clip or rig on this sprite. Plan one with action 'plan'.")] };
        return { content: [text([...views.map(describeClip), ...rigs.map(([n, r]) => describeRig(n, r)),
          ...(orphans.length ? [`Clips whose tag is gone: ${orphans.join(", ")} (remove them, or tag the frames again).`] : [])].join("\n"))] };
      }
      if (action === "rig") {
        const character = input.character ?? Object.keys(store.motion.rigs)[0] ?? "Character";
        const known = store.rig(character);
        const given: RigPart[] = input.parts ?? known?.parts.map((p) => ({ ...p })) ?? [];
        if (!given.length) return failure("Give the rig's parts (layer names, root first).");
        const names: string[] = given.map((p) => p.layer);
        const missing = names.filter((n: string) => !store.info.layers.some((l) => l.name === n && !l.group));
        if (missing.length) return failure(`No image layer ${missing.map((m: string) => `"${m}"`).join(", ")}.`);
        const firstKey = store.views().views.find((v) => v.clip.character === character)?.keys[0];
        const base = input.base_frame ?? known?.base ?? firstKey ?? 1;
        if (base > store.info.durations.length) return failure(`Frame ${base} doesn't exist.`);
        const parts: RigPart[] = given.map((p) => ({
          ...p, parent: p.parent ?? guessParent(p.layer, names),
          ...(p.joint || p.end ? { source: "set" } : {}),
        }));
        const bad = parts.find((p) => p.parent && !names.includes(p.parent));
        if (bad) return failure(`${bad.layer}'s parent "${bad.parent}" is not one of the parts.`);
        const rig: Rig = { base, parts: await deriveJoints(doc, parts, base), ...(known?.source ? { source: known.source } : {}) };
        store.setRig(character, rig);
        await store.save(`Rig ${character}`);
        const derived = rig.parts.some((p) => p.source === "derived");
        return { content: [text(describeRig(character, rig) + (derived ? "\nJoints marked [derived] are suggestions from the pixels: " +
          "check them on a snapshot of the base frame and set the wrong ones (joint at the shoulder, hip or grip; end at the hand, foot or tip)." : ""))] };
      }
      const tagName = input.tag ?? store.active()?.name ?? "walk";
      const tag = store.tag(tagName);
      if (action === "remove") {
        return store.removeClip(tagName) && (await store.save(`Remove clip ${tagName}`))
          ? { content: [text(`Removed the clip "${tagName}".`)] } : failure(`No clip "${tagName}".`);
      }
      if (!tag) return failure(`No tag "${tagName}": make the tag and its frames first (apply_timeline_text).`);
      const n = tag.to - tag.from + 1;
      if (action === "plan") {
        const old = store.view(tag.name)?.clip;
        const kind = input.kind ?? old?.kind ?? kindOf(tag.name);
        const rel = (f: number) => f - tag.from + 1;
        type KeyIn = { frame: number; pose?: string; hold?: boolean };
        const keyList: KeyIn[] | undefined = input.keys?.map((k: number | KeyIn) => (typeof k === "number" ? { frame: k } : k));
        if (keyList?.some((k) => k.frame < tag.from || k.frame > tag.to)) return failure(`Keys must be frames of "${tag.name}" (${tag.from}-${tag.to}).`);
        if (input.contacts?.some((f: number) => f < tag.from || f > tag.to)) return failure(`Contacts must be frames of "${tag.name}" (${tag.from}-${tag.to}).`);
        const keys = keyList
          ? [...keyList].sort((a, b) => a.frame - b.frame).map((k) => ({ at: rel(k.frame), ...(k.pose ? { pose: k.pose } : {}), ...(k.hold ? { hold: true } : {}) }))
          : old && !input.kind ? old.keys : defaultKeys(kind, n).map((at) => ({ at }));
        const contacts = input.contacts?.map(rel) ?? old?.contacts ?? defaultContacts(kind, n);
        const v = store.setClip(tag, {
          ...(old ?? {}),
          kind, facing: input.facing ?? old?.facing ?? "right", loop: input.loop ?? old?.loop ?? kind !== "action", keys,
          ...(contacts ? { contacts } : {}),
          ...(input.root_travel !== undefined ? { rootTravel: input.root_travel } : {}),
          ...(input.followers ? { followers: input.followers } : {}),
          ...(input.character ? { character: input.character } : {}),
          stage: input.staged === false ? "none" : "keys",
        });
        await store.save(`Motion clip: plan ${tag.name}`);
        const rest = v.frames.filter((f) => !v.keys.includes(f));
        const walk = kind === "walk" || kind === "run";
        return { content: [text(describeClip(v) + (v.clip.stage === "keys"
          ? `\nDraw the key frames ${v.keys.join(", ")} now. Edits to frames ${rest.join(", ") || "(none)"} are undone until motion_clip advance` +
            `${walk ? " (walk_check must say ok on the contacts first)" : ""}.` : ""))] };
      }
      const v = store.view(tag.name);
      if (!v) return failure(`No clip for "${tag.name}": plan one first (motion_clip action 'plan').`);
      const images = new Map<number, string>();
      const art = async (f: number) => {
        if (!images.has(f)) {
          const img = await doc.pixels(undefined, f);
          let opaque = 0;
          for (let i = 3; i < img.data.length; i += 4) if (img.data[i] >= 128) opaque++;
          images.set(f, opaque ? Buffer.from(img.data).toString("base64") : "");
        }
        return images.get(f)!;
      };
      const walk = v.clip.kind === "walk" || v.clip.kind === "run";
      const walkProblems = async (contactsOnly: boolean): Promise<string | undefined> => {
        if (!walk) return undefined;
        try {
          const m = await measureWalk(doc, { tag: v.name }, store.walkContract(v.name), { contactsOnly });
          if (m.changed && store.setWalkContract(m.contract)) await store.save("Walk limbs");
          if (m.verdict.status !== "ok") return `walk_check says ${m.verdict.status}:\n${[...m.verdict.errors, ...m.verdict.unverifiable].join("\n")}`;
        } catch (e) {
          return `walk_check can't run yet: ${(e as Error).message}`;
        }
        return undefined;
      };
      if (action === "advance") {
        if (v.clip.stage !== "keys") return failure(`The clip "${v.name}" is in stage "${v.clip.stage}", not "keys".`);
        const empty: number[] = [];
        for (const k of v.keys) if (!(await art(k))) empty.push(k);
        if (empty.length) return failure(`Key frame${empty.length > 1 ? "s" : ""} ${empty.join(", ")} ${empty.length > 1 ? "have" : "has"} no art yet: draw every key first.`);
        const same: number[] = [];
        for (let i = 1; i < v.keys.length; i++) if (!v.clip.keys[i].hold && (await art(v.keys[i])) === (await art(v.keys[i - 1]))) same.push(v.keys[i]);
        if (same.length) return failure(`Key frame${same.length > 1 ? "s" : ""} ${same.join(", ")} repeat${same.length > 1 ? "" : "s"} the key before: draw a different pose, or plan it with hold: true.`);
        const w = await walkProblems(true);
        if (w) return failure(`Not yet: ${w}\nFix the keys, then advance again.`);
        store.setClip(v.tag, { ...v.clip, stage: "inbetweens" });
        await store.save("Motion clip: in-betweens");
        return { content: [text(`Clip "${v.name}" is in stage "inbetweens": make each in-between from the keys on both sides ` +
          `(snapshot view 'onion'), then${walk ? " walk_check and motion_review again, and" : ""} motion_clip done.`)] };
      }
      // done
      if (v.clip.stage === "keys") return failure(`The clip "${v.name}" is still in the keys stage: advance first.`);
      const empty: number[] = [];
      for (const f of v.frames) if (!(await art(f))) empty.push(f);
      if (empty.length) return failure(`Not done: frame${empty.length > 1 ? "s" : ""} ${empty.join(", ")} of "${v.name}" ${empty.length > 1 ? "have" : "has"} no art.`);
      const repeats: number[] = [];
      for (let i = 1; i < v.frames.length; i++) if ((await art(v.frames[i])) === (await art(v.frames[i - 1]))) repeats.push(v.frames[i]);
      if (repeats.length) return failure(`Not done: frame${repeats.length > 1 ? "s" : ""} ${repeats.join(", ")} repeat${repeats.length > 1 ? "" : "s"} the frame before. A held pose is one frame with a longer duration.`);
      const w = await walkProblems(false);
      if (w) return failure(`Not done: ${w}`);
      store.setClip(v.tag, { ...v.clip, stage: "done" });
      await store.save("Motion clip: done");
      return { content: [text(`Clip "${v.name}" is done.`)] };
    },
  },
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
      let m;
      try {
        const store = await MotionStore.load(doc);
        m = await measureWalk(doc, { tag: input.tag, facing: input.facing, contacts: input.contacts, nearArm: sel(input.near_arm), nearLeg: sel(input.near_leg) },
          store.walkContract(input.tag));
        if (m.changed && store.setWalkContract(m.contract)) await store.save("Walk limbs");
      } catch (e) {
        return failure((e as Error).message);
      }
      const { contract, readings, verdict, changed } = m;
      const lim = (r: ContactReading["arm"]) => r.offset === undefined ? `${r.pixels} px, not measurable`
        : `root ${r.root![0]},${r.root![1]} tip ${r.tip![0]},${r.tip![1]}: ${r.offset > 0 ? "+" : ""}${r.offset} px (${Math.abs(r.offset) < 1 ? "straight" : r.offset > 0 ? "forward" : "back"})`;
      return {
        content: [text([
          `WALK CHECK: ${verdict.status}`,
          `Walk "${contract.tag}" facing ${contract.facing}, contacts ${contract.contacts.join(" and ")}; near arm: ${selText(contract.nearArm)}; near leg: ${selText(contract.nearLeg)}` +
            (changed ? " (stored on the sprite)." : "."),
          ...readings.map((r) => `frame ${r.frame}: near arm ${lim(r.arm)}; near leg ${lim(r.leg)}` +
            (r.legLight ? `; lightness near leg ${r.legLight.near}, far leg ${r.legLight.far}` : "")),
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
