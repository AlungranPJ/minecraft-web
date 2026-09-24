# project_summary — minecraft-web (voxel game เล่นได้บนเว็บ)

อัปเดตล่าสุด: 2026-09-24 · สถานะ: **เสร็จครบทุก lane** — engine (`t_26edfe0f`), player (`t_fe06d2f3`),
interaction/UI/save (`t_ff52a7e8`) และ integration/perf/deploy (`t_5f9c7bb5`) ผ่านเทสต์ทั้งหมด

- **เล่นได้จริง:** https://alungranpj.github.io/minecraft-web/
- **repo:** https://github.com/AlungranPJ/minecraft-web — branch `main` = โค้ด, branch `gh-pages` = build ที่ deploy
- ที่ตั้งโปรเจกต์: `D:\HermesAgentFolder\minecraft-web`

## งานนี้คืออะไร

เกม voxel แบบ Minecraft-like ที่รันบนเบราว์เซอร์แบบ static ล้วน (ไม่มี backend) ด้วย Three.js + Vite/TypeScript
ประกอบจาก 3 โมดูล (engine + player + interaction) รวมเข้าเป็นหน้าเดียวใน `index.html` (`src/main.ts`)

## สถานะปัจจุบัน (ทำอะไรเสร็จแล้ว)

- [x] Vite + Three.js (three 0.186, vite 8, typescript 7) build static ได้, `base: './'` ย้ายที่วางได้
- [x] chunk 16x16x64, Uint8Array, greedy meshing -> BufferGeometry, texture atlas เดียว/1 material
- [x] terrain noise (simplex fBm + ridge + trees), 7 ชนิดบล็อก, render distance 6 (137 chunk)
- [x] public API ตามสัญญา (getBlock/setBlock/raycast/createGame) ครบและนิ่ง (task ลูกอ้างอิงอยู่)
- [x] player controller `src/player/`: WASD/Shift/Space, pointer lock + ESC, drag fallback, pitch +/-89, swept AABB
- [x] interaction `src/interaction/`: ขุด/วาง (ปฏิเสธ 6 กรณี) / hotbar 9 ช่อง / HUD + debug F3 / save-load localStorage
- [x] **integration (`src/main.ts`)**: boot flow loading screen -> "คลิกเพื่อเล่น" -> เกม, ต่อ player + session + input ครบ
- [x] **performance**: `src/perf/adaptive.ts` (บันไดคุณภาพ) + ตัด allocation ในลูป + ปิด matrix update ของ chunk mesh
- [x] **deploy**: GitHub Pages (gh-pages branch) เปิดเล่นได้จาก URL จริง, เทสต์ acceptance รันบน URL นั้นผ่าน 64/64
- [x] **เทสต์ตัวเกม** `tests/game.browser.test.mjs` 64 checks (โหลด < 5 วิ, คีย์บอร์ด+เมาส์, ขุด/วาง, save/load, fps, ไม่มี console error)
- [x] **perf report** `tests/perf.browser.mjs` -> `test-output/perf-report.json` (fps ทุกระดับคุณภาพ + CPU throttle 12x)
- [x] README อัปเดตครบ (วิธีเล่นทุกปุ่ม, dev, deploy, ผลวัด fps, ข้อจำกัดที่รู้อยู่)
- [x] เอกสาร `docs/save-format.md`, `docs/player-controller.md`, ภาพ `docs/screenshot-*.png`

## คำสั่งที่ใช้ตรวจซ้ำ (ทำแล้วทั้งหมด ได้ผลตามนี้)

```bash
cd /d/HermesAgentFolder/minecraft-web
npm run typecheck                        # ผ่าน (tsc --noEmit เงียบ)
npm run build                            # ผ่าน -> dist/ (index, engine, player, interaction)

npm run test:smoke                       # 62 passed, 0 failed
npm run test:player                      # 114 passed, 0 failed
npm run test:interaction                 # 117 passed, 0 failed
npm run test:perf                        # 28 passed, 0 failed

npm run preview &                        # serves dist/ ที่ 4173
node tests/browser.test.mjs              # 23 passed, 0 failed   (engine.html)
node tests/player.browser.test.mjs       # 41 passed, 0 failed   (player.html)
node tests/interaction.browser.test.mjs  # 56 passed, 0 failed   (interaction.html, ~40 วิ รอ autosave จริง)
node tests/game.browser.test.mjs         # 64 passed, 0 failed   (index.html = ตัวเกม)
node tests/perf.browser.mjs              # เขียน test-output/perf-report.json

# checklist เดียวกันบนเว็บที่ deploy แล้ว
PAGE_URL=https://alungranpj.github.io/minecraft-web/ node tests/game.browser.test.mjs   # 64 passed, 0 failed
```

