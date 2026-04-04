/**
 * TNT — Touch offset cursor overlay module
 *
 * Provides a touch overlay with a displaced cursor (offset from finger contact)
 * to overcome finger occlusion and improve precision on mobile devices.
 *
 * @module tnt
 * @version 2.0.0
 */

/**
 * @fileoverview TouchEngine + CursorKinematics + TouchOverlay
 *
 * TouchEngine — state machine that captures touch events and emits lifecycle events.
 * CursorKinematics — spring-based lag simulation for the displaced cursor.
 * TouchOverlay — full overlay with DOM rendering (contact dot, cursor, rod).
 *
 * State machine:
 * ```
 *                  ┌──────────────────────────────────────────────────────┐
 *                  │                  5 fingers (any state)               │
 *                  ▼                                                      │
 * IDLE ─(1 touch)──► TAPPING ─(travel ≥ dist)──► GRABBING ─(release)──► IDLE
 *          │            │                                                  ▲
 *          │            ├──(timeout tapMax)──► PRESSING                   │
 *          │            │                          │                      │
 *          │            │              (timeout longPressMin-tapMax)      │
 *          │            │                          │                      │
 *          │            │                     LONGPRESSING                │
 *          │            │                          │                      │
 *          │            └──(2 touches)──► PINCHING ┤                      │
 *          │                                       └──(any lift)──────────┘
 *          └──────────────────────────────────────────────────────────────┘
 * ```
 *
 * Events emitted:
 *   stateChange      — every state transition  { state }
 *   cursorActivate   — grab begins             { x, y, touchX, touchY, state }
 *   cursorMove       — grab in progress        { x, y, touchX, touchY, state }
 *   cursorRelease    — grab ends               { x, y, activatedAt, vector, state }
 *   cancelCursor     — 5-finger cancel         { x, y, state }
 *   tap              — short touch             { x, y, intensity, precision }
 *   press            — medium touch            { x, y, intensity, precision }
 *   longPress        — long touch              { x, y, msAfterMin, precision }
 *   cancel           — press/longPress annulé par déplacement ≥ dist  { x, y, state }
 *   pinchStart       — 2-finger pinch begins   { scale, state }
 *   pinchChange      — pinch in progress       { scale, state }
 *   pinchEnd         — pinch ends              { scale, duration, state }
 *
 * intensity (tap/press): normalized duration 0–1 within the gesture's time window.
 * precision: max distance (px) the finger traveled from its start point.
 *
 * Low-level usage:
 * ```js
 * import { TouchEngine, CursorKinematics } from './tnt.js';
 *
 * const engine = new TouchEngine(document.body, { dist: 80 });
 * const kine   = new CursorKinematics({ dist: 80 });
 *
 * engine.on('cursorActivate', e => kine.activate(e.x, e.y, e.touchX, e.touchY));
 * engine.on('cursorMove',     e => kine.update(e.touchX, e.touchY));
 * engine.on('tap',            e => console.log('tap', e.intensity));
 * engine.on('stateChange',    e => console.log('state →', e.state));
 * ```
 *
 * Full overlay usage:
 * ```js
 * import { TouchOverlay } from './tnt.js';
 *
 * const overlay = new TouchOverlay(document.body, {
 *   contactSize: 24, cursorSize: 14,
 *   rodEnabled: true, pulseEnabled: true,
 *   dist: 80, friction: 0.92, stiffness: 0.2,
 * });
 *
 * overlay.engine.on('tap', e => console.log('tap', e));
 * overlay.engine.on('stateChange', e => console.log('state →', e.state));
 * ```
 */

/**
 * Touch event capture engine with a state machine.
 *
 * States: idle → tapping → pressing → longPressing
 *                       ↘ grabbing
 *                       ↘ pinching
 *
 * @class
 */
