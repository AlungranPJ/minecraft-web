# project_summary — minecraft-web (voxel engine + player)

อัปเดตล่าสุด: 2026-09-24 · สถานะ: **engine, player controller (`t_fe06d2f3`) และ interaction/UI/save (`t_ff52a7e8`) เสร็จและผ่านเทสต์ทั้งหมด**

## งานนี้คืออะไร

Kanban task `t_26edfe0f` (ลูกของ root "สร้าง minecraft" `t_ea921675`) สร้างแกนกลาง voxel engine
บนเบราว์เซอร์ (static, ไม่มี backend) ด้วย Three.js + Vite/TypeScript

ที่ตั้งโปรเจกต์: `D:\HermesAgentFolder\minecraft-web` (อยู่ในรีโปHermes ไม่ใช่ใน scratch workspace
เพราะ task ลูกอีก 2 ตัวต้อง import โมดูล `src/engine/index.ts` ต่อ)

## สถานะปัจจุบัน (ทำอะไรเสร็จแล้ว)

- [x] Vite + Three.js (three 0.186, vite 8, typescript 7) รัน `npm run dev` และ build static ได้
- [x] chunk 16x16x64, Uint8Array, greedy meshing -> BufferGeometry, texture atlas เดียว/1 material
- [x] terrain noise (simplex fBm + ridge + trees), 7 ชนิดบล็อก (grass/dirt/stone/sand/water/wood/leaves)
- [x] chunk manager: render distance 6, load/unload ตามระยะ, mesh จำกัดต่อเฟรม (default 2)
- [x] public API ตามสัญญา (getBlock/setBlock/raycast/createGame) ครบและนิ่งแล้ว
- [x] player controller ใน `src/player/`: WASD/Shift/Space, remappable keymap, pointer lock + ESC, pitch +/-89, physics และ swept AABB collision
- [x] first person demo `/player.html` และ browser acceptance test
- [x] เทสต์ engine: node smoke 62 checks + browser 23 checks — ผ่านหมด
- [x] เทสต์ player: node smoke 114 checks + browser 41 checks — ผ่านหมด
- [x] README + player docs + ภาพประกอบ (docs/screenshot-*.png)
- [x] interaction lane (`src/interaction/`): ขุด (กดค้าง ตาม hardness) / วาง (ปฏิเสธ 6 กรณี รวมทับตัวเอง) /
      hotbar 9 ช่อง (1-9 + wheel, ไอคอนจาก atlas) / HUD (crosshair, progress bar, counts, debug F3, toast, ปุ่ม reset) /
      save-load diff จาก terrain + ตำแหน่งผู้เล่น + hotbar ลง localStorage (autosave 10 วิ + ตอนปิดแท็บ)
- [x] หน้าเดโม `interaction.html` (`window.__VOXEL_INTERACTION`) และ adapter ต่อกับ `FirstPersonPlayer` จริง
- [x] เอกสาร `docs/save-format.md` (ไฟล์ save เก็บอะไรบ้าง/how-to-load)
- [x] เทสต์ interaction: node smoke 117 checks + browser 56 checks (เมาส์/คีย์บอร์ด/wheel จริง, reload, reset) — ผ่านหมด, รันซ้ำ 3 รอบไม่ flake

## คำสั่งที่ใช้ตรวจซ้ำ (ทำแล้วทั้งหมด ได้ผลตามนี้)

```bash
cd /d/HermesAgentFolder/minecraft-web
npm run typecheck                       # ผ่าน
npm run build                           # ผ่าน (dist/ รวม index, player และ interaction)
npm run test:smoke                      # 62 passed, 0 failed
npm run test:player                     # 114 passed, 0 failed
npm run preview                         # serves 4173 (background)
node tests/browser.test.mjs              # 23 passed, 0 failed
node tests/player.browser.test.mjs       # 41 passed, 0 failed
npm run test:interaction                 # 117 passed, 0 failed
node tests/interaction.browser.test.mjs  # 56 passed, 0 failed (~40 วิ เพราะรอ autosave จริง 10 วิ)
```

