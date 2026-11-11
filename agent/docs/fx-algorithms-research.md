# Effect algorithms: research for the FX tool families

Research notes for the planned effect generators (juice transforms, smears, fluids, effect pipelines, particle
emitters), written before implementation. Licenses marked "checked" were confirmed online; the rest are from memory
and must be checked against each LICENSE file before any code is vendored. GPL, AGPL and unlicensed code is read for
ideas only; everything here is reimplemented from the papers.

## 1. Juice transforms on an existing sprite

**Sources**
- Squash and stretch: Thomas & Johnston, *The Illusion of Life* (1981). Area-preserving: `sx = s`, `sy = 1/s`.
- Jonasson & Purho, "Juice it or lose it" (GDC Europe 2012); Nijman, "The Art of Screenshake" (2013).
- Shake: Eiserloh, "Juicing Your Cameras With Math" (GDC 2016): offset = maxOffset · trauma² · noise(t).
- Easing: Robert Penner's easing equations (2001, BSD); curves at https://easings.net.
- Springs: Ryan Juckett, "Damped Springs" (2012), a closed-form, frame-rate-independent damped harmonic
  oscillator; Daniel Holden, "Spring-It-On" (2021), https://theorangeduck.com/page/spring-roll-call.
- Rotation: Paeth, "A Fast Algorithm for General Raster Rotation" (Graphics Interface 1986), three shears;
  RotSprite (Xenowhirl, 2007), https://info.sonicretro.org/RotSprite; EPX (Eric Johnston) and Scale2x
  (A. Mazzoleni, https://www.scale2x.it).

**Implementations**
- MIT: `eases` (https://github.com/mattdesl/eases), `bezier-easing` (https://github.com/gre/bezier-easing),
  `wobble` spring solver (https://github.com/skevy/wobble), popmotion (https://github.com/Popmotion/popmotion).
- Ideas only: the `rotsprite` Rust crate and RotSpriteSharp (AGPL-3.0, checked), the Scale2x reference code (GPL;
  the algorithm is small and documented, so a clean reimplementation is fine), Aseprite's own
  `src/doc/algorithm/rotsprite.cpp` (Aseprite EULA).

**Pixel-art adaptation**
- Every transform is an inverse map: for each output pixel, find the source coordinate, `floor` it, and sample the
  nearest pixel. No filtering.
- Squash, pulse and bounce drive a scale `s(t)` from a spring or a Penner curve, anchored at the feet
  (bottom-centre), with the size rounded to whole pixels each frame.
- Jelly wobble: shift each row by `round(A·e^(−ζt)·sin(ωt + k·y))`; the phase grows with height, so the base stays.
- Rotation: RotSprite (Scale2x three times to 8×, nearest-neighbour rotate, downsample by mode), or Paeth's three
  shears as the cheap path. Snap angles to 15–22.5° steps.
- Hit flash: every opaque pixel becomes the palette's white or hit color for one or two frames. Shake: integer
  offsets with a short decay.

## 2. Smears and motion trails

**Sources**
- Smear frames as a technique: *The Dover Boys* (Chuck Jones, 1942); Pedro Medeiros (Saint11) pixel-art smear
  tutorials, https://saint11.art.
- Basset, Bénard & Barla, "SMEAR: Stylized Motion Exaggeration with ARt-direction" (SIGGRAPH 2024). Its code,
  https://github.com/MoStyle/SMEAR, is GPL-3 (checked): ideas only.
- Optical flow: Lucas & Kanade (IJCAI 1981); Horn & Schunck (*Artificial Intelligence* 17, 1981). Block matching
  (SAD over 3×3 or 5×5 windows) is enough at 16–256 px.
- Implementations: jsfeat, pyramidal Lucas-Kanade in JS (MIT, https://github.com/inspirit/jsfeat); OpenCV 4.5+
  (Apache-2.0) as a reference for Farneback and LK.
- No open-source pixel-art smear generator was found.

**Pixel-art adaptation**
- Motion vector: from the user (key positions), the tag's movement, bounding-box or centroid deltas between frames,
  or per-pixel block matching for parts that deform.
- Sweep smear: for an in-between, OR the sprite mask at N sub-steps along `v` (Bresenham steps), filled with the
  dominant edge color or a 2–3 color ramp; trailing copies may shrink to taper.
- Stretch smear: nearest-neighbour scale along `v` (length `|v|`, width 1/length to keep the area), for one frame.
- Afterimages and multiples: copies at past positions, one palette step darker each, or dropped every other frame.
  Use a dithered checker for transparency, not alpha blending.

## 3. Low-resolution 2D fluids

**Papers**
- Stam, "Stable Fluids" (SIGGRAPH 1999); Stam, "Real-Time Fluid Dynamics for Games" (GDC 2003),
  https://www.dgp.toronto.edu/public_user/stam/reality/Research/pdf/GDC03.pdf.
- Fedkiw, Stam & Jensen, "Visual Simulation of Smoke" (SIGGRAPH 2001): vorticity confinement.
- Harlow & Welch (1965): the MAC staggered grid. Brackbill & Ruppel (1986): FLIP. Zhu & Bridson, "Animating Sand as
  a Fluid" (2005): the PIC/FLIP blend. Bridson & Müller-Fischer, SIGGRAPH 2007 course notes; Bridson, *Fluid
  Simulation for Computer Graphics*.
- Müller, Charypar & Gross, "Particle-Based Fluid Simulation for Interactive Applications" (SCA 2003): SPH.
- Nguyen, Fedkiw & Jensen, "Physically Based Modeling and Animation of Fire" (SIGGRAPH 2002).
- Fabien Sanglard, "How DOOM fire was done" (2018), https://fabiensanglard.net/doom_fire_psx/: a cellular fire
  that suits pixel art.
- Bayer, "An optimum method for two-level rendition of continuous-tone pictures" (1973).

**Implementations**
- PavelDoGreat WebGL-Fluid-Simulation (MIT, checked), https://github.com/PavelDoGreat/WebGL-Fluid-Simulation.
- Ten Minute Physics episodes 17 (Eulerian) and 18 (FLIP),
  https://matthias-research.github.io/pages/tenMinutePhysics/: no LICENSE file at the repository root (checked), so
  reimplement from the videos.
- Mike Ash, "Fluid Simulation for Dummies" (a port of Stam's code, as an article).
- Stam's stable-fluids patent, US 6,266,071, was filed in 1998 and should have expired; worth a quick check.

**Pixel-art adaptation**
- Simulate on a grid at 1× or 2× the sprite's resolution (64×64 is microseconds a step in TypeScript):
  semi-Lagrangian advection, vorticity confinement, then a pressure projection with 20–40 Jacobi or Gauss-Seidel
  iterations.
- Smoke: density plus temperature, buoyancy proportional to temperature. Fire: fuel to temperature to smoke, with
  cooling. Doom-style cellular fire is the cheap 1-bit-like path.
- Liquids: FLIP particles on the grid (about 0.9 FLIP, 0.1 PIC); rasterize particle occupancy and threshold it.
- Shading: a scalar field maps to a palette ramp index with ordered dithering on the ramp steps:
  `idx = clamp(floor(v·(N−1) + bayer4x4[y&3][x&3]/16 − 0.5))`.
- Seamless loops: simulate 2L frames and crossfade the fields (not the colors) of frames L..2L into 0..L, then
  quantize; or drive the sim with time-periodic sources (curl noise sampled on a circle in 4D noise) and run several
  periods; or wrap the domain.

## 4. Effect pipelines (node-graph style)

**References**
- Material Maker (RodZill4, MIT, Godot), a node library to borrow ideas from:
  https://github.com/RodZill4/material-maker. Graph runtimes: litegraph.js (MIT,
  https://github.com/jagenjo/litegraph.js), Rete.js (MIT, https://github.com/retejs/rete).
- Pixel Composer (MakhamDev): license unchecked, assume not permissive. Laigter (normal maps): GPL-3, ideas only.
- Noise: Perlin, "An Image Synthesizer" (1985) and "Improving Noise" (2002); Gustavson, "Simplex noise demystified"
  (2005); Worley, "A Cellular Texture Basis Function" (1996). Implementations: FastNoiseLite (MIT, has a TS/JS
  port: Perlin, OpenSimplex, value, cellular), https://github.com/Auburn/FastNoiseLite; `simplex-noise` (MIT, TS),
  https://github.com/jwagner/simplex-noise.js; OpenSimplex2 (CC0), https://github.com/KdotJPG/OpenSimplex2.
- Pixelating a high-res source: Gerstner et al., "Pixelated Image Abstraction" (NPAR 2012), or an area-mode
  downsample then palette quantization.
- Palette mapping: nearest color in OKLab (Björn Ottosson, 2020, https://bottosson.github.io/posts/oklab/).
  Quantization and dithering: image-q (MIT, TS), https://github.com/ibezkrovnyi/image-quantization.
- Thick outlines: the jump flood algorithm (Rong & Tan, I3D 2006).

**Pixel-art adaptation**
- Steps pass mask, color index and scalar buffers at native resolution; only the last step writes palette indices.
- Dissolve: `noise(x, y) < t` per pixel, with an edge band one palette step brighter.
- Displacement: offset by `round(noise·amp)` with nearest sampling. Gradient map: luminance to a ramp index.
- Glow: dilate the mask by k and fill it with a ramp by distance; no Gaussian blur.
- Normal map: smooth the alpha mask with a distance transform into a height, apply Sobel, and quantize the normals
  to 8–16 directions for cel lighting.
- Frames animate step parameters over time; looping noise samples 3D or 4D noise along a circle in time.

## 5. Particle emitters

**Sources**
- Reeves, "Particle Systems — A Technique for Modeling a Class of Fuzzy Objects" (SIGGRAPH 1983).
- Bridson, Hourihan & Nordenstam, "Curl-Noise for Procedural Fluid Flow" (SIGGRAPH 2007): velocity is the curl of a
  noise potential, so it is divergence-free.
- Bridson, "Fast Poisson Disk Sampling in Arbitrary Dimensions" (2007): even spawn points.
- Implementations (MIT): @pixi/particle-emitter (https://github.com/pixijs/particle-emitter), three.quarks
  (https://github.com/Alchemist0823/three.quarks), tsParticles (https://github.com/tsparticles/tsparticles).

**Pixel-art adaptation**
- Emission shapes: point, line, rectangle, circle, ring or arc, the sprite's own outline pixels, or a polyline
  parameterized by arc length (uniform `u`, or a Poisson disk).
- Integrate in floating point and draw at `floor(pos)`. Curl noise: `v = (∂ψ/∂y, −∂ψ/∂x)` by finite differences,
  plus gravity and drag.
- Size and color come from life ramps, snapped to 1–3 px stamps and palette steps. Trails keep the last k integer
  positions and draw them with Bresenham, down the ramp.
- Seeded PRNG (mulberry32 or PCG). Loops emit with period L and pre-warm L frames before recording.