class TouchEngine {
  /**
   * @param {HTMLElement} el - Element to bind touch events to.
   * @param {Object} [opts={}] - Configuration options.
   * @param {number} [opts.dist=80]           - Grab activation distance in pixels.
   * @param {number} [opts.tapMax=500]        - Max ms for a tap (also: delay before entering pressing).
   * @param {number} [opts.pressMin=500]      - Min ms for a press (= tapMax in default config).
   * @param {number} [opts.pressMax=1500]     - Max ms for a press; above this is the dead zone.
   * @param {number} [opts.longPressMin=3000] - Total ms before entering longPressing state.
   */
  constructor(el, opts = {}) {
    /** @type {HTMLElement} */
    this.el = el;
    this.opts = {
      dist: 80,
      tapMax: 500,
      pressMin: 500,
      pressMax: 1500,
      longPressMin: 3000,
      ...opts,
    };

    /** @type {Object.<string, function[]>} */
    this.handlers = {};

    /** @type {Map<number, {start:{x:number,y:number}, prev:{x:number,y:number}}>} */
    this.touches = new Map();

    /** @type {{ x:number, y:number, active:boolean }} */
    this.cursor = { x: 0, y: 0, active: false };

    /**
     * Current state machine state.
     * @type {'idle'|'tapping'|'pressing'|'longPressing'|'grabbing'|'pinching'}
     */
    this.state = 'idle';

    /** @type {number} */
    this.touchCount = 0;

    /** @type {number|null} */
    this.firstTouchId = null;

    /** @type {number|null} */
    this.grabId = null;

    /** @type {number|null} Timestamp of the first touch in the current gesture. */
    this.gestureStartStamp = null;

    /** @private @type {{x:number,y:number}|null} Cursor position when grab activated. */
    this._grabActivatedAt = null;

    /** @private @type {number} Max finger travel from start (precision field). */
    this._maxDelta = 0;

    /** @private @type {ReturnType<setTimeout>|null} */
    this._tapTimer = null;

    /** @private @type {ReturnType<setTimeout>|null} */
    this._longPressTimer = null;

    /** @private @type {number} */
    this._pinchInitDist = 0;

    /** @private @type {number} */
    this._lastPinchScale = 1;

    /**
     * Bounding rect of the element, cached at gesture start to avoid
     * repeated getBoundingClientRect() calls during move events.
     * @private @type {DOMRect|null}
     */
    this._rect = null;

    this._bind();
  }

  /**
   * Whether a grab is currently active.
   * @type {boolean}
   * @readonly
   */
  get isGrabbing() { return this.state === 'grabbing'; }

  /** @type {number} */ get dist()         { return this.opts.dist; }
  /** @type {number} */ set dist(v)        { this.opts.dist = v; }
  /** @type {number} */ get tapMax()       { return this.opts.tapMax; }
  /** @type {number} */ set tapMax(v)      { this.opts.tapMax = v; }
  /** @type {number} */ get pressMin()     { return this.opts.pressMin; }
  /** @type {number} */ set pressMin(v)    { this.opts.pressMin = v; }
  /** @type {number} */ get pressMax()     { return this.opts.pressMax; }
  /** @type {number} */ set pressMax(v)    { this.opts.pressMax = v; }
  /** @type {number} */ get longPressMin() { return this.opts.longPressMin; }
  /** @type {number} */ set longPressMin(v){ this.opts.longPressMin = v; }

