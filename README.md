# minecraft-web — voxel sandbox เล่นได้บนเว็บ

เกม voxel แบบ Minecraft-like ที่รันบนเบราว์เซอร์แบบ static ล้วน (ไม่มี backend):
เดินในโลกที่ generate ด้วย noise, ขุด/วางบล็อก, hotbar 9 ช่อง, HUD, save/load ในเครื่อง
ประกอบจาก 3 โมดูล (engine + player + interaction) ที่รวมอยู่ในหน้าเดียวคือ `index.html`

**เล่นได้เลย:** https://alungranpj.github.io/minecraft-web/ — ไม่ต้องติดตั้งอะไร
(ต้องมี WebGL2: Chrome / Edge / Firefox / Safari เวอร์ชันใหม่มีหมด)

source: https://github.com/AlungranPJ/minecraft-web (branch `main` = โค้ด, branch `gh-pages` = build ที่ deploy)

![horizon](docs/screenshot-horizon.png)

## วิธีเล่น (ปุ่มทั้งหมด)

| ปุ่ม | ทำอะไร |
|---|---|
| คลิกที่จอ (หรือปุ่ม "คลิกเพื่อเล่น") | ล็อกเมาส์ เริ่มเล่น |
| ขยับเมาส์ | หมุนมุมมอง (pitch จำกัด +/-89 องศา) |
| WASD / ลูกศร | เดินหน้า-ถอย-ซ้าย-ขวา |
| Shift (ค้าง) | วิ่ง |
| Space | กระโดด |
| คลิกซ้ายค้าง | ขุดบล็อกที่เป้า (มี progress bar กลางจอ, ใบไม้ 0.3 วิ → หิน 1.5 วิ) |
| คลิกขวา | วางบล็อกจากช่องที่เลือก (คลิกค้าง = วางซ้ำทุก 0.22 วิ) |
| 1-9 | เลือกช่อง hotbar |
| ล้อเมาส์ | เลื่อนช่อง hotbar |
| F3 | เปิด/ปิด debug overlay (fps, พิกัด, chunk, เป้า, จำนวน edit, เวลา save) |
| ESC | ปล่อยเมาส์ (ต้องกดก่อนถึงจะคลิกปุ่มบนจอได้) |
| ปุ่ม Reset world (ขวาบน) | คลิกสองครั้ง = ล้างโลก ผู้เล่น และ save |

หมายเหตุการเล่น: เมาส์ที่ล็อกอยู่จะส่ง event ไปที่ canvas ทั้งหมด ปุ่มบน HUD (Reset world)
จึงกดได้หลังกด ESC แล้วเท่านั้น และอย่าขุดบล็อกที่ตัวเองยืนอยู่ — ผู้เล่นจะตกลงไปในหลุม
แล้ววางบล็อกกลับที่เดิมไม่ได้ (ระบบปฏิเสธด้วย "block would hit you" ตามกติกาปกติ)

## วิธีรัน (dev)

```bash
npm install
npm run dev          # http://localhost:5173  (dev server + HMR)
npm run build        # tsc --noEmit && vite build -> dist/ (static, เปิดจาก web server ใดก็ได้)
npm run preview      # เสิร์ฟ dist/ ที่ http://localhost:4173
npm run typecheck    # tsc --noEmit
```

หน้าในโปรเจกต์:

| หน้า | คืออะไร |
|---|---|
| `/` (index.html) | **ตัวเกม** — engine + first person player + ขุด/วาง/HUD/save (`src/main.ts`) |
| `/engine.html` | เดโม engine (กล้อง spectator + HUD) — หน้าที่เทสต์ engine ยิงใส่ (`src/engineDemo.ts`) |
| `/player.html` | เดโม first person player เดี่ยว ๆ (`src/player-demo.ts`) |
| `/interaction.html` | เดโมขุด/วาง/HUD เดี่ยว ๆ (`src/interactionDemo.ts`) |

