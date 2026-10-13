# Touch synthesis — D:\lab\qiniandian (three 0.186.1 / playwright 1.64.0) — VERDICT: YES, via CDP

**Setup.** Served existing `dist`: `node node_modules\vite\bin\vite.js preview --port 5390 --strictPort --host 127.0.0.1`
(PIDs 16556/25644/6008/29712/12780, all killed; port free after). Scripts `probe*.mjs`, output `probe*.log`, `results*.json`, `*.png` — all in this dir.
**Ground truth (decisive):** zero repo edits — an `addInitScript` patching `Function.prototype.bind` captures the live
`OrbitControls` instance as `window.__OC__`, so camera pos/target/dist are *numbers*, not pixel guesses. 2nd channel: `pngjs`
pixel-diff (resolved via `createRequire('D:/lab/qiniandian/package.json')` — nothing installed anywhere). Context unless noted:
`{viewport:1280x720, hasTouch:true, isMobile:true, deviceScaleFactor:1}`. `?hud=0` ⇒ `#sceneinfo===null` (verified).

**A) `touchscreen.tap()` — MOVE = NO.** 3 fresh-load trials: `dPos=0.0000, dDist=0.0000`. Pixels `pctAny=0.0003%` (16px), `maxΔ=1` = idle noise.
Events are real: `__TOUCH_SEEN=["touch","touch"]`, `[pointerdown/touch, touchstart, pointerup/touch, touchend, mousedown, mouseup]`.
Tap = pointerdown+up with **no pointermove** ⇒ `_rotateStart` set, then up with `_pointers.length→0`, no delta ⇒ 0 rotation.
**Fact:** with `hasTouch:false`, `touchscreen.tap` throws `Error: touchscreen.tap: hasTouch must be enabled on the browser context before using the touchscreen.`

**B(i) CDP 1-finger drag — MOVE = YES, deterministic.** `touchStart`→14× interpolated `touchMove`→`touchEnd{touchPoints:[]}`.
3 trials `dPos=155.944/155.944/155.9441`, `dDist=0.0000`. `(0,26,96)→(-64.46,-50.76,-23.46)`, dist 96.421 ⇒ **pure rotate**. `pctGt32=86.94%`, `maxΔ=209`.

**B(ii) CDP 2-finger pinch — MOVE = YES.** 2 points id 0,1 moved together, `touchEnd []`. Apart: `dDist=-72.3158` exactly ×3 (96.421→24.1052).
Together: `dDist=+289.2628` exactly ×3 (96.421→385.6838). `target` drifts ~0.18 ⇒ default `touches.TWO=DOLLY_PAN`, so it is **dolly+pan, not pure zoom**. `pctGt32=95.9954%` / `31.0375%`.

**`__TOUCH_SEEN` — PROVED.** All CDP gestures delivered `pointerType==="touch"`: drag 16 touch pointerdown/move, 1 down + 1 up, **0 pointercancel**;
pinch **2 pointerdown** (id 0 and id 1), 0 cancels ⇒ genuine touch PointerEvents on the canvas, exactly the `_onTouchStart`/`_onTouchMove` path.

**C) Observation validity.** Control: 2 shots 500 ms apart, no input ⇒ `diffAny=0, maxΔ=0`, byte-identical (293212=293212) ⇒ **page IS static, pixel-diff valid.**
Idle noise floor (6 pairs, sampled while damping still settling) reached `pctAny 0.2288%`, `pctGt32 0.1088%`, `maxΔ=95`; once settled it is exactly 0.
**Threshold `pctGt32 > 5%`**: 46× the worst noise, 6–19× below the weakest real signal (31%). One changed pixel / a lone `maxΔ` spike is **not** proof.

**D) CONTROL `?interactive=0` — INVALID AS SPECIFIED (key trap).** The page **navigates to `about:blank`**: href `…?interactive=0&hud=0 → about:blank`,
`canvas:false`, `sceneReady:false`, `navigation[0].type==="back_forward"`, pixels 100% white. Reproduced `isMobile:true` **and** `false`.
**Cause:** `OrbitControls` is what sets `style.touchAction='none'` (OrbitControls.js:508); with `interactive=0` canvas `touch-action=""` (auto), so the
browser applies native touch gestures on a non-scrollable page and navigates away. Proof by isolation: injected `canvas{touch-action:none!important}`
keeps the page alive, still delivers 16 touch pointers, pixels `0.0000%/max 0` ⇒ no camera motion. **Corrected control (D3):** `?interactive=1&hud=0`
with `window.__OC__.enabled=false` ⇒ `dPos=0,dDist=0`, `pctAny=0.0001%,maxΔ=1`. Mouse-drag on `?interactive=0` also stays static (`pctAny=0`) since mice don't trigger back-swipe.

