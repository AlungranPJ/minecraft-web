# รูปแบบไฟล์ save (interaction lane · task t_ff52a7e8)

ไฟล์เดียวต่อ seed เก็บใน `localStorage` คีย์ `minecraft-web:world:<seed>`
(เช่น `minecraft-web:world:20260924`) — เขียนโดย `src/interaction/storage.ts`
(`SaveStore`) และประกอบร่างโดย `InteractionSession.snapshot()`

## ทำไมเก็บเป็น diff

โลกทั้งใบ **สร้างซ้ำได้เสมอจาก seed** (`TerrainGenerator` เป็น deterministic)
ดังนั้นไม่ต้องเก็บ 16,384 บล็อกต่อ chunk เก็บแค่ "บล็อกที่ผู้เล่นแก้" เทียบกับ terrain ต้นฉบับ
ผลคือไฟล์เล็กมาก (ปกติ < 5 KB) และไม่โตขึ้นเมื่อผู้เล่นเดินไปไกล ๆ

การเทียบต้นฉบับทำได้โดยไม่ต้องโหลดโลก: `EditTracker` สร้าง `TerrainGenerator(seed)` ของตัวเอง
(มี `terrainCache` 512 chunk) แล้วถามค่าที่ generate ได้ที่พิกัดนั้น → ถ้าค่าที่เขียน "เท่ากับต้นฉบับ"
entry นั้นถูกลบทิ้งทันที (`record()`), และการขุดแล้วถมกลับที่เดิมจึงไม่ทิ้งร่องรอยในไฟล์ save

## โครงสร้างเอกสาร (version 1)

```json
{
  "version": 1,
  "seed": 20260924,
  "savedAt": 1790245109858,
  "player": { "x": 0.5, "y": 34, "z": 19.5, "yaw": -1.5707, "pitch": -1.3326 },
  "hotbar": {
    "selected": 0,
    "slots": [
      { "id": 1, "count": 63 },
      { "id": 2, "count": 64 },
      null,
      null, null, null, null, null, null
    ]
  },
  "edits": [
    { "x": 0, "y": 31, "z": 20, "id": 0 },
    { "x": 2, "y": 32, "z": 19, "id": 1 }
  ]
}
```

| ฟิลด์ | เก็บอะไร | หน่วย / หมายเหตุ |
|---|---|---|
| `version` | เวอร์ชันรูปแบบไฟล์ | ปัจจุบัน `1` (`SAVE_VERSION`) — คนละเวอร์ชันจะถูกทิ้ง ไม่ throw |
| `seed` | seed ของโลก | ตรงกับ `createGame({ seed })`; คีย์ localStorage ก็ผูกกับ seed นี้ |
| `savedAt` | เวลาที่เซฟ | epoch ms (`Date.now()`), ใช้โชว์ "saved 12s ago" ใน HUD |
| `player.x/y/z` | **ตำแหน่งเท้า**ของผู้เล่น | บล็อก, ทศนิยม; `y` คือเท้าไม่ใช่ตา (ตา = `y + 1.62`) |
| `player.yaw` | หันซ้าย/ขวา | เรเดียน, รอบแกน Y (0 = มองไปทาง -Z) |
| `player.pitch` | ก้ม/เงย | เรเดียน, ถูก clamp ±89° (≈ ±1.5533) |
| `hotbar.selected` | ช่องที่เลือกอยู่ | 0-8 (ช่อง 1-9 บนจอ) |
| `hotbar.slots` | ของใน 9 ช่อง | `[{id, count} | null]`, `count` 1-64 (`MAX_STACK`), `id` = BlockId |
| `edits[]` | บล็อกที่ผู้เล่นแก้ | `{x, y, z, id}` เป็น**ค่าสุดท้าย**ที่โลกถืออยู่ ไม่ใช่ log การเปลี่ยนแปลง |

`id` เป็น BlockId ตาม `src/engine/blocks.ts`: `0 = AIR` (แปลว่า "ขุดทิ้ง"), 1 grass, 2 dirt,
3 stone, 4 sand, 5 water, 6 wood, 7 leaves — **ค่าว่าง 0 ถูกเก็บจริง** (ถ้ากรอง `id <= 0` ทิ้ง
หลุมที่ขุดจะกลับมาหลัง reload ซึ่งเป็นบั๊กที่เจอและแก้แล้วในเทสต์)

## สิ่งที่ **ไม่** เก็บ (ตั้งใจ)