  /**
   * Register an event handler.
   * @param {string} type - Event name.
   * @param {function} fn - Handler.
   */
  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
  }

  /**
   * Emit an event.
   * @param {string} type
   * @param {Object} data
   */
  emit(type, data) {
    console.debug(`[TNT] ${type}`, data);
    (this.handlers[type] || []).forEach(fn => fn(data));
  }

  /** @private Transition to a new state and emit stateChange. */
  _setState(next) {
    console.debug(`[TNT] ${this.state} → ${next}`);
    this.state = next;
    this.emit('stateChange', { state: next });
  }

  /** @private Clear pending timers. */
  _clearTimers() {
    clearTimeout(this._tapTimer);
    clearTimeout(this._longPressTimer);
    this._tapTimer = null;
    this._longPressTimer = null;
  }

  /**
   * @private
   * Reset all state to idle. Does NOT emit events — callers do that after.
   */
  _toIdle() {
    this._clearTimers();
    this.state = 'idle';
    this.touchCount = 0;
    this.firstTouchId = null;
    this.grabId = null;
    this.gestureStartStamp = null;
    this._grabActivatedAt = null;
    this._maxDelta = 0;
    this._pinchInitDist = 0;
    this._lastPinchScale = 1;
    this.cursor.active = false;
    this.touches.clear();
    this.emit('stateChange', { state: 'idle' });
  }

  /** @private */
  _bind() {
    const opt = { passive: false };
    this._hTouchStart  = e => this._start(e);
    this._hTouchMove   = e => this._move(e);
    this._hTouchEnd    = e => this._end(e);
    this.el.addEventListener('touchstart',  this._hTouchStart, opt);
    this.el.addEventListener('touchmove',   this._hTouchMove,  opt);
    this.el.addEventListener('touchend',    this._hTouchEnd,   opt);
    this.el.addEventListener('touchcancel', this._hTouchEnd,   opt);
  }

  /**
   * Remove all event listeners bound by this engine.
   * Call this when the owning component is destroyed.
   */
  destroy() {
    const opt = { passive: false };
    this.el.removeEventListener('touchstart',  this._hTouchStart, opt);
    this.el.removeEventListener('touchmove',   this._hTouchMove,  opt);
    this.el.removeEventListener('touchend',    this._hTouchEnd,   opt);
    this.el.removeEventListener('touchcancel', this._hTouchEnd,   opt);
    this._toIdle();
  }

  /** @private */
  _pos(t) {
    const r = this._rect;
    return { x: t.clientX - (r ? r.left : 0), y: t.clientY - (r ? r.top : 0) };
  }

  /** @private */
  _start(e) {
    this._rect = this.el.getBoundingClientRect();
    this.touchCount += e.changedTouches.length;

    for (const t of e.changedTouches) {
      const pos = this._pos(t);
      this.touches.set(t.identifier, { start: { ...pos }, prev: { ...pos } });
    }

    // 5+ fingers: cancel any active gesture silently
    if (this.touchCount >= 5) {
      this.emit('cancelCursor', { x: this.cursor.x, y: this.cursor.y, state: 'idle' });
      this._toIdle();
      return;
    }

    // idle → tapping on first touch
    if (this.state === 'idle' && this.touchCount === 1) {
      const t0  = e.changedTouches[0];
      const pos0 = this._pos(t0);
      this.firstTouchId = t0.identifier;
      this.gestureStartStamp = performance.now();
      this.cursor.x = pos0.x;
      this.cursor.y = pos0.y;
      this.cursor.active = true;
      this._setState('tapping');

      // tapping → pressing after tapMax ms
      this._tapTimer = setTimeout(() => {
        if (this.state !== 'tapping') return;
        this._setState('pressing');

        // pressing → longPressing so that total elapsed = longPressMin
        const remaining = Math.max(0, this.opts.longPressMin - this.opts.tapMax);
        this._longPressTimer = setTimeout(() => {
          if (this.state !== 'pressing') return;
          this._setState('longPressing');
        }, remaining);
      }, this.opts.tapMax);

      return;
    }

    // tapping + second finger → pinching
    if (this.touchCount === 2 && this.state === 'tapping') {
      this._clearTimers();
      const pts = [...this.touches.values()];
      this._pinchInitDist = Math.hypot(
        pts[1].start.x - pts[0].start.x,
        pts[1].start.y - pts[0].start.y,
      );
      this._lastPinchScale = 1;
      this._setState('pinching');
      this.emit('pinchStart', { scale: 1, state: 'pinching' });
    }
  }

  /** @private */
  _move(e) {
    if (this.state === 'idle') return;

    if (this.touchCount >= 5) {
      this.emit('cancelCursor', { x: this.cursor.x, y: this.cursor.y, state: 'idle' });
      this._toIdle();
      return;
    }

    for (const t of e.changedTouches) {
      const data = this.touches.get(t.identifier);
      if (!data) continue;

      const pos  = this._pos(t);
      const dx   = pos.x - data.prev.x;
      const dy   = pos.y - data.prev.y;
      data.prev  = pos;

      // Track precision (max distance from gesture start)
      const dist = Math.hypot(pos.x - data.start.x, pos.y - data.start.y);
      if (dist > this._maxDelta) this._maxDelta = dist;

      // Cancel press/longPress if finger exceeds grab distance
      if ((this.state === 'pressing' || this.state === 'longPressing') && t.identifier === this.firstTouchId) {
        if (dist >= this.opts.dist) {
          const px = pos.x, py = pos.y;
          this._toIdle();
          this.emit('cancel', { x: px, y: py, state: 'idle' });
          return;
        }
      }

      // Grabbing: drag the cursor
      if (this.state === 'grabbing' && t.identifier === this.grabId) {
        // Keep cursor at exactly dist px from touch, preserving current direction
        const cdx = this.cursor.x - pos.x;
        const cdy = this.cursor.y - pos.y;
        const cd  = Math.hypot(cdx, cdy) || 0.0001;
        this.cursor.x = pos.x + (cdx / cd) * this.opts.dist;
        this.cursor.y = pos.y + (cdy / cd) * this.opts.dist;
        this.emit('cursorMove', {
          x: this.cursor.x, y: this.cursor.y,
          touchX: pos.x, touchY: pos.y,
          state: 'grabbing',
        });
        continue;
      }

      // Tapping: check grab threshold
      if (this.state === 'tapping' && t.identifier === this.firstTouchId) {
        if (Math.hypot(pos.x - data.start.x, pos.y - data.start.y) >= this.opts.dist) {
          this._clearTimers();
          // Place cursor at dist px from touch, in the direction touch→gesture start
          const cdx = data.start.x - pos.x;
          const cdy = data.start.y - pos.y;
          const cd  = Math.hypot(cdx, cdy) || 0.0001;
          this.cursor.x = pos.x + (cdx / cd) * this.opts.dist;
          this.cursor.y = pos.y + (cdy / cd) * this.opts.dist;
          this._grabActivatedAt = { x: this.cursor.x, y: this.cursor.y };
          this.grabId = t.identifier;
          this._setState('grabbing');
          this.emit('cursorActivate', {
            x: this.cursor.x, y: this.cursor.y,
            touchX: pos.x, touchY: pos.y,
            state: 'grabbing',
          });
        }
      }
    }

    // Pinch update
    if (this.state === 'pinching' && this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      const curDist = Math.hypot(b.prev.x - a.prev.x, b.prev.y - a.prev.y);
      const scale   = this._pinchInitDist > 0 ? curDist / this._pinchInitDist : 1;
      this._lastPinchScale = scale;
      this.emit('pinchChange', { scale, state: 'pinching' });
    }
  }

  /** @private */
  _end(e) {
    this.touchCount = Math.max(0, this.touchCount - e.changedTouches.length);

    for (const t of e.changedTouches) {
      const data = this.touches.get(t.identifier);
      if (!data) continue;

      // Grab release
      if (this.state === 'grabbing' && t.identifier === this.grabId) {
        const activated = { ...this._grabActivatedAt };
        const payload   = {
          x: this.cursor.x, y: this.cursor.y,
          activatedAt: activated,
          vector: { x: this.cursor.x - activated.x, y: this.cursor.y - activated.y },
          state: 'idle',
        };
        this.touches.delete(t.identifier);
        this._toIdle();
        this.emit('cursorRelease', payload);
        return;
      }

      this.touches.delete(t.identifier);
    }

    // Pinch end on any lift while pinching
    if (this.state === 'pinching') {
      const scale    = this._lastPinchScale;
      const duration = this.gestureStartStamp ? performance.now() - this.gestureStartStamp : 0;
      this._toIdle();
      this.emit('pinchEnd', { scale, duration, state: 'idle' });
      return;
    }

    // Single-touch gesture completion
    if (this.touchCount === 0 && this.gestureStartStamp !== null) {
      const dt         = performance.now() - this.gestureStartStamp;
      const finalState = this.state;
      const t0         = e.changedTouches[0];
      const x          = t0.clientX;
      const y          = t0.clientY;
      const precision  = this._maxDelta;
      this._toIdle();

      if (finalState === 'tapping') {
        // intensity: 0 (immediate) → 1 (at tapMax)
        this.emit('tap', { x, y, intensity: Math.min(dt / this.opts.tapMax, 1), precision });

      } else if (finalState === 'pressing') {
        // Dead zone: pressMax < dt < longPressMin → emit nothing
        if (dt <= this.opts.pressMax) {
          const intensity = Math.max(0, (dt - this.opts.pressMin) / (this.opts.pressMax - this.opts.pressMin));
          this.emit('press', { x, y, intensity, precision });
        }

      } else if (finalState === 'longPressing') {
        this.emit('longPress', { x, y, msAfterMin: Math.max(0, dt - this.opts.longPressMin), precision });
      }
    }
  }

}