**E) Desktop mouse drag (`?interactive=1`) — MOVE = YES.** `move(640,460)`+`down`+`move(800,340,{steps:10})`+`up` ⇒ `dPos=73.53`, `pctGt32=23.18%`.
Wheel-zoom reference `pctGt32=57.77%`, target unchanged ⇒ measurement chain validated on this exact build.

**Timing (any assertion must handle it).** `enableDamping=true` ⇒ camera coasts after `touchEnd`: `dPos` vs start = 118.5@0ms, 134@250, 143.6@500, 151.1@1000,
155.6@2500, **155.9@4000** (2500 vs 4000 still differ by 0.75). Recipe polls until quiet(400 ms): 8.2–9.4 s drag, 2.9–3.0 s pinch-in, 5.9 s pinch-out. Asserting right after `touchEnd` is flaky.

**VERDICT — YES, reliable, but only via CDP and only with interactivity on.** `page.touchscreen` has only `tap()`, which provably cannot rotate/dolly. Minimal recipe:
1. `newContext({viewport:{width:1280,height:720}, hasTouch:true, isMobile:true, deviceScaleFactor:1})` — `hasTouch:true` mandatory.
2. `addInitScript` the `bind` hook → `goto('http://127.0.0.1:5390/?interactive=1&hud=0')` → `waitForFunction(() => window.__SCENE__ && window.__OC__)`.
3. `cdp = await context.newCDPSession(page)`.
4. **Rotate:** `touchStart{touchPoints:[{x:500,y:430,id:0}]}` → 14× `touchMove` → `{x:720,y:330}` (~16 ms apart) → `touchEnd{touchPoints:[]}`.
   **Pinch:** `touchStart{touchPoints:[{x:600,y:360,id:0},{x:680,y:360,id:1}]}` → 14× `touchMove` both ids → `touchEnd{touchPoints:[]}`.
5. Poll camera ~120 ms until quiet 400 ms, then assert: rotate `|Δpos|>10` **and** `|Δdist|<0.01`; pinch `Δdist<-50` / `>+50`. Observed `155.94/±0.0001`, `-72.32`, `+289.26`.
6. Control must be `enabled=false` on an `interactive=1` page — **never** `?interactive=0` (see D).
   Fallback if camera readout is unacceptable: `pctGt32>5%` (worst real signal 31%); the bind-hook is then optional, but *required* to separate rotate from dolly.
   **Strongest reliable assertion without CDP:** the `?interactive=1` mouse-drag + wheel-diff pair (E). **Unverifiable here:** real-hardware/OS touch (all evidence is CDP-injected).

**UNDETERMINED / CAVEATS.** (1) Real-device touch untested (CDP is the same channel Playwright's `touchscreen` uses). (2) The `about:blank` mechanism is proven to
depend on `touch-action` (M3 fixes it) and manifests as a `back_forward` navigation, but the exact browser-internal trigger (overscroll back-gesture vs. dead-frame nav)
is inferred, not directly observed. (3) The bind-hook depends on minified code calling `.bind(this)` (worked: 12 bound fns) — fragile across versions. (4) `touches.TWO=DOLLY_ROTATE` not exercised.
(5) **Harness caveat:** playwright 1.64.0 expects chromium build **1248** (`chrome-headless-shell`), **not installed** here (only 1193/1234), so default `chromium.launch()` is
broken on this host; runs pinned `executablePath=…/chromium-1234/chrome-win64/chrome.exe`. (6) Served `dist` is stale (2026/10/9) vs `src/*` (2026/10/13); results describe the built artifact.
**Repo untouched by me:** no file created/modified under `D:\lab\qiniandian`; `git status` shows only a concurrent agent's edits (`M src/main.ts`, `M src/scene.ts`, `?? src/framing.ts`, `?? tests/framing.test.ts`).