`dist/` ตั้ง `base: './'` ไว้แล้ว ย้ายไปวางที่ path ไหนก็ได้ ไม่ต้องแก้ base

## วิธี deploy (GitHub Pages)

ทำแบบนี้แล้ว (repo `AlungranPJ/minecraft-web`, Pages = branch `gh-pages` / root):

```bash
npm run build                                   # -> dist/
# ยก dist/ ขึ้น branch gh-pages (source อยู่ branch main แยกกัน)
mkdir -p /tmp/pages && cp -r dist/. /tmp/pages/ && touch /tmp/pages/.nojekyll
cd /tmp/pages && git init -b gh-pages && git add -A && git commit -m deploy
git remote add origin https://github.com/AlungranPJ/minecraft-web.git && git push -f origin gh-pages
```

`gh-pages` ต้องมี `.nojekyll` (vite ใส่ชื่อไฟล์ asset ที่มี `-` และ hash ไม่มี underscore
แต่กันไว้ให้ชัวร์) Netlify / Cloudflare Pages ใช้ `dist/` เป็น publish directory ตรง ๆ ได้เลย
ไม่ต้องตั้ง base path เพราะ build ใช้ relative path

## เทสต์ทั้งหมด (รันซ้ำได้)

```bash
npm run test:smoke           # 62 checks  (engine, node)
npm run test:player          # 114 checks (player physics/collision, node)
npm run test:interaction     # 117 checks (ขุด/วาง/hotbar/save, node)
npm run test:perf            # 28 checks  (adaptive ladder + ต้นทุนต่อ chunk, node)

npm run preview &            # ต้องมี server เสิร์ฟ dist/ ก่อนเทสต์เบราว์เซอร์
npm run test:browser         # 23 checks  (engine.html, Chrome จริงผ่าน CDP)
npm run test:player:browser  # 41 checks  (player.html)
npm run test:interaction:browser # 56 checks (interaction.html)
npm run test:game:browser    # 64 checks  (index.html = ตัวเกม + checklist acceptance)
npm run perf:report          # วัด fps ทุกระดับคุณภาพ + CPU throttle 12x -> test-output/perf-report.json
```

ชี้เทสต์ตัวเกมไปที่เว็บที่ deploy แล้วได้เลย (ใช้ checklist ชุดเดียวกัน):

```bash
PAGE_URL=https://alungranpj.github.io/minecraft-web/ npm run test:game:browser
```

ต้องมี Chrome ที่ `C:/Program Files/Google/Chrome/Application/chrome.exe` (override ด้วย `CHROME_PATH`)

## สถาปัตยกรรม: boot flow ของตัวเกม

`src/main.ts` ประกอบของ 3 ชั้นเข้าด้วยกัน โดยไม่แก้ public API ของ engine:

```
createGame(canvas, { controls: 'none', renderDistance: 6, maxChunkOpsPerFrame: 2 })
  -> FirstPersonPlayer({ world, camera, element: canvas, spawnX, spawnZ })
  -> createFirstPersonPlayerAdapter(player)      // ห่อผู้เล่นเป็น PlayerAdapter ให้ชั้น interaction
  -> new InteractionSession({ world, scene, player: adapter, atlasCanvas, hudOptions, highlight })
  -> AdaptiveQuality()                           // บันไดคุณภาพเมื่อ fps ตก

game.onFrame((dt) => {
  player.update(dt)      // ฟิสิกส์ + กล้อง + mouse look
  session.update(dt)     // apply edit -> chunk, ขุด/วาง, HUD, autosave 10 วิ
  ทุก 0.5 วิ: อ่าน fps -> adaptive.update(dt, fps) -> ถ้าบันไดขยับก็ apply (render distance / pixel ratio / chunk ops)
})
```

