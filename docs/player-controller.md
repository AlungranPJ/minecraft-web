# Player controller

โมดูลอยู่ที่ `src/player/` และไม่แก้ public API เดิมใน `src/engine/index.ts`

## ใช้งาน

```ts
import { createGame } from './engine';
import { FirstPersonPlayer } from './player';

const game = createGame(canvas, { controls: 'none' });
const spawn = game.world.spawnPoint(0, 0);
const player = new FirstPersonPlayer({
  world: game.world,
  camera: game.camera,
  element: canvas,
  position: [spawn.x, spawn.y, spawn.z],
});
const unmount = player.mount(game);
player.onUpdate((_dt, state) => {
  // state.x/y/z เป็นตำแหน่งเท้า, state.eyeY เป็นตำแหน่งกล้อง
  // state.vx/vy/vz เป็นความเร็ว, state.onGround ใช้ทำ HUD หรือเสียงเดิน
});
```

> ในโค้ดจริง ให้สร้าง `game` ก่อน แล้วใช้ `game.world.spawnPoint(0, 0)` เป็นจุดเกิด
> `createGame` ไม่รับ `game.world` ใน options ดังนั้นตัวอย่างด้านบนมีไว้แสดงลำดับการใช้งาน และควรส่ง `position` หลังสร้างเกมแล้ว

หน้าทดลองแบบ standalone อยู่ที่ `/player.html` หลัง `npm run dev` หรือ `npm run preview`

## ส่วนประกอบ

- `input.ts` เก็บ WASD, ลูกศร, Space และ Shift พร้อม `setKeymap()` สำหรับ remap
- `look.ts` รองรับ pointer lock จากการคลิกซ้าย, ออกจาก lock ด้วย ESC, drag fallback และจำกัด pitch ที่ +/-89 องศา
- `collision.ts` ตรวจ AABB ขนาด 0.6 x 1.8 และเคลื่อนที่แบบ swept ด้วย substep พร้อมแยกแกน x แล้ว y แล้ว z
- `physics.ts` รวมแรงโน้มถ่วง, acceleration, friction, air drag, jump buffer, coyote time, การกันตกทะลุโลก และ unstick
- `player.ts` ต่อ input, look, physics เข้ากับ `game.onFrame()` และปรับ `camera.position` ก่อน engine streaming/render

## ค่าคงที่ฟิสิกส์ default

| ค่า | default | ความหมาย |
|---|---:|---|
| ขนาด AABB | 0.6 x 1.8 | กว้าง x ลึก และสูงเป็นบล็อก |
| eye height | 1.62 | ระยะกล้องจากเท้า |
| เดิน | 4.3 บล็อก/วินาที | ความเร็วเป้าหมายบนพื้น |
| วิ่ง | 5.6 บล็อก/วินาที | กด Shift |
| jump height | 1.25 บล็อก | คำนวณ `sqrt(2 * gravity * jumpHeight)` |
| gravity | 28 บล็อก/วินาที^2 | แรงโน้มถ่วง |
| ground acceleration | 60 | เร่งถึงความเร็วเป้าหมายเร็ว |
| air acceleration | 12 | ควบคุมกลางอากาศน้อยกว่าบนพื้น |
| ground friction | 18 | ปล่อยปุ่มแล้วหยุดเร็ว |
| air drag | 0.4 | รักษา momentum กลางอากาศ |
| terminal velocity | 78 | จำกัดความเร็วตก |
| pitch limit | +/-89 องศา | ป้องกันกล้องกลับหัว |

การชนใช้ `isSolid(world.getBlock(x, y, z))`; น้ำไม่ชนเพราะ engine กำหนดเป็น non-solid

## วิธีทดสอบ

```bash
npm run typecheck
npm run test:player
npm run test:player:browser
npm run build
```

- `test:player` เป็น headless test 114 checks ครอบคลุมเดิน, วิ่ง, กระโดด, step สูง 1, กำแพง, เพดาน, terminal velocity, remap key และ pitch clamp
- `test:player:browser` ใช้ Chrome จริงผ่าน CDP บน `/player.html` ครอบคลุม pointer lock/ESC, keyboard, collision และ FPS
- `test:browser` เป็น regression ของ engine เดิมบน `/`