## ตัวเลขที่วัดได้จริง (Intel Arc 140V / ANGLE D3D11 / WebGL2)

| สิ่งที่วัด | ผล |
|---|---|
| fps บนเครื่องนี้ | 60.0 fps (ติด vsync) ทุก viewport (1280x720, 1920x1080) ทุกระดับคุณภาพ ทั้งยืนนิ่งและเดิน |
| RD 6 | 137 chunk, 50 draw calls, 23,762 triangles |
| RD 3 (minimal) | 81 chunk, 30 draw calls, 14,296 triangles, buffer 1088x612 (dpr 0.85) |
| ต้นทุนต่อ chunk (node) | generate 0.28 ms + mesh 5.89 ms = **6.17 ms/chunk** → 2 chunk/เฟรม = 12.3 ms จากงบ 16.7 ms |
| บันไดคุณภาพ (CPU throttle 12x) | เริ่ม high 26 fps → ลดเอง high→medium @18.7 → low @41.3 → minimal @20 → นิ่งที่ minimal **50 fps** → ปลด throttle กลับ high 60 fps |
| โหลดหน้าแรก (deployed) | 1091 ms wall clock / 446 ms จากเริ่มโมดูลถึงเล่นได้ |
| ขนาดที่โหลด | index.html 1.8 KB gzip + bundle 192 KB gzip (three รวม) |
| mesh ครบ | ray ผ่าน frustum: 100% (มองลง) / 97.5% (มุมใกล้พื้น) / 66.9% (ขอบฟ้า), รู 0.00% |
| เทสต์รวม | node 321 checks + browser 184 checks ผ่านหมด |

## บั๊กใหญ่ที่เจอและแก้ไปแล้ว (อย่าลืม)

`src/engine/mesher.ts` — ใน greedy loop ตอน emit quad **ลืมเขียน `px[u] = i; px[v] = j;`**
ทำให้ corner ของ quad ใช้ค่า i/j ค้างจากรอบ mask → quad ทุกอันถูกวางผิดที่
อาการ: โลกเรนเดอร์เป็นเกล็ดลอย ๆ มีรูโหว่กลางจอ แต่ `stats()` บอก 137/137 meshed ปกติ
บทเรียน: จำนวน quad ที่ถูกต้อง **ไม่พอ** ต้องเทสต์ว่าพิกัด vertex อยู่ในกล่อง chunk + pixel-level

`src/interaction/session.ts` — autosave ไม่เคยทำงาน: `autosaveMs` เป็น ms แต่เทียบกับวินาที → แก้เป็น `autosaveElapsed * 1000 >= autosaveMs`

`src/interaction/diffs.ts` + `storage.ts` — หลุมที่ขุดหายหลัง reload: ตัวกรองตอนโหลดใช้ `id <= 0` ทิ้ง edit ที่เป็น AIR
ต้องเป็น `id < 0 || id >= BLOCKS.length` (Block.AIR = 0 ต้องผ่าน)

`src/interaction/controller.ts` — วางบล็อกแล้วไม่ขึ้นใน save: hook `onPlace` อยู่ใน `updatePlace()` แต่ `tryPlace()`
ที่เรียกตรงไม่ยิง hook → ย้าย hook ไปใน `tryPlace()` (hook ของการเขียนโลกต้องอยู่ในฟังก์ชันที่เขียนจริงจุดเดียว)

`src/engine/world.ts` (แก้ในงานนี้) — `loadAround()` เดิมเรียกเฉพาะเมื่อ chunk ของกล้องเปลี่ยน →
**เพิ่ม render distance ตอนยืนนิ่งไม่สตรีมอะไรเลย** จนกว่าจะเดิน (บันไดคุณภาพขึ้นขั้นกลับจะไม่เห็นผล)
แก้: `update()` เช็ค `wantedRadius !== renderDistance` แล้วโหลดวงใหม่ทันที + floor ค่า radius ใน `getWantedOffsets()`

## กับดักเวลาแก้ต่อ (รวมของใหม่จากงาน integration)

- **ลำดับใน `game.ts`**: `controls.update(dt)` -> `onFrame` callbacks -> `world.update(dt, camera.position)` -> render
  callback ต้องอยู่ก่อน streaming เสมอ (player update + session update อยู่ใน onFrame เดียวกัน, player ก่อน session)
- **pointer lock กลืน mouse event ทั้งหมด**: ตอนล็อกอยู่ เบราว์เซอร์ส่ง event ไปที่ canvas ที่ล็อก ไม่ว่าเมาส์อยู่ไหน
  → ปุ่มบน HUD (Reset world) กดไม่ได้จนกว่าจะ ESC (`document.exitPointerLock()`)
  เทสต์ที่คลิกปุ่ม HUD ต้องปลดล็อกก่อน ไม่งั้นคลิกไปโดน canvas เงียบ ๆ