boot flow: **loading screen** (รอ chunk รอบตัวผู้เล่น meshed ครบวงรัศมี 3 = 45 chunk, มี timeout 20 วิ)
→ **overlay "คลิกเพื่อเล่น"** (แสดงปุ่มทั้งหมด) → คลิกแล้วล็อกเมาส์เข้าเกม
(`bootInfo()` บน `window.__GAME` รายงาน `loadMs`, quality, renderDistance, restored)

### debug / test surface

`window.__GAME` มี `game, world, scene, camera, renderer, player, session, hotbar, edits, hud, adaptive`
และเมธอดสำหรับเทสต์/คอนโซล: `bootInfo()`, `stats()`, `target()`, `aimAtBlock()`, `teleport()`,
`goToSurface()`, `setLook()`, `getBlock/setBlock`, `save()`, `reset()`, `forceQuality(i)`, `qualityChanges`,
`dig.begin/end`, `place.begin/end/once` — เทสต์เบราว์เซอร์ทั้งหมดขับผ่าน surface นี้ (ไม่ mock)

## Performance: ทำอะไรไปบ้าง

| เทคนิค | ที่ไหน | ผล |
|---|---|---|
| บันไดคุณภาพอัตโนมัติ (render distance + pixel ratio + chunk ops) | `src/perf/adaptive.ts` + `main.ts` | fps ตกต่อเนื่อง 2.5 วิ → ลดขั้น, fps เกิน 57 ต่อเนื่อง 6 วิ → ขึ้นขั้น (ไม่เกินค่าเริ่มต้น) |
| chunk streaming จำกัด ops ต่อเฟรม | `world.ts` (`maxChunkOpsPerFrame`) | ไม่มีเฟรม spike ตอนโหลด chunk ใหม่ |
| ไม่ allocate ในลูปเฟรม | `game.ts` (index loop แทน `callbacks.slice()`), `main.ts` (อ่าน fps ทุก 0.5 วิ ไม่ใช่ทุกเฟรม) | ไม่มี garbage ต่อเฟรม |
| chunk mesh ไม่ขยับ → ปิด matrix update | `world.ts` (`matrixAutoUpdate = false` + `updateMatrix()` ครั้งเดียว) | ตัดงาน matrix 137 ครั้ง/เฟรม |
| greedy meshing + texture atlas เดียว | `mesher.ts`, `atlas.ts` | 1 material ทั้งโลก, draw call = จำนวน chunk ที่เห็น |
| เปลี่ยน render distance แล้ว stream ทันที | `world.ts` (`update()` ตรวจว่า radius เปลี่ยน) | บันไดขึ้นขั้นกลับได้ผลแม้ยืนนิ่ง (เดิมรอเดินข้าม chunk) |
| ไม่ย้าย terrain gen ไป Web Worker | ตัดสินใจจากตัวเลขจริง (ดูด้านล่าง) | gen 0.28 ms/chunk = ถูกกว่า overhead ของ worker มาก; ที่แพงคือ meshing 5.89 ms ซึ่งคุมด้วย ops/เฟรมอยู่แล้ว |

## ผลการตรวจสอบ (วัดจริง ไม่ได้ประมาณ)

รันบน Lenovo Yoga 7i (Intel Core Ultra 7 258V, Intel Arc 140V, ANGLE/D3D11, WebGL 2.0),
Chrome ผ่าน CDP, viewport 1280x720:

| สิ่งที่วัด | ผล |
|---|---|
| `npm run typecheck` / `npm run build` | ผ่านทั้งคู่ ไม่มี type error เหลือ |
| smoke (node) รวม | 62 + 114 + 117 + 28 = **321 checks ผ่านทั้งหมด** |
| browser (Chrome จริง) รวม | 23 + 41 + 56 + **64** = **184 checks ผ่านทั้งหมด** |
| เทสต์ตัวเกม (`tests/game.browser.test.mjs`) | **64 checks ผ่านทั้งหมด** ทั้งบน `http://localhost:4173` และบน URL ที่ deploy แล้ว |
| โหลดหน้าแรก (deployed) | 1091 ms wall clock (446 ms จากเริ่มโมดูลถึงเล่นได้) — เกณฑ์ 5 วิ ผ่านสบาย |
| ขนาดที่โหลดจริง | index.html 1.8 KB gzip + bundle 192 KB gzip (three.js รวมอยู่) |
| fps บนเครื่องนี้ | 60.0 fps (ติด vsync) ทุก viewport/ทุกระดับคุณภาพ, ทั้งยืนนิ่งและเดิน |
| draw call / triangle | RD 6: 137 chunk, 50 draw calls, 23,762 triangles · RD 3: 81 chunk, 30 draws, 14,296 tris |
| ต้นทุนต่อ chunk (node) | generate 0.28 ms + mesh 5.89 ms = 6.17 ms/chunk (เฉลี่ย 256 quads) → 2 chunk/เฟรม = 12.3 ms จากงบ 16.7 ms |
| บันไดคุณภาพกับเครื่องช้ากว่า (CPU throttle 12x ผ่าน CDP) | เริ่มที่ high 26 fps → บันไดลดเอง high→medium @18.7 fps → low @41.3 → minimal @20 → นิ่งที่ minimal **50 fps** → ปลด throttle แล้วกลับมา high 60 fps เอง |
| ตรวจ mesh | ray ผ่าน frustum ทั้งจอ: 100% (มองลง), 97.5% (มุมใกล้พื้น), 66.9% (ขอบฟ้า) ตรงกับข้อมูลบล็อก; รูในภาพ 0.00% |

ตัวเลข fps ทั้งชุดอยู่ใน `test-output/perf-report.json` (สร้างด้วย `npm run perf:report`)

เทสต์เบราว์เซอร์ต้องมี server เสิร์ฟอยู่ (`npm run preview`) และตั้ง `PAGE_URL` ถ้าไม่ใช่ 4173
เทสต์ตัวเกมมี checklist ตรงตาม acceptance: โหลด < 5 วิ, คีย์บอร์ด+เมาส์เล่นได้จริง (เดิน/วิ่ง/กระโดด/หันกล้อง),
ขุด/วางด้วยปุ่มเมาส์จริง, save/load ผ่าน reload, ไม่มี error ใน console, fps >= 30

## Public API (สัญญา) — engine

```ts
import { createGame, Block, type BlockId } from './engine';

const game = createGame(canvas, { seed: 1337, renderDistance: 6 });

world.getBlock(x, y, z): BlockId          // 0 = AIR, อ่านนอกโลก/นอกช่วง y ได้คืน AIR
world.setBlock(x, y, z, id): void         // เขียนแล้ว mark chunk (และ chunk ข้างเคียงถ้าติดขอบ) ให้ remesh เอง
world.raycast(origin, direction, maxDist): RaycastHit | null
createGame(canvas, opts): Game            // { scene, camera, world, renderer, onFrame(cb), dispose(), ... }
```

`RaycastHit = { position: [x,y,z], normal: [x,y,z], blockId, distance }`
`position` เป็นพิกัด voxel (จำนวนเต็ม), `normal` คือหน้าที่ลำแสงเข้า (เป็น [0,0,0] ถ้าเริ่มในบล็อกทึบ)
raycast ข้ามน้ำ (liquid) ไปโดนของแข็งข้างหลังเสมอ (เหมือน Minecraft ที่เล็งน้ำไม่ได้)

`createGame` คืน `Game`:

| field | ความหมาย |
|---|---|
| `scene` | `THREE.Scene` (มี light/group ของ chunk อยู่แล้ว) |
| `camera` | `THREE.PerspectiveCamera` |
| `world` | `World` ตามสัญญาข้างบน |
| `renderer` | `THREE.WebGLRenderer` |
| `onFrame(cb: (dt:number)=>void)` | ลงทะเบียน callback คืน unsubscribe; **เรียกก่อน** chunk streaming และ render ในเฟรมถัดไป |
| `start()` / `stop()` | เปิด/หยุด loop (auto-start เป็นค่าเริ่มต้น) |
| `stats()` | `{ fps, frameMs, drawCalls, triangles, geometries, textures, programs, world }` |
| `dispose()` | หยุด loop, ถอด listener, คืน geometry/material ทั้งหมด |

