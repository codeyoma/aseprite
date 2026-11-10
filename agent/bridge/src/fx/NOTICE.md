# Notices: vendored pixelfx

`vendor/` holds part of [pixelfx](https://github.com/patch-gg/pixelfx) at commit
`044e12a45dc9cc312cec50ee606dfc98afe5adc2`, copied as-is except for the local edits listed below. Each file keeps its
own header, including its credits.

## What is vendored

- `vendor/core/`: `math.js`, `color.js`, `painter.js`, `sim.js`, `particles.js`, `fx.js`, `chain.js`, `shapes.js`,
  `poses.js` and `index.js`, from pixelfx's `src/core/`. `poses.js` is data only (the `READY` stance some effects'
  `act` export starts from; their acts are not used here).
- `vendor/effects/<category>/`: the FX library (`../library.ts`), from pixelfx's `src/fx/<category>/`, with each
  category's shared `_lib.js`. Every file is pixelfx's (MIT, below); the ones marked Sprite Fusion adapt Sprite
  Fusion's pixel art VFX named after it (credit below and at the top of the file):
  - `arcane/`: `_lib` (Sprite Fusion: black-hole, energy), `arcane-orb` (Sprite Fusion: energy), `magic-circle-cast` (Sprite Fusion: holy-light), `mana-burst` (Sprite Fusion: energy), `portal` (Sprite Fusion: black-hole), `rune-circle` (Sprite Fusion: heal).
  - `explosions/`: `_lib` (Sprite Fusion: explosion), `grenade` (Sprite Fusion: explosion), `implosion` (Sprite Fusion: energy), `plasma-explosion` (Sprite Fusion: energy), `small-explosion` (Sprite Fusion: explosion), `smoke-bomb`.
  - `fire/`: `_lib` (Sprite Fusion: fire), `campfire` (Sprite Fusion: fire), `candle` (Sprite Fusion: fire), `fireball` (Sprite Fusion: explosion), `flame-pillar` (Sprite Fusion: explosion, holy-light), `meteor` (Sprite Fusion: explosion), `spirit-flame` (Sprite Fusion: fire), `torch` (Sprite Fusion: fire).
  - `holy/`: `_lib` (Sprite Fusion: heal), `feather-burst`, `heal-aoe`, `holy-pillar`, `smite`, `sunburst`.
  - `impacts/`: `_lib` (Sprite Fusion: impact, explosion), `bullet-impact` (Sprite Fusion: impact), `crit-hit` (Sprite Fusion: impact), `ground-slam` (Sprite Fusion: explosion), `heavy-landing` (Sprite Fusion: explosion), `hit-spark` (Sprite Fusion: impact), `parry` (Sprite Fusion: impact), `ricochet` (Sprite Fusion: impact).
  - `lightning/`: `_lib` (Sprite Fusion: lightning), `ball-lightning` (Sprite Fusion: energy), `chain-lightning` (Sprite Fusion: lightning), `lightning-strike` (Sprite Fusion: lightning), `plasma-ball` (Sprite Fusion: energy), `spark-arc` (Sprite Fusion: lightning).
  - `melee/`: `_lib` (Sprite Fusion: slash), `claw-swipe` (Sprite Fusion: slash), `double-slash` (Sprite Fusion: slash), `heavy-cleave` (Sprite Fusion: slash), `spin-slash` (Sprite Fusion: slash), `sword-slash` (Sprite Fusion: slash), `thrust` (Sprite Fusion), `uppercut` (Sprite Fusion).
  - `nature/`: `poison-cloud`.

  Left out on purpose: effects that read the character (`o.actor`, pixelfx's `onBody`), the text effect
  (`cartoon-pow`, it needs the font), and others to keep the first set near 40. Some melee and impact effects set
  `meta.actor: 2` only for pixelfx's gallery (the character's scale and pose); they never read `o.actor`, and
  `library.ts` offers them with `actor` removed from their meta (their files are unchanged).

Not vendored: `act.js`, `actor.js`, `rig.js`, `scene.js` and `font.js` from `src/core/`, and nothing from
`gallery/`. The Patch Pixel font in pixelfx's `gallery/fonts` is not covered by pixelfx's MIT license and is not
copied here.

`vendor/core/index.d.ts` is ours: TypeScript declarations for the part of the core that `index.ts` uses.

## Local edits

- `core/index.js`: no longer re-exports the font (`FONTS`, `textWidth`), the actor (`stockActor`, `drawActor`,
  `actorAlphaOf`, `HERO`, `HERO2`, `HERO_PAL`, `DUMMY_PAL`), scenes (`backdrop`, `BACKDROPS`), acts (`createAct`,
  `actBounds`, `actSpan`, `actTiming`, `poseAt`, `lerpPose`, `Target`, `STAND`, `SKINS`, `posed`) or the rig
  (`skeleton`, `posedParts`). It still re-exports `READY` from `poses.js`. A comment notes the edit.
- `core/fx.js`: no longer imports `stockActor`; `resolveOptions` throws "this effect needs an actor" when an effect
  needs a character and none is passed, instead of using the stock one.
- `core/painter.js`: no longer imports the font; `Painter.text()` and `Painter.measure()` throw "text not supported".
- The TypeScript build (`allowJs`) re-prints these files into `dist/`: the same code with different line breaks.

## Credits

- **pixelfx**: Copyright (c) 2026 Patch, Copyright (c) 2026 Hugo Duprez. MIT License, below.
- **Sprite Fusion's pixel art VFX**: `core/sim.js` and the effects that say so at the top of their file (marked
  Sprite Fusion in the list above) adapt Sprite Fusion's open-source pixel art VFX
  (https://www.spritefusion.com/pixel-art-vfx), Copyright (c) 2026 Hugo Duprez, MIT License.
- **Hollow Crown**: pixelfx's `act.js` adapts Hollow Crown (https://github.com/rehan-remade/hollow-crown),
  Copyright (c) 2026 rehan-remade, MIT License. `act.js` is not vendored here; this credit is kept for when it is.

## pixelfx license

```
MIT License

Copyright (c) 2026 Patch
Copyright (c) 2026 Hugo Duprez

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
