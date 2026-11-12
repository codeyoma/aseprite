// Animation helpers as tools (#42): in-betweens for rigid parts along an
// arc, clean rotation, squash and stretch, smear frames. Each writes a
// layer's cels through the document; no new colors are made.
import * as z from "zod/v4";
import { along, bounds, ease, imageColors, subpixelShift, transform, type Easing, type Transform } from "./animation.js";
import { documentOf } from "./document.js";
import { failure, text, type Tool } from "./tool.js";
import type { Rgba } from "./image.js";
import { inbetweens, solveParts, type PartKeys } from "./inbetween.js";
import { describeReport, trackClip } from "./motion_analysis.js";
import { KINDS, MotionStore, clipParts, viewOf, defaultContacts, defaultKeys, deriveJoints, describeClip, describeRig, guessParent, kindOf, selText, type Rig, type RigPart } from "./motion_clip.js";
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
  squash: z.number().min(-0.6).max(0.6).optional().describe("Squash (< 0, e.g. -0.2 on landing) or stretch (> 0, take-off), area kept, on the ground line unless a pivot is given (rule:anim.squash)."),
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
          ? [...keyList].sort((a, b) => a.frame - b.frame).map((k) => {
            // A key planned again keeps what an import put on it (its landmarks, #112).
            const was = old?.keys.find((o) => o.at === rel(k.frame));
            return { ...(was?.landmarks ? { landmarks: was.landmarks } : {}), at: rel(k.frame), ...(k.pose ? { pose: k.pose } : {}), ...(k.hold ? { hold: true } : {}) };
          })
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
      const report = await trackClip(doc, v, clipParts(store, v));
      const errors = report.findings.filter((f) => f.severity === "error");
      if (errors.length) return failure(`Not done: motion_check finds ${errors.map((e) => e.message).join("\n")}\n\n${describeReport(v.name, report)}`);
      store.setClip(v.tag, { ...v.clip, stage: "done" });
      await store.save("Motion clip: done");
      const notes = report.findings.filter((f) => f.severity !== "error");
      return { content: [text(`Clip "${v.name}" is done.` + (notes.length ? `\nStill worth a look:\n${notes.map((f) => `${f.severity}: [${f.metric}] ${f.message}`).join("\n")}` : ""))] };
    },
  },
  {
    name: "inbetween",
    title: "In-betweens from keys",
    description:
      "Make the frames between approved keys (#110): each part layer is solved as a rigid move between its two keys " +
      "(a turn about its joint, where it meets its parent, and the joint's travel) and sampled at each frame's elapsed " +
      "time with an easing; children ride on their parent so joints stay joined, followers (motion_clip followers: hair, " +
      "a cape) lag, sizes and colors stay the keys' (no new colors), and the keys are never written. Without from/to it " +
      "fills every gap between the clip's keys (and, for a loop, from the last key back to the first). Parts default to " +
      "the clip's rig (root first); without a rig, every shown image layer. Clean the joints after. Needs the clip past " +
      "its keys stage (motion_clip advance).",
    input: z.object({
      tag: z.string().optional().describe("The clip's tag. Default: the clip in progress."),
      from: z.number().int().min(1).optional().describe("A key frame (sprite frame); with `to`, fill only between them."),
      to: z.number().int().min(1).optional(),
      parts: z.array(z.string()).optional().describe("Part layers, root first. Default: the rig's parts."),
      easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]).optional().describe("Spacing between the keys (rule:anim.spacing). Default ease-in-out."),
      arc: z.number().optional().describe("Bend the root part's path upward by this many pixels at the middle (a jump, a hop)."),
    }),
    kind: "edit",
    label: (a) => (a.tag ? `In-betweens for ${a.tag}` : "In-betweens"),
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      let store: MotionStore;
      try { store = await MotionStore.load(doc); } catch (e) { return failure((e as Error).message); }
      const name = input.tag ?? store.active()?.name;
      if (!name) return failure("Name the tag (a clip planned with motion_clip).");
      const v = store.view(name);
      if (!v) return failure(`No clip for "${name}": plan one first (motion_clip action 'plan').`);
      if (v.clip.stage === "keys") return failure(`The clip "${v.name}" is in its keys stage: check the keys, then motion_clip advance.`);
      // Parts, root first: the rig's (parents before children), else every shown image layer as roots.
      const rig = v.clip.character ? store.rig(v.clip.character) : undefined;
      const given: { layer: string; parent?: string }[] = input.parts
        ? input.parts.map((l: string) => ({ layer: l, parent: rig?.parts.find((p) => p.layer === l)?.parent }))
        : rig?.parts.map((p) => ({ layer: p.layer, parent: p.parent }))
          ?? store.info.layers.filter((l) => !l.group && l.visible && l.editable).map((l) => ({ layer: l.name }));
      const missing = given.filter((p) => !store.info.layers.some((l) => l.name === p.layer && !l.group));
      if (missing.length) return failure(`No image layer ${missing.map((m) => `"${m.layer}"`).join(", ")}.`);
      const order: typeof given = [];
      const pending = [...given];
      while (pending.length) {
        const i = pending.findIndex((p) => !p.parent || !pending.some((q) => q.layer === p.parent));
        order.push(...pending.splice(i < 0 ? 0 : i, 1).map((p) => (given.some((q) => q.layer === p.parent) ? p : { layer: p.layer })));
      }
      // Segments: [key a, key b, the frames between] (sprite frames; a loop wraps from the last key to the first).
      const keys = [...v.keys].sort((a, b) => a - b);
      const segs: { a: number; b: number; frames: number[] }[] = [];
      if (input.from !== undefined || input.to !== undefined) {
        if (input.from === undefined || input.to === undefined || input.to <= input.from) return failure("Give from and to, with to after from.");
        segs.push({ a: input.from, b: input.to, frames: v.frames.filter((f) => f > input.from! && f < input.to!) });
      } else {
        for (let i = 1; i < keys.length; i++) segs.push({ a: keys[i - 1], b: keys[i], frames: v.frames.filter((f) => f > keys[i - 1] && f < keys[i]) });
        if (v.clip.loop && keys.length) {
          const last = keys[keys.length - 1], first = keys[0];
          const wrap = [...v.frames.filter((f) => f > last), ...v.frames.filter((f) => f < first)];
          if (wrap.length) segs.push({ a: last, b: first, frames: wrap });
        }
      }
      const todo = segs.filter((s) => s.frames.length);
      if (!todo.length) return failure(`No frames between the keys of "${v.name}" (keys ${keys.join(", ")}).`);
      const at = (f: number) => v.startMs[v.frames.indexOf(f)];
      const items: { image: Rgba; frame: number; layer: string }[] = [];
      const lines: string[] = [];
      const lagOf = (layer: string) => v.clip.followers?.find((x) => x.layer === layer)?.lag ?? 0;
      for (const seg of todo) {
        const span = ((at(seg.b) - at(seg.a)) + v.lengthMs) % v.lengthMs || v.lengthMs;
        const ts = seg.frames.map((f) => (((at(f) - at(seg.a)) + v.lengthMs) % v.lengthMs) / span);
        const partKeys: PartKeys[] = [];
        for (const p of order) {
          partKeys.push({
            layer: p.layer, parent: p.parent, lag: lagOf(p.layer),
            a: await doc.pixels(p.layer, seg.a), b: await doc.pixels(p.layer, seg.b),
          });
        }
        const sol = solveParts(partKeys);
        const imgs = inbetweens(partKeys, sol, ts, { easing: (input.easing ?? "ease-in-out") as Easing, arc: input.arc, lagStep: 1 / (seg.frames.length + 1) });
        for (const [layer, list] of imgs) list.forEach((image, i) => items.push({ image, frame: seg.frames[i], layer }));
        const loose = sol.filter((x) => !x.empty && x.fit < 0.5);
        lines.push(`frames ${seg.frames.join(", ")} between keys ${seg.a} and ${seg.b}: ` +
          sol.map((x) => (x.empty ? `${x.layer} empty in a key (copied)` : `${x.layer} turns ${x.angle}°${x.joint ? ` about ${x.joint.join(",")}` : ""}` +
            `${x.lag ? `, ${x.lag} frame${x.lag > 1 ? "s" : ""} late` : ""} (fit ${x.fit})`)).join("; ") +
          (loose.length ? `\n  ${loose.map((x) => x.layer).join(", ")} change${loose.length > 1 ? "" : "s"} shape between these keys (fit under 0.5), so the move is a rough match: redraw ${loose.length > 1 ? "them" : "it"} in these frames from the keys.` : ""));
      }
      await doc.putImages(items, { label: `In-betweens ${v.name}` });
      return { content: [text([`Made ${new Set(items.map((i) => i.frame)).size} in-between frame(s) of "${v.name}" for ${order.length} part(s), ${input.easing ?? "ease-in-out"}; keys untouched.`,
        ...lines, "Clean where parts meet, then motion_check and snapshot view 'trails'."].join("\n"))] };
    },
  },
  {
    name: "motion_check",
    title: "Motion check",
    description:
      "Measure how an animation moves (#111): per part (its layer) and for the whole figure in every frame of the tag, " +
      "the spacing (px a frame: even, eased or popping), arcs (a limb sliding on a straight line), volume (a part that " +
      "grows or shrinks), flicker (pixels that blink A->B->A and boil in play), the ground row, a planted foot sliding " +
      "forward, the loop seam and flat timing. Errors (volume of a part, flicker, nothing moving) block motion_clip done. " +
      "Parts default to the clip's rig and walk limbs; give layers to measure others.",
    input: z.object({
      tag: z.string().optional().describe("The animation's tag. Default: the clip in progress, else the only tag."),
      parts: z.array(z.string()).optional().describe("Part layers to track (names)."),
    }),
    kind: "read",
    label: (a) => (a.tag ? `Measure the motion of ${a.tag}` : "Measure the motion"),
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      let store: MotionStore;
      try { store = await MotionStore.load(doc); } catch (e) { return failure((e as Error).message); }
      const tags = store.info.tags;
      const name = input.tag ?? store.active()?.name ?? (tags.length === 1 ? tags[0].name : undefined);
      if (!name) return failure(tags.length ? `Name the tag: ${tags.map((t) => t.name).join(", ")}.` : "Tag the animation's frames first.");
      const tag = store.tag(name);
      if (!tag) return failure(`No tag "${name}".`);
      const v = store.view(tag.name) ?? viewOf(tag, { kind: kindOf(tag.name), facing: "right", loop: kindOf(tag.name) !== "action", keys: [], stage: "none" }, store.info.durations);
      const parts = input.parts ?? clipParts(store, v);
      const missing = parts.filter((p: string) => !store.info.layers.some((l) => l.name === p && !l.group));
      if (missing.length) return failure(`No image layer ${missing.map((m: string) => `"${m}"`).join(", ")}.`);
      const report = await trackClip(doc, v, parts);
      return { content: [text(describeReport(v.name, report))], ...(report.findings.some((f) => f.severity === "error") ? { isError: true } : {}) };
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
    title: "Move a part",
    description:
      "Move, turn, scale or squash a rigid part (a layer: an arm, a sword, a whole small sprite), RotSprite-style: " +
      "pixels stay clean and no new colors appear. With `frames`, apply `move` as it is to the layer in each of those " +
      "frames (a turn, a squash on landing). With from_frame and to_frame, sweep it: each later frame gets the " +
      "from_frame drawing a bit further along `move` (eased, optionally on an arc bent upward by `arc` px); for the " +
      "frames between two drawn keys use inbetween instead, which reads both keys. Frames must exist (add them with " +
      "apply_timeline_text first).",
    input: z.object({
      layer: z.string().describe("Layer name."),
      move: moveSchema.describe("The change: with frames, applied in each; with from/to, the full change at to_frame."),
      frames: z.array(z.number().int().min(1)).min(1).optional().describe("Apply move to the layer in these frames."),
      from_frame: z.number().int().min(1).optional(),
      to_frame: z.number().int().min(1).optional(),
      arc: z.number().optional().describe("Sweep: bend the path upward by this many pixels at the middle."),
      easing: z.enum(["linear", "ease-in", "ease-out", "ease-in-out"]).optional().describe("Sweep: default ease-in-out."),
    }),
    kind: "edit",
    label: (a) => (a.layer ? `Move ${a.layer}` : "Move a part"),
    async run(input, aseprite) {
      const doc = documentOf(aseprite);
      const count = (await doc.info()).durations.length;
      const m = input.move;
      const to: Transform = { dx: m.dx, dy: m.dy, angle: m.angle, sx: m.scale_x, sy: m.scale_y, px: m.pivot_x, py: m.pivot_y };
      // Squash (< 0) or stretch (> 0) keeps the area: about the bottom center unless a pivot is given.
      const shaped = (img: Rgba, t: Transform): Rgba => {
        if (!m.squash) return transform(img, t);
        const b = bounds(img);
        const sy = 1 + m.squash;
        return transform(img, { ...t, sy: (t.sy ?? 1) * sy, sx: (t.sx ?? 1) / sy, px: t.px ?? (b ? b.x + b.w / 2 : img.width / 2), py: t.py ?? (b ? b.y + b.h : img.height) });
      };
      if (input.frames) {
        // Each frame once, all in one write (#101): one undo step; a frame listed twice is changed once.
        const frames = [...new Set(input.frames as number[])];
        const past = frames.filter((f) => f > count);
        if (past.length) return failure(`Frame${past.length > 1 ? "s" : ""} ${past.join(", ")} ${past.length > 1 ? "don't" : "doesn't"} exist (${count} frames).`);
        const items = [];
        for (const f of frames) items.push({ image: shaped(await doc.pixels(input.layer, f), to), layer: input.layer, frame: f });
        await doc.putImages(items, { label: `Move ${input.layer}` });
        return { content: [text(`Moved ${input.layer} in frame${frames.length > 1 ? "s" : ""} ${frames.join(", ")}.`)] };
      }
      if (input.from_frame === undefined || input.to_frame === undefined) return failure("Give frames, or from_frame and to_frame.");
      if (input.to_frame <= input.from_frame) return failure("to_frame must come after from_frame.");
      if (input.to_frame > count) return failure("to_frame is past the last frame; add frames first.");
      const base = await doc.pixels(input.layer, input.from_frame);
      const n = input.to_frame - input.from_frame;
      // Every frame in one write (#101): one transaction, one undo step, nothing half done.
      const items = [];
      for (let f = input.from_frame + 1; f <= input.to_frame; f++) {
        const t = (f - input.from_frame) / n;
        const at = along(to, t, input.arc ?? 0, (input.easing ?? "ease-in-out") as Easing);
        items.push({ image: m.squash ? shaped(base, { ...at }) : transform(base, at), layer: input.layer, frame: f });
      }
      await doc.putImages(items, { label: `Move ${input.layer}` });
      return { content: [text(`Animated ${input.layer} over frames ${input.from_frame + 1}-${input.to_frame} (${n} steps, ${input.easing ?? "ease-in-out"}${input.arc ? `, arc ${input.arc}px` : ""}).`)] };
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