`GameOptions`: `seed`, `renderDistance` (default 6), `maxChunkOpsPerFrame` (default 2),
`controls: 'spectator' | 'none'` (default spectator), `fov`, `near`, `far`, `startPosition`,
`fog`, `background`, `maxPixelRatio`, `autostart`, `worldMaterial`

`world.renderDistance` และ `world.maxChunkOpsPerFrame` เขียนใหม่ได้ตอน runtime (บันไดคุณภาพใช้อยู่)
— เปลี่ยนแล้วระบบ stream วงใหม่ให้เองในเฟรมถัดไป

### helper เสริมที่ใช้บ่อย (ไม่ใช่สัญญา fix แต่มีให้แล้ว)

- `world.heightAt(x, z)` — ความสูงพื้นผิว (`TerrainGenerator.heightAt`)
- `world.spawnPoint(x, z)` — `Vector3` เหนือพื้นผิว 1 บล็อก ใช้เป็นจุดเกิดผู้เล่น
- `world.stats()` — `{ seed, renderDistance, chunks, meshed, pending, builds, rebuilds, unloads, vertices, triangles, quads }`
- `world.buildPendingChunks(maxOps)` / `buildAllPending()` — สั่ง mesh เองได้ (ใช้ในเทสต์)
- `Block` / `BLOCKS` / `getBlockDef(id)` / `isSolid` / `isOpaque` / `isLiquid`
- `TerrainGenerator`, `buildChunkMeshData`, `SimplexNoise`, `fbm2`, `mulberry32`, `SpectatorController`

## บล็อกและหิน/ดิน

| id | ชื่อ | ค่าใน `BLOCKS[id]` |
|---|---|---|
| 0 | AIR | ไม่มีอะไรเลย |
| 1 | GRASS | solid, opaque, hardness 0.6 |
| 2 | DIRT | solid, opaque, hardness 0.5 |
| 3 | STONE | solid, opaque, hardness 1.5 |
| 4 | SAND | solid, opaque, hardness 0.4 |
| 5 | WATER | ไม่ solid, ไม่ opaque, liquid, alpha 0.72 |
| 6 | WOOD | solid, opaque, hardness 1.2 |
| 7 | LEAVES | solid, opaque, hardness 0.3 |

`BlockDef` มี `hardness` (วินาที) และ `alpha` เผื่อให้งานขุด/วางกับงานเรนเดอร์ใช้ต่อได้เลย

## โครงสร้าง