ตัวเลขที่วัดได้จริง (Intel Arc 140V / ANGLE D3D11 / WebGL2, 1280x720): **60.0 fps** (16.7 ms/เฟรม ติด vsync),
137 chunk meshed, 53-55 draw calls, chunk ในหน่วยความจำคงที่ **145** ตลอดการเดิน 960 บล็อก (unload สะสม 814),
mesh ครบ (มองลงจากฟ้า 100% ของ ray ที่ยิงผ่าน frustum โดนพื้น, ตรวจ magenta background แล้ว 0.00% รู)

## บั๊กใหญ่ที่เจอและแก้ไปแล้ว (อย่าลืม)

`src/engine/mesher.ts` — ใน greedy loop ตอน emit quad **ลืมเขียน `px[u] = i; px[v] = j;`**
ทำให้ corner ของ quad ใช้ค่า i/j ค้างจากรอบ mask (64/16) → quad ทุกอันถูกวางผิดที่
อาการที่เห็น: โลกเรนเดอร์เป็นเกล็ดลอย ๆ มีรูโหว่กลางจอ แต่ `stats()` บอก 137/137 meshed ปกติ

บทเรียน: จำนวน quad/face ที่ถูกต้อง **ไม่พอ** ต้องเทสต์ว่าพิกัด vertex อยู่ในกล่อง chunk
ตอนนี้มี check กันไว้แล้วทั้ง `slab vertices stay inside the chunk box`, `terrain chunk vertices stay inside their chunk box`
และ pixel-level `no background pixels show through the ground` ในเทสต์เบราว์เซอร์

`src/interaction/session.ts` — **autosave ไม่เคยทำงานเลย**: ตั้งใจให้ `autosaveMs` เป็น ms (10,000)
แต่เทียบกับ `autosaveElapsed` ที่เป็นวินาที (`>= 10000` วินาที = 2.8 ชั่วโมง) แก้เป็น `autosaveElapsed * 1000 >= autosaveMs`
เทสต์ browser จับได้เพราะรอ 11 วิจริงแล้วไฟล์ต้องถูกเขียนใหม่ (ไม่ใช่เชื่อค่าที่ API คืน)

`src/interaction/diffs.ts` + `storage.ts` — **หลุมที่ขุดหายหลัง reload**: ตัวกรองข้อมูลตอนโหลดใช้ `id <= 0` ทิ้ง
→ edit ที่เป็น AIR (ผลจากการขุด ซึ่งเป็นเคสหลักของเกม) ถูกลบทิ้งทั้งกระดาน ต้องเป็น `id < 0 || id >= BLOCKS.length`
(และ `Block.AIR = 0` ต้องผ่าน) — มีเทสต์คุมทั้ง node (`a voxel dug out to air survives normalisation`, `the dug hole is back after reload`)

`src/interaction/controller.ts` — **วางบล็อกแล้วไม่ขึ้นใน save**: hook `onPlace` ถูกเรียกเฉพาะใน `updatePlace()`
(เส้นทางที่ผู้เล่นกดเมาส์ค้าง) แต่ `tryPlace()` ที่ host/test เรียกตรงไม่ยิง hook → edit ไม่ถูกบันทึก ย้ายการยิง hook ไปใน `tryPlace()`
บทเรียน: hook ของ "การเขียนโลก" ต้องอยู่ในฟังก์ชันที่เขียนจริงจุดเดียว ไม่ใช่ในตัวเรียก

## กับดักเวลาแก้ต่อ

- **ลำดับ in `game.ts`**: `controls.update(dt)` -> `onFrame` callbacks -> `world.update(dt, camera.position)` -> `renderer.render`
  ถ้าย้าย callback ไปหลัง render ตัว player controller จะตามหลังหนึ่งเฟรม และ streaming จะตามตำแหน่งเก่า
