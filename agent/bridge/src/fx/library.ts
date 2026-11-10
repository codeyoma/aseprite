// The FX library (#69): the curated pixelfx effects the tools offer, as a typed catalog. Every entry comes
// from its vendored module's own meta (./vendor/effects/<category>/<id>.js; credits in ./NOTICE.md): title,
// description, tags, loop or one-shot, duration, canvas size, origin, fps, default palette and options.
import type { EffectMeta, EffectModule } from "./index.js";
import * as arcaneOrb from "./vendor/effects/arcane/arcane-orb.js";
import * as magicCircleCast from "./vendor/effects/arcane/magic-circle-cast.js";
import * as manaBurst from "./vendor/effects/arcane/mana-burst.js";
import * as portal from "./vendor/effects/arcane/portal.js";
import * as runeCircle from "./vendor/effects/arcane/rune-circle.js";
import * as grenade from "./vendor/effects/explosions/grenade.js";
import * as implosion from "./vendor/effects/explosions/implosion.js";
import * as plasmaExplosion from "./vendor/effects/explosions/plasma-explosion.js";
import * as smallExplosion from "./vendor/effects/explosions/small-explosion.js";
import * as smokeBomb from "./vendor/effects/explosions/smoke-bomb.js";
import * as campfire from "./vendor/effects/fire/campfire.js";
import * as candle from "./vendor/effects/fire/candle.js";
import * as fireball from "./vendor/effects/fire/fireball.js";
import * as flamePillar from "./vendor/effects/fire/flame-pillar.js";
import * as meteor from "./vendor/effects/fire/meteor.js";
import * as spiritFlame from "./vendor/effects/fire/spirit-flame.js";
import * as torch from "./vendor/effects/fire/torch.js";
import * as featherBurst from "./vendor/effects/holy/feather-burst.js";
import * as healAoe from "./vendor/effects/holy/heal-aoe.js";
import * as holyPillar from "./vendor/effects/holy/holy-pillar.js";
import * as smite from "./vendor/effects/holy/smite.js";
import * as sunburst from "./vendor/effects/holy/sunburst.js";
import * as bulletImpact from "./vendor/effects/impacts/bullet-impact.js";
import * as critHit from "./vendor/effects/impacts/crit-hit.js";
import * as groundSlam from "./vendor/effects/impacts/ground-slam.js";
import * as heavyLanding from "./vendor/effects/impacts/heavy-landing.js";
import * as hitSpark from "./vendor/effects/impacts/hit-spark.js";
import * as parry from "./vendor/effects/impacts/parry.js";
import * as ricochet from "./vendor/effects/impacts/ricochet.js";
import * as ballLightning from "./vendor/effects/lightning/ball-lightning.js";
import * as chainLightning from "./vendor/effects/lightning/chain-lightning.js";
import * as lightningStrike from "./vendor/effects/lightning/lightning-strike.js";
import * as plasmaBall from "./vendor/effects/lightning/plasma-ball.js";
import * as sparkArc from "./vendor/effects/lightning/spark-arc.js";
import * as clawSwipe from "./vendor/effects/melee/claw-swipe.js";
import * as doubleSlash from "./vendor/effects/melee/double-slash.js";
import * as heavyCleave from "./vendor/effects/melee/heavy-cleave.js";
import * as spinSlash from "./vendor/effects/melee/spin-slash.js";
import * as swordSlash from "./vendor/effects/melee/sword-slash.js";
import * as thrust from "./vendor/effects/melee/thrust.js";
import * as uppercut from "./vendor/effects/melee/uppercut.js";
import * as poisonCloud from "./vendor/effects/nature/poison-cloud.js";

/** The vendored modules by category and id (the file name). */
const MODULES: Record<string, Record<string, unknown>> = {
  impacts: {
    "hit-spark": hitSpark, "crit-hit": critHit, "bullet-impact": bulletImpact, parry, ricochet,
    "ground-slam": groundSlam, "heavy-landing": heavyLanding,
  },
  melee: {
    "sword-slash": swordSlash, "double-slash": doubleSlash, "claw-swipe": clawSwipe, "spin-slash": spinSlash,
    thrust, uppercut, "heavy-cleave": heavyCleave,
  },
  explosions: {
    "small-explosion": smallExplosion, grenade, "plasma-explosion": plasmaExplosion, implosion, "smoke-bomb": smokeBomb,
  },
  lightning: {
    "lightning-strike": lightningStrike, "chain-lightning": chainLightning, "spark-arc": sparkArc,
    "ball-lightning": ballLightning, "plasma-ball": plasmaBall,
  },
  arcane: {
    "mana-burst": manaBurst, "magic-circle-cast": magicCircleCast, "arcane-orb": arcaneOrb, portal, "rune-circle": runeCircle,
  },
  holy: { smite, "holy-pillar": holyPillar, "heal-aoe": healAoe, "feather-burst": featherBurst, sunburst },
  fire: {
    fireball, meteor, "flame-pillar": flamePillar, torch, campfire, candle, "spirit-flame": spiritFlame,
  },
  nature: { "poison-cloud": poisonCloud },
};