- **เทสต์ที่ pointer lock เปิดอยู่: `page.mouse.move()` = การหันกล้อง** → ต้อง `mouse.move()` ให้อยู่ที่เดิม **ก่อน** `aimAtBlock()`
  และห้ามขยับเมาส์หลังจากนั้น (ไม่งั้นเป้าเลื่อน) — helper `look()` ใน `tests/game.browser.test.mjs` ทำแบบนี้
- **ผู้เล่นมีแรงโน้มถ่วง**: ขุดบล็อกใต้เท้าตัวเอง = ตกลงไปในหลุม แล้ววางกลับไม่ได้ (ถูกปฏิเสธ `player-box`)
  เทสต์ต้องยืนบนพื้นแข็งแล้วขุดคอลัมน์ข้าง ๆ (demo interaction เก่าใช้ rig บิน จึงไม่เจอปัญหานี้)
- **`pagehide`/`beforeunload` เขียน save**: ออกจาก index.html แล้วมัน save ทันที → เทสต์ที่อยากเริ่มจากศูนย์ต้อง
  `localStorage.clear()` จากหน้าที่ไม่มี session (เช่น `engine.html`) ก่อน ไม่งั้น boot ถัดไปจะ restore
- **Escape สังเคราะห์ใน headless Chrome ไม่ปลด pointer lock** (เบราว์เซอร์ถือ shortcut นี้เอง) → ใช้ `document.exitPointerLock()`
- **`gh-pages` push = เปิด GitHub Pages ให้เอง** (build_type legacy, source gh-pages/root) — ยิง Pages API ซ้ำจะได้ 409 "already enabled"
  และต้องมี `.nojekyll` ใน branch นั้น
- **ห้ามเปลี่ยนชื่อ** `world.getBlock/setBlock/raycast`, `createGame` (task ลูกและเทสต์อ้างอยู่)
- **mesh position**: geometry เก็บพิกัด local (0..16) + `mesh.position = (originX, 0, originZ)`; mesh ตั้ง `matrixAutoUpdate = false`
  แล้ว **ต้องเรียก `updateMatrix()` หลังตั้ง position** ไม่งั้น mesh ไปกองที่ origin
- **น้ำ**: raycast ข้าม liquid, น้ำใช้ alpha จาก vertex color (itemSize 4 + `material.vertexColors`)
- **camera far** ผูกกับ `renderDistance` ตอน `createGame` — เปลี่ยน RD ตอน runtime แล้ว far ไม่เปลี่ยน (บันไดลด RD จึงไม่ถูก clip
  แต่ถ้าอนาคตอยากเพิ่ม RD เกินค่าเริ่มต้น ต้องแก้ far ด้วย)
- **`InteractionSession` ต้องถูกสร้างหลัง `FirstPersonPlayer`** (constructor เรียก `physics.settle()`) เพราะ session
  จำตำแหน่ง/มุมมองตอนนั้นเป็นจุดเกิดของปุ่ม reset
- **hotbar `add()` เติมสแต็กเดิมก่อนเสมอ** — เทสต์ที่คาดว่า "เข้า slot ว่าง" จะพัง (เจอมาแล้ว)
- **ปุ่มขวากดค้างวางซ้ำทุก 0.22 วิ** — กดสั้นกว่า repeat มาก, รอเฟรมนิ่งก่อนกด, วัดผลเป็น delta ของ count
- **การขุดในเทสต์ต้อง "กดค้างจนบล็อกหาย"** (poll `getBlock(...) === 0`) ไม่ใช่กดค้างตามเวลาคงที่
- **ปุ่ม reset เป็นสองจังหวะ** (armed 3 วิ) — เทสต์ต้องคลิกสองครั้ง
- สกรีนช็อต/เทสต์เขียนลง `test-output/` (gitignored); เทสต์เบราว์เซอร์หา Chrome จาก `CHROME_PATH` หรือ path มาตรฐาน
  (เครื่องนี้ไม่มี Firefox, Safari รันบน Windows ไม่ได้ → acceptance ยังยืนยันได้แค่ Chromium)

## งานที่เหลือในสายนี้

- ทุก task ลูกของ root `t_ea921675` ("สร้าง minecraft / เล่นได้บนเว็บ") เสร็จแล้ว → root ตื่นได้
- ยังไม่มีหลักฐาน acceptance บน Firefox/Safari (ไม่มีเบราว์เซอร์ให้รันบนเครื่องนี้) — โค้ดใช้ API มาตรฐานล้วน
- ต่อยอดได้: data-array texture + ambient occlusion (ภาพเนียนขึ้น), backend ถ้าจะเล่นหลายคน/sync save
