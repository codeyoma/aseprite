# Notices: vendored pixelfx

`vendor/` holds part of [pixelfx](https://github.com/patch-gg/pixelfx) at commit
`044e12a45dc9cc312cec50ee606dfc98afe5adc2`, copied as-is except for the local edits listed below. Each file keeps its
own header, including its credits.

## What is vendored

- `vendor/core/`: `math.js`, `color.js`, `painter.js`, `sim.js`, `particles.js`, `fx.js`, `chain.js`, `shapes.js`
  and `index.js`, from pixelfx's `src/core/`.
- `vendor/effects/`: three effects used as the engine's test set, from pixelfx's `src/fx/`:
  `impacts/hit-spark.js`, `lightning/plasma-ball.js` and `nature/poison-cloud.js`.

Not vendored: `act.js`, `actor.js`, `rig.js`, `poses.js`, `scene.js` and `font.js` from `src/core/`, and nothing from
`gallery/`. The Patch Pixel font in pixelfx's `gallery/fonts` is not covered by pixelfx's MIT license and is not
copied here.

`vendor/core/index.d.ts` is ours: TypeScript declarations for the part of the core that `index.ts` uses.

## Local edits

- `core/index.js`: no longer re-exports the font (`FONTS`, `textWidth`), the actor (`stockActor`, `drawActor`,
  `actorAlphaOf`, `HERO`, `HERO2`, `HERO_PAL`, `DUMMY_PAL`), scenes (`backdrop`, `BACKDROPS`), acts (`createAct`,
  `actBounds`, `actSpan`, `actTiming`, `poseAt`, `lerpPose`, `Target`, `STAND`, `SKINS`, `posed`), the rig
  (`skeleton`, `posedParts`) or poses (`READY`). A comment notes the edit.
- `core/fx.js`: no longer imports `stockActor`; `resolveOptions` throws "this effect needs an actor" when an effect
  needs a character and none is passed, instead of using the stock one.
- `core/painter.js`: no longer imports the font; `Painter.text()` and `Painter.measure()` throw "text not supported".
- The TypeScript build (`allowJs`) re-prints these files into `dist/`: the same code with different line breaks.

## Credits

- **pixelfx**: Copyright (c) 2026 Patch, Copyright (c) 2026 Hugo Duprez. MIT License, below.
- **Sprite Fusion's pixel art VFX**: `core/sim.js` and the effects that say so at the top of their file
  (`hit-spark.js`, `plasma-ball.js`) adapt Sprite Fusion's open-source pixel art VFX
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