```
src/engine/
  index.ts     public API (ห้ามเปลี่ยนชื่อ export ในนี้)
  world.ts     chunk manager: getBlock/setBlock/raycast, queue การ mesh, load/unload, stats
  chunk.ts     Chunk 16x16x64 เก็บ Uint8Array (index = (y*16+z)*16+x)
  terrain.ts   TerrainGenerator: simplex fBm 2 มิติ + ทรี, SEA_LEVEL = 26, deterministic ตาม seed
  mesher.ts    greedy meshing 3 แกน -> positions/normals/uv/color(4)/indices
  atlas.ts     texture atlas 4x4 tile (64x64px) วาดด้วย canvas + material เดียว
  noise.ts     mulberry32, SimplexNoise 2D, fbm2, hash01
  game.ts      createGame: scene/camera/light/fog/loop/resize/stats
  cameraRig.ts SpectatorController (กล้องชั่วคราวสำหรับเดโม engine)
src/player/
  index.ts     public player exports
  player.ts    FirstPersonPlayer: ต่อ input/look/physics กับ game.onFrame
  physics.ts   gravity, walk/sprint, jump และ ground handling
  collision.ts swept axis-separated AABB ขนาด 0.6 x 1.8
  input.ts     WASD/arrow/Space/Shift และ remappable keymap
  look.ts      pointer lock, drag fallback และ pitch clamp +/-89 องศา
src/interaction/
  index.ts     public interaction exports (ใช้ต่อจาก engine API เท่านั้น)
  controller.ts ขุด (กดค้าง ตาม hardness 0.3-1.5 วิ) + วาง + กฎปฏิเสธทุกข้อ
  inventory.ts hotbar 9 ช่อง, stack 64, add/take/select/cycle + serialize
  diffs.ts     EditTracker: diff เทียบ terrain ที่ generate จาก seed, apply เข้า chunk ที่โหลดอยู่
  storage.ts   SaveStore: localStorage, ตรวจ version/seed, กันข้อมูลเสีย/โควตาเต็ม
  session.ts   InteractionSession: ประกอบทุกอย่าง + autosave 10 วิ + reset world + debug info
  player.ts    PlayerBody (เท้า + AABB 0.6x1.8) และ adapter ที่ห่อกล้อง/FirstPersonPlayer
  hud.ts       crosshair / progress bar / hotbar + ไอคอน / counts / debug F3 / toast / ปุ่ม reset
  highlight.ts กรอบเป้าบล็อก + แอนิเมชันตอนขุด
src/perf/
  adaptive.ts  AdaptiveQuality: บันไดคุณภาพ (renderDistance/pixelRatio/chunkOps) ล้วน ๆ ไม่แตะ DOM
src/main.ts         ตัวเกม (index.html): boot flow + ต่อทุกโมดูล + window.__GAME
src/engineDemo.ts   เดโม engine (engine.html) + window.__VOXEL
src/player-demo.ts  เดโม player (player.html) + window.__PLAYER
src/interactionDemo.ts เดโม interaction (interaction.html) + window.__VOXEL_INTERACTION
index.html     entry point ของตัวเกม
engine.html / player.html / interaction.html  entry point ของเดโมแต่ละชั้น
tests/         smoke (node) + browser (Chrome/CDP) ของทุกชั้น + perf report
docs/save-format.md  รูปแบบไฟล์ save: เก็บอะไรบ้างและโหลดกลับอย่างไร
```

## ค่าที่ใช้จริง

- chunk 16x16x64 (x, z, y) = 16,384 บล็อก/chunk, `CHUNK_HEIGHT = 64`
- render distance 6 chunk (แผนที่ chunk เป็นวงกลมรัศมี `d² <= R²+R` = 137 chunk) + เก็บเกินไว้อีก 1 วง (`unloadMargin`)
- mesh ต่อเฟรมสูงสุด `maxChunkOpsPerFrame` (default 2) → เฟรมไม่สะดุดตอนโหลด
- terrain: `heightAt` = simplex fBm (2 octave sets + ridge) ช่วงความสูงจริงประมาณ y 12-45, ระดับน้ำ 26
  ผิว: GRASS (หรือ SAND ถ้าสูง <= SEA_LEVEL+1), ใต้ผิว 3 บล็อกเป็น DIRT/SAND, ลึกลงไป STONE, y=0 เป็น STONE
  ต้นไม้: WOOD สูง 4-6 + ใบ LEAVES (มี margin 3 บล็อก ต้นที่คร่อมขอบ chunk จึงไม่ขาด)
- 1 material ต่อทั้งโลก (`MeshLambertMaterial` + vertex colors RGBA) → draw call = จำนวน chunk ที่เห็น
- greedy meshing รวม quad เฉพาะ face ที่ติดกันชนิดเดียวกัน → ลด quad ลง ~3-8 เท่า (16x16 slab 576 faces → 6 quads)
- บันไดคุณภาพ: `high` RD 6 / dpr 1.5 / 2 ops · `medium` RD 5 / dpr 1.25 / 1 op · `low` RD 4 / dpr 1.0 / 1 op · `minimal` RD 3 / dpr 0.85 / 1 op
  (ลดขั้นเมื่อ fps < 45 ต่อเนื่อง 2.5 วิ, ขึ้นขั้นเมื่อ fps > 57 ต่อเนื่อง 6 วิ, ไม่ขึ้นเกินค่าเริ่มต้น)