/**
 * Spring-based kinematics for the displaced cursor.
 * Positions the displaced cursor at a fixed distance from the touch point.
 * The cursor follows the touch rigidly — no spring, no lag, no elasticity.
 * The direction is preserved: as the finger moves, the cursor stays at `dist` px
 * in the same relative direction, rotating smoothly around the contact point.
 *
 * @class
 */
class CursorKinematics {
  /**
   * @param {Object} [opts={}]
   * @param {number} [opts.dist=80] - Fixed distance from touch (px).
   */
  constructor(opts = {}) {
    /** @type {number} */ this.x = 0;
    /** @type {number} */ this.y = 0;
    /** @type {number} */ this.dist = opts.dist ?? 80;
    /** @type {boolean} */ this.initialized = false;
  }

  /**
   * Place the cursor at `dist` px to the right of the touch point.
   * @param {number} px - Touch X.
   * @param {number} py - Touch Y.
   */
  init(px, py) {
    this.x  = px + this.dist;
    this.y  = py;
    this.vx = 0;
    this.vy = 0;
    this.initialized = true;
  }

  /**
   * Place the cursor at `dist` px away from touch, along the existing direction.
   * @param {number} cursorX - Cursor X hint.
   * @param {number} cursorY - Cursor Y hint.
   * @param {number} touchX  - Touch X.
   * @param {number} touchY  - Touch Y.
   */
  activate(cursorX, cursorY, touchX, touchY) {
    const dx = cursorX - touchX;
    const dy = cursorY - touchY;
    const d  = Math.hypot(dx, dy) || 0.0001;
    this.x  = touchX + (dx / d) * this.dist;
    this.y  = touchY + (dy / d) * this.dist;
    this.vx = 0;
    this.vy = 0;
    this.initialized = true;
  }