export const FX_CATEGORIES = Object.keys(MODULES);

/** An effect option: its name, default and kind (a ramp is a list of colors, dark to bright). */
export interface FxOption {
  name: string;
  default: unknown;
  kind: "ramp" | "color" | "number" | "boolean" | "text" | "value";
}

/**
 * What add_fx's (x, y) means for an effect: "center" puts the effect's visual centre there (the point of impact
 * for hits, slashes and bursts in the air); "ground" puts its origin there (pixelfx's ground point: the foot of a
 * pillar, fire, explosion or circle that stands on the floor).
 */
export type FxAnchor = "center" | "ground";

/** Tags that say an effect stands on the ground (pixelfx tags its floor effects, props and ambient loops so). */
const GROUND_TAGS = new Set(["ground", "prop", "ambient"]);
/** Effects whose tags say otherwise: a ricochet sparks in the air; an explosion and a meteor sit on the floor. */
const ANCHOR_OVERRIDES: Record<string, FxAnchor> = { ricochet: "center", "small-explosion": "ground", meteor: "ground" };

/** The default anchor: hand-listed, else melee is centred, else ground when its tags say so, else centred. */
export function defaultAnchor(category: string, id: string, tags: string[]): FxAnchor {
  if (ANCHOR_OVERRIDES[id]) return ANCHOR_OVERRIDES[id];
  if (category === "melee") return "center";
  return tags.some((t) => GROUND_TAGS.has(t)) ? "ground" : "center";
}

export interface FxEntry {
  /** The effect's file name, e.g. "hit-spark". */
  id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  loop: boolean;
  durationMs: number;
  /** The effect's canvas in px. */
  size: { width: number; height: number };
  /**
   * Where the effect's anchor sits on its canvas: the feet of the character for melee and casts, the point of
   * impact, the base of a torch or pillar. add_fx puts it at (x, y) with anchor "ground".
   */
  origin: { x: number; y: number };
  /** add_fx's default anchor (defaultAnchor). */
  anchor: FxAnchor;
  /** The frame rate the effect was made for. */
  fps: number;
  /** The default color ramp (palette option), dark to bright. */
  palette: string[];
  seed: number;
  /** Every option but palette and seed, with defaults. */
  options: FxOption[];
  /** The module to render (renderFx). */
  module: EffectModule;
}

const isColor = (v: unknown) => typeof v === "string" && /^#[0-9a-f]{3,8}$/i.test(v);
function kindOf(v: unknown): FxOption["kind"] {
  if (Array.isArray(v) && v.length && v.every(isColor)) return "ramp";
  if (isColor(v)) return "color";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "string") return "text";
  return "value";
}

function entry(category: string, id: string, mod: Record<string, unknown>): FxEntry {
  const meta = mod.meta as EffectMeta;
  const opts = meta.options ?? {};
  // Some melee and spark effects set actor: 2 for pixelfx's gallery only (the character's scale and pose);
  // none of these read o.actor, so the module is offered without it (effects that do read it are not vendored).
  const module = { ...mod, meta: { ...meta, actor: undefined } } as unknown as EffectModule;
  return {
    id, category, module,
    title: meta.name ?? id,
    description: meta.desc ?? "",
    tags: meta.tags ?? [],
    loop: !!meta.loop,
    durationMs: Math.round((meta.duration ?? 1) * 1000),
    size: { width: meta.size[0], height: meta.size[1] },
    origin: { x: meta.origin[0], y: meta.origin[1] },
    anchor: defaultAnchor(category, id, meta.tags ?? []),
    fps: meta.fps ?? 30,
    palette: (opts.palette as string[] | undefined) ?? [],
    seed: typeof opts.seed === "number" ? opts.seed : 1,
    options: Object.entries(opts).filter(([k]) => k !== "palette" && k !== "seed").map(([name, d]) => ({ name, default: d, kind: kindOf(d) })),
  };
}

/** Every effect, by category in catalog order. */
export const FX_LIBRARY: FxEntry[] = Object.entries(MODULES).flatMap(([cat, mods]) =>
  Object.entries(mods).map(([id, mod]) => entry(cat, id, mod as Record<string, unknown>)));

/** An effect by id (case-insensitive; spaces and underscores read as dashes). */
export function findFx(id: string): FxEntry | undefined {
  const key = id.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return FX_LIBRARY.find((e) => e.id === key);
}

/** Effects matching every word of query (id, title, description, tags, category), a category and loop or not. */
export function searchFx(o: { query?: string; category?: string; loop?: boolean } = {}): FxEntry[] {
  const words = (o.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return FX_LIBRARY.filter((e) => {
    if (o.category && e.category !== o.category.toLowerCase()) return false;
    if (o.loop !== undefined && e.loop !== o.loop) return false;
    const hay = [e.id, e.title, e.description, e.category, ...e.tags].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