## Interaction: ขุด/วาง + hotbar/HUD + save/load

ชั้น interaction ใช้ **เฉพาะ** public API ของ engine (`world.getBlock`, `world.setBlock`, `world.raycast`)
ไม่แก้ engine

```ts
import { InteractionSession, createFirstPersonPlayerAdapter } from './interaction';

const player = new FirstPersonPlayer({ world: game.world, camera: game.camera, element: canvas });
const session = new InteractionSession({
  world: game.world,        // ต้องมี getChunk(cx, cz) ด้วย (World มีอยู่แล้ว)
  scene: game.scene,        // วาดกรอบเป้าบล็อก
  player: createFirstPersonPlayerAdapter(player), // ห่อ FirstPersonPlayer ของ src/player
  seed: 20260924,
  atlasCanvas: atlas.canvas, // ไอคอน hotbar
  hudOptions: { status: '...' },
});
game.onFrame((dt) => {
  player.update(dt);        // ของเดิม
  session.update(dt);       // ขุด/วาง/HUD/autosave/apply edit
});
// อินพุต: session.controller.beginDig()/endDig()/beginPlace()/endPlace(),
//         session.handleKeyDown(event) (1-9, F3), session.handleWheel(deltaY)
```

สร้าง `FirstPersonPlayer` ให้เสร็จ **ก่อน** สร้าง session (constructor ของมันเรียก `physics.settle()`
ให้ยืนบนผิวโลก) เพราะ session จะจำตำแหน่ง/มุมมองตอนนั้นไว้เป็นจุดเกิดของปุ่ม reset
ถ้าอยากขุด/วางด้วยกล้องแทนร่างกาย ใช้ `createCameraPlayerAdapter(camera)` ได้

- **ขุด**: กดคลิกซ้ายค้าง เป้าคือ raycast 5 บล็อก, progress = `dt * digSpeed / getBlockDef(id).hardness`
  (0.3 วิ ใบไม้ → 1.5 วิ หิน) ครบแล้วบล็อกเป็น AIR + ไอเทมเข้าช่องแรกที่รับได้ + ถ้าของเต็มจะแจ้งผ่าน `onInventoryFull`
  เปลี่ยนเป้า/ปล่อยเมาส์/เป้าหลุด → progress รีเซ็ตเป็น 0
- **วาง**: คลิกขวา วางที่ `hit.position + hit.normal` ปฏิเสธพร้อมเหตุผลเมื่อ: ไม่มีเป้า (`no-target`),
  ลำแสงเริ่มในบล็อก (`inside-block` — กันวางลอย), เลยขอบโลก (`out-of-world`), ช่องไม่ว่าง (`occupied`),
  ทับ AABB ผู้เล่น (`player-box`), มือว่าง (`empty-hand`) — วางสำเร็จจึงหักของ 1 ชิ้น
- **hotbar**: 9 ช่อง ปุ่ม 1-9 และ wheel, เริ่มต้นหญ้า/ดิน/หิน/ทราย/ไม้ อย่างละ 64, stack 64
- **HUD**: crosshair, progress bar, เลขช่องที่เลือก, จำนวนของทุกช่อง, toast, debug overlay (F3) =
  fps/frame time, พิกัด+มุมมอง, chunk ที่โหลด/meshed/pending, เป้าปัจจุบัน, จำนวน edit, เวลาที่เซฟล่าสุด
  ทั้ง overlay เป็น `pointer-events: none` ยกเว้นปุ่ม reset → ไม่บังการเล่น