  /**
   * Reset the cursor to uninitialized state (stops rendering until next activate/init).
   */
  reset() {
    this.initialized = false;
  }

  /**
   * Place the cursor at exactly `dist` px from the touch point,
   * preserving the current cursor→touch direction.
   * @param {number} px - Touch X.
   * @param {number} py - Touch Y.
   */
  update(px, py) {
    if (!this.initialized) { this.init(px, py); return; }

    const dx = this.x - px;
    const dy = this.y - py;
    const d  = Math.hypot(dx, dy) || 0.0001;
    this.x   = px + (dx / d) * this.dist;
    this.y   = py + (dy / d) * this.dist;
  }
}

/**
 * Self-contained touch overlay: creates DOM elements and wires all events.
 *
 * @class
 */
class TouchOverlay {
  /**
   * @param {HTMLElement} container
   * @param {Object} [opts={}]
   * @param {number}  [opts.contactSize=24]
   * @param {number}  [opts.cursorSize=14]
   * @param {boolean} [opts.rodEnabled=true]
   * @param {boolean} [opts.pulseEnabled=true]
   * @param {number}  [opts.dist=80]
   * @param {number}  [opts.tapMax=500]
   * @param {number}  [opts.pressMin=500]
   * @param {number}  [opts.pressMax=1500]
   * @param {number}  [opts.longPressMin=3000]
   * @param {number}  [opts.friction=0.92]
   * @param {number}  [opts.stiffness=0.2]
   */
  constructor(container, opts = {}) {
    this.contactSize  = opts.contactSize  ?? 24;
    this.cursorSize   = opts.cursorSize   ?? 14;
    this.rodEnabled   = opts.rodEnabled   ?? true;
    this.pulseEnabled = opts.pulseEnabled ?? true;

    this._engine = new TouchEngine(container, {
      dist:         opts.dist         ?? 80,
      tapMax:       opts.tapMax       ?? 500,
      pressMin:     opts.pressMin     ?? 500,
      pressMax:     opts.pressMax     ?? 1500,
      longPressMin: opts.longPressMin ?? 3000,
    });

    this._kine = new CursorKinematics({
      dist: opts.dist ?? 80,
    });

    this._el         = container;
    this._contactEl  = null;
    this._cursorEl   = null;
    this._rodEl      = null;

    this._buildDOM();
    this._bindEvents();
  }

  /** @type {TouchEngine} */
  get engine() { return this._engine; }

  /** @type {CursorKinematics} */
  get kine() { return this._kine; }

  set contactSize(v) {
    this._contactSize = v;
    if (this._contactEl) {
      this._contactEl.style.width  = v + 'px';
      this._contactEl.style.height = v + 'px';
    }
  }
  get contactSize() { return this._contactSize; }