- บล็อกที่ไม่ได้แก้ (สร้างใหม่จาก seed ได้)
- ค่าต้นฉบับของบล็อกที่แก้ (คำนวณจาก `TerrainGenerator` ตอนโหลดได้เลย)
- สถานะชั่วคราว: dig progress, target, กล้อง FOV, fps, chunk ที่โหลดอยู่
- หลายโลกพร้อมกัน: 1 seed = 1 ไฟล์ (คีย์มี seed อยู่แล้ว) — เปลี่ยน seed คือคนละคีย์ ไม่ทับกัน

## เขียน / อ่านเมื่อไร

| จังหวะ | ทำอะไร | โค้ด |
|---|---|---|
| ทุก 10 วินาที (default `autosaveMs: 10000`) | `update(dt)` สะสมเวลาแล้ว `saveNow()` | `InteractionSession.update` |
| ปิด/ซ่อนแท็บ | `visibilitychange` (hidden) และ `beforeunload`/`pagehide` → `saveNow()` | `bindLifecycleSave` |
| เปิดหน้าใหม่ | `restore()` ตอนสร้าง session | `InteractionSession.restore` |
| ปุ่ม reset world | `store.clear()` + คืน terrain + hotbar เริ่มต้น | `InteractionSession.resetWorld` |

`autosaveMs` เทียบกับ "เวลาเดินจริงของเฟรมสะสม" (วินาที × 1000) ดังนั้นเกมที่หยุดเดินจะไม่เซฟ
(หน่วยเป็น ms, default 10,000) — เคยมีบั๊กเทียบ ms กับวินาทีตรง ๆ ทำให้ไม่เคย autosave เลย แก้แล้วและมีเทสต์คุม

## โหลดกลับอย่างไรให้ "โลกเหมือนเดิม"

`EditTracker.applyToLoadedChunks(world)` ถูกเรียกทุกเฟรมจาก `session.update(dt)`:

1. จัดกลุ่ม edit ตาม chunk (`byChunk`) แล้วดูว่า chunk นั้นโหลดอยู่ไหม (`world.getChunk(cx, cz)`)
2. ถ้าโหลดอยู่และยังไม่เคยเขียนลง chunk **อินสแตนซ์นี้** → เขียนทุก edit ด้วย `world.setBlock` (สั่ง remesh ให้เอง)
3. จำอินสแตนซ์ที่เขียนแล้วไว้ (`appliedTo`) — chunk ที่ถูก unload แล้วโหลดใหม่จะเป็น object ใหม่
   จึงเขียน edit กลับให้อัตโนมัติ (มีเทสต์ `edits survive chunk unload / reload` คุมไว้)
4. chunk ที่ยังไม่โหลดจะถูกข้าม (ไม่บังคับโหลด chunk ไกล ๆ ให้เปลืองหน่วยความจำ)

ลำดับเฟรมของ engine คือ `onFrame` (ของเรา) → `world.update` (streaming + build mesh) → `render`
ดังนั้น edit ถูกเขียนก่อน mesh ของ chunk ที่เพิ่งสตรีมเข้าถูกสร้าง → ไม่เห็น terrain ดิบแวบหนึ่ง

## ความเข้ากันได้ / ความเสียหายของข้อมูล

- `normalizeSaveData()` ตรวจ: ต้องมี `version` ตรง, `seed` เป็นตัวเลข, edit ที่พิกัด/`id` เพี้ยนถูกคัดออก,
  `hotbar` ที่ผิดรูปถูกซ่อมหรือทิ้ง, `player` ที่ผิดรูปถูกตั้งเป็น `null` (เกมยังเล่นได้)
- JSON เสียหาย หรือ storage ถูกบล็อก (private mode) → `load()` คืน `null`, `lastError` มีข้อความ,
  เกมเริ่มโลกใหม่ได้ตามปกติ (ไม่ throw, ไม่มีจอค้าง)
- seed ในไฟล์ไม่ตรงกับ seed ของเกมที่เปิด → `restore()` ไม่ทำอะไร (`playerRestored === false`)
- เต็มโควตา localStorage → `save()` คืน `false`, เก็บข้อความใน `lastError`, HUD ขึ้น toast "save failed: ..."
- เปลี่ยนรูปแบบไฟล์ในอนาคต: ขึ้น `version` เป็น 2 แล้วเขียนตัวแปลงใน `normalizeSaveData` (ของเก่าเวอร์ชันอื่นจะถูกทิ้ง ไม่พังเกม)