- **save/load**: diff จาก terrain + ตำแหน่งผู้เล่น + hotbar ลง localStorage ทุก 10 วิ (และตอนปิด/ซ่อนแท็บ)
  โหลดกลับอัตโนมัติเมื่อเปิดหน้าใหม่ กดปุ่ม reset world สองครั้งเพื่อคืนโลกเป็น terrain ตั้งต้น
  รายละเอียดรูปแบบไฟล์: [`docs/save-format.md`](docs/save-format.md)

## ข้อจำกัดที่รู้อยู่ (ตั้งใจให้เรียบง่าย)

- ยังไม่มี ambient occlusion / แสงจากบล็อก — ใช้สี vertex ต่อหน้า (บนสว่าง ด้านกลาง ล่างมืด)
- greedy meshing รวม quad ใหญ่แล้วยืด UV ของ tile นั้นให้เต็ม quad (nearest filter) — texture จึงดูเป็นก้อนใหญ่
  ไม่ repeat ตามจำนวนบล็อก (แก้ได้ด้วย data-array texture + shader patch ถ้าต้องการเป๊ะ)
- น้ำจมอยู่ใน mesh เดียวกับของแข็ง และใช้ alpha จาก vertex color (0.72) ไม่มีการ sort ใบน้ำแยก
- save เก็บเฉพาะ diff จาก terrain + ตำแหน่งผู้เล่น + hotbar (ดู `docs/save-format.md`) — อยู่แค่ใน
  localStorage ของเบราว์เซอร์นั้น ไม่มี sync ข้ามเครื่อง/หลายโปรไฟล์ และผู้เล่นที่ถูกวางทับจะไม่ถูกดันออก
  (ระบบวางปฏิเสธไม่ให้เกิดตั้งแต่แรก)
- ต้องมี WebGL2 (three.js r186 ไม่รองรับ WebGL1 แล้ว) — เบราว์เซอร์รุ่นเก่ามากจะเล่นไม่ได้
- บันไดคุณภาพ **ไม่ขึ้นเกิน render distance เริ่มต้น (6)** โดยตั้งใจ — เครื่องแรงจะได้ภาพเท่ากันทุกเครื่อง
  และการขึ้นขั้นใช้เวลานานกว่าการลดขั้น (6 วิ vs 2.5 วิ) เพื่อไม่ให้ภาพกระพริบไปมา
- บันไดตัดสินใจจาก fps ของ `requestAnimationFrame` ซึ่งติด vsync ที่ 60 → เครื่องที่ทำได้เกิน 60 fps
  จะไม่มีทางลดขั้น (ถูกต้องตามพฤติกรรมที่ต้องการ) การพิสูจน์จึงใช้ CPU throttle แทน (ดูตารางด้านบน)
- เทสต์เบราว์เซอร์รันบน **Chrome (Chromium) เท่านั้นบนเครื่องนี้**: Firefox ไม่ได้ติดตั้ง และ Safari
  รันบน Windows ไม่ได้ → checklist บน Firefox/Safari ยังไม่ได้ยืนยัน (โค้ดใช้ API มาตรฐาน:
  pointer lock + drag fallback, WebGL2, localStorage, ไม่มี vendor-specific)
- ปุ่ม HUD กดได้หลัง ESC เท่านั้น (ข้อจำกัดของ pointer lock ไม่ใช่บั๊ก)

## งานที่เหลือต่อจากนี้

- ยืนยัน acceptance บน Firefox และ Safari บนเครื่องที่ติดตั้งได้ (โค้ดพร้อม แต่ยังไม่มีหลักฐาน)
- ถ้าต้องการภาพเนียนกว่านี้: data-array texture (แก้ UV repeat ของ greedy meshing) และ ambient occlusion
- ถ้าจะเล่นหลายคน/เซฟขึ้น cloud: ต้องมี backend (ตอนนี้เป็น static ล้วน)