  set cursorSize(v) {
    this._cursorSize = v;
    if (this._cursorEl) {
      this._cursorEl.style.width  = v + 'px';
      this._cursorEl.style.height = v + 'px';
    }
  }
  get cursorSize() { return this._cursorSize; }

  set rodEnabled(v) {
    this._rodEnabled = v;
    if (this._rodEl) this._rodEl.style.opacity = v ? '1' : '0';
  }
  get rodEnabled() { return this._rodEnabled; }

  set pulseEnabled(v) { this._pulseEnabled = v; }
  get pulseEnabled()  { return this._pulseEnabled; }

  /** @private */
  _buildDOM() {
    this._contactEl = document.createElement('div');
    this._contactEl.style.cssText = [
      'position:absolute', 'border-radius:50%', 'background:#f00',
      'transform:translate(-50%,-50%)', 'pointer-events:none',
      'opacity:0', 'transition:opacity 0.1s',
      `width:${this._contactSize}px`, `height:${this._contactSize}px`,
    ].join(';');
    this._el.appendChild(this._contactEl);

    this._cursorEl = document.createElement('div');
    this._cursorEl.style.cssText = [
      'position:absolute', 'border-radius:50%', 'background:#0f0',
      'transform:translate(-50%,-50%)', 'pointer-events:none',
      'opacity:0', 'transition:opacity 0.1s',
      `width:${this._cursorSize}px`, `height:${this._cursorSize}px`,
    ].join(';');
    this._el.appendChild(this._cursorEl);

    this._rodEl = document.createElement('div');
    this._rodEl.style.cssText = [
      'position:absolute', 'height:2px', 'background:#888',
      'transform-origin:left center', 'pointer-events:none',
      'opacity:0', 'transition:opacity 0.1s',
    ].join(';');
    this._el.appendChild(this._rodEl);

    const style = document.createElement('style');
    style.textContent = `
@keyframes tnt-pulse {
  from { opacity:0.8; transform:translate(-50%,-50%) scale(1); }
  to   { opacity:0;   transform:translate(-50%,-50%) scale(2.8); }
}`;
    document.head.appendChild(style);
  }

  /** @private */
  _show() {
    this._contactEl.style.opacity = '1';
    this._cursorEl.style.opacity  = '1';
    if (this._rodEnabled) this._rodEl.style.opacity = '1';
  }

  /** @private */
  _hide() {
    this._contactEl.style.opacity = '0';
    this._cursorEl.style.opacity  = '0';
    this._rodEl.style.opacity     = '0';
    this._kine.reset();
  }

  /** @private */
  _render(tx, ty) {
    this._contactEl.style.left = tx + 'px';
    this._contactEl.style.top  = ty + 'px';
    this._cursorEl.style.left  = this._kine.x + 'px';
    this._cursorEl.style.top   = this._kine.y + 'px';

    if (this._rodEnabled) {
      const dx    = this._kine.x - tx;
      const dy    = this._kine.y - ty;
      const len   = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      this._rodEl.style.left      = tx + 'px';
      this._rodEl.style.top       = ty + 'px';
      this._rodEl.style.width     = len + 'px';
      this._rodEl.style.transform = `rotate(${angle}rad)`;
    }
  }

  /** @private */
  _bindEvents() {
    this._engine.on('cursorActivate', e => {
      this._kine.activate(e.x, e.y, e.touchX, e.touchY);
      this._show();
      this._render(e.touchX, e.touchY);

      if (this._pulseEnabled) {
        const pulse = document.createElement('div');
        pulse.style.cssText = [
          'position:absolute', 'border-radius:50%',
          'border:2px solid #0f0',
          'transform:translate(-50%,-50%)',
          'pointer-events:none',
          'animation:tnt-pulse 0.5s ease-out forwards',
          `left:${e.x}px`, `top:${e.y}px`,
          `width:${this._cursorSize * 3}px`,
          `height:${this._cursorSize * 3}px`,
        ].join(';');
        this._el.appendChild(pulse);
        pulse.addEventListener('animationend', () => pulse.remove(), { once: true });
      }
    });

    this._engine.on('cursorMove', e => {
      this._kine.update(e.touchX, e.touchY);
      this._render(e.touchX, e.touchY);
    });

    this._engine.on('cursorRelease', () => this._hide());
    this._engine.on('cancelCursor',  () => this._hide());
  }
}

export { TouchEngine, CursorKinematics, TouchOverlay };