- **mesh position**: geometry เก็บพิกัด local (0..16) และ mesh ตั้ง `position = (originX, 0, originZ)` ห้าม push พิกัด world ลง geometry
- **ห้ามเปลี่ยนชื่อ** `world.getBlock/setBlock/raycast`, `createGame` (task ลูก `t_fe06d2f3`, `t_ff52a7e8` อ้างอยู่)
- **น้ำ**: raycast ข้าม liquid เสมอ, น้ำใช้ alpha จาก vertex color (material มี `transparent: true`) — ถ้าใครแก้ material ต้องคง `vertexColors` + color itemSize 4
- **three 0.186**: ต้องมี attribute `color` แบบ itemSize 4 และ `material.vertexColors = true` จึงได้ USE_COLOR_ALPHA (ยืนยันจาก build/three.module.js)
- **camera far** ผูกกับ `renderDistance` (`renderDistance*16*1.6`, ขั้นต่ำ 120) — ถ้าเพิ่ม render distance ต้องปล่อยให้ far โตตาม ไม่งั้น chunk ไกลถูก clip
- ถ้าเพิ่ม/แก้ atlas ต้องคง `NearestFilter` + `generateMipmaps = false` (atlas 64x64 ไม่มี padding กัน bleed)
- สกรีนช็อต/เทสต์เขียนลง `test-output/` (gitignored); เทสต์เบราว์เซอร์หา Chrome จาก `CHROME_PATH` หรือ path มาตรฐาน
- **interaction + save**: `InteractionSession.update(dt)` ต้องถูกเรียกทุกเฟรม (จาก `game.onFrame`) เพราะเป็นที่
  apply edit ลง chunk, autosave, HUD และ `controller.update` — ถ้าลืมเรียก โลกที่โหลดมาจะไม่มี edit ของผู้เล่น
- **apply edit ต้องรันก่อน mesh**: ถ้าขยับไปเรียกหลัง `world.update()` chunk ที่เพิ่งสตรีมเข้าจะถูก mesh ด้วย terrain ดิบ
  แล้วเห็นหลุมหายไปหนึ่งเฟรม (ปกติ onFrame รันก่อน streaming อยู่แล้ว)
- **hotbar `add()` เติมสแต็กเดิมก่อนเสมอ**: ขุดหญ้าตอนมีหญ้าเหลือ 63 ในช่อง 1 → ของใหม่ไปช่อง 1 (ไม่ใช่ช่องว่างถัดไป)
  เทสต์ที่คาดว่า "เข้า slot ว่าง" จะพังทันที (เจอมาแล้วในเทสต์เบราว์เซอร์)
- **`resetWorld()` ใช้จุดเกิดที่จำตอนสร้าง session** (ก่อน restore) — ต้องสร้าง `FirstPersonPlayer` ให้ settle เสร็จก่อนสร้าง session
- **dig progress รีเซ็ตเมื่อเปลี่ยน voxel/blockId**: อย่าเทียบแค่ตำแหน่ง เพราะบล็อกถูกเปลี่ยนชนิดได้
- **`dt` ที่ controller ถูก clamp ที่ 0.1 วิ**: เฟรมที่ค้างนาน (สลับแท็บ) จะไม่ให้ progress การขุดทั้งก้อน
- **ปุ่มขวากดค้างวางซ้ำทุก 0.22 วิ (`placeDelay`)**: เทสต์/โค้ดที่กดค้าง ~120 ms แล้วคาดว่า "วางครั้งเดียว" จะ flake เมื่อเฟรมสะดุด
  (เจอจริง: วาง 2 ครั้ง แล้วบล็อกโผล่ผิดที่) — กดสั้นกว่า repeat มาก, รอจนเฟรมนิ่งก่อนกด และวัดผลเป็น delta ของ count ไม่ใช่ค่าคงที่
- **การขุดในเทสต์ต้อง "กดค้างจนบล็อกหาย"** (poll `getBlock(...) === 0`) ไม่ใช่กดค้างตามเวลาคงที่ ไม่งั้นเฟรมสะดุดแล้วเทสต์ตกแบบสุ่ม
- **ปุ่ม reset เป็นสองจังหวะ** (armed 3 วิแล้วต้องคลิกซ้ำ) — เทสต์ต้องคลิกสองครั้ง ไม่งั้นไม่เกิดอะไรขึ้น

## งานที่เหลือในสายนี้ (ไม่ใช่งานของ task นี้)

- ~~`t_ff52a7e8` ขุด/วางบล็อก + hotbar/HUD + save/load localStorage~~ → เสร็จแล้วใน `src/interaction/` (ดู README หัวข้อ Interaction)
- `t_5f9c7bb5` รวมระบบ (ต่อ interaction เข้ากับ `FirstPersonPlayer` ในหน้าเดียว), performance, deploy และ acceptance ของเกมรวม
- `t_ea921675` root "สร้าง minecraft / เล่นได้บนเว็บ" จะตื่นเมื่อลูกครบทุกตัว
