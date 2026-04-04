/**
 * @fileoverview TNT.js — Touch & No-Touch, v0.8.5
 *
 * Module d'abstraction des interactions tactiles pour surfaces mobiles.
 * Surmonte l'occlusion du doigt via un curseur déporté à distance fixe.
 *
 * Exports : {@link TouchEngine}, {@link CursorKinematics}, {@link TouchOverlay}
 *
 * ---
 *
 * **Architecture**
 *
 * - `TouchEngine` — machine à états ; capture les événements touch et émet
 *   les événements de geste. Gère aussi la position du curseur déporté.
 * - `CursorKinematics` — utilitaire de positionnement géométrique du curseur,
 *   indépendant du DOM. Maintient le curseur à `dist` px du doigt, barre rigide.
 * - `TouchOverlay` — façade tout-en-un : crée les éléments DOM et câble les
 *   événements. Recommandé pour un usage standard.
 *
 * ---
 *
 * **Machine à états**
 * ```
 *                  ┌──────────────────────────────────────────────────────┐
 *                  │                  5 doigts (tout état)                │
 *                  ▼                                                      │
 * IDLE ─(1 doigt)──► TAPPING ─(dépl. ≥ dist)──► GRABBING ─(relâché)──► IDLE
 *          │            │                                                  ▲
 *          │            ├──(tapMax ms)──► PRESSING                        │
 *          │            │                     │                           │
 *          │            │         (longPressMin - tapMax ms)              │
 *          │            │                     │                           │
 *          │            │               LONGPRESSING                      │
 *          │            │                     │                           │
 *          │            └──(2 doigts)──► PINCHING ┤                       │
 *          │                                      └──(tout relâché)───────┘
 *          └──────────────────────────────────────────────────────────────┘
 * ```
 *
 * ---
 *
 * **Événements émis par TouchEngine**
 *
 * Toutes les coordonnées sont relatives à l'élément écouté (pas au viewport).
 *
 * | Événement      | Payload |
 * |----------------|---------|
 * | `stateChange`  | `{ state }` |
 * | `tap`          | `{ x, y, intensity, precision }` |
 * | `press`        | `{ x, y, intensity, precision }` |
 * | `longPress`    | `{ x, y, msAfterMin, precision }` |
 * | `cancel`       | `{ x, y, state }` |
 * | `cursorActivate` | `{ x, y, touchX, touchY, state }` |
 * | `cursorMove`   | `{ x, y, touchX, touchY, state }` |
 * | `cursorRelease`| `{ x, y, activatedAt, vector, state }` |
 * | `cancelCursor` | `{ x, y, state }` |
 * | `pinchStart`   | `{ scale, state }` |
 * | `pinchChange`  | `{ scale, state }` |
 * | `pinchEnd`     | `{ scale, duration, state }` |
 *
 * - `intensity` `[0–1]` : durée normalisée dans la fenêtre temporelle du geste.
 * - `precision` : distance maximale (px) parcourue par le doigt depuis le départ.
 * - `x, y` dans les événements curseur : position du curseur déporté (= `kine.x/y`).
 *
 * ---
 *
 * **Usage bas niveau**
 * ```js
 * import { TouchEngine, CursorKinematics } from './tnt.js';
 *
 * const engine = new TouchEngine(element, { dist: 80 });
 * const kine   = new CursorKinematics({ dist: 80 });
 *
 * engine.on('cursorActivate', e => kine.activate(e.x, e.y, e.touchX, e.touchY));
 * engine.on('cursorMove',     e => kine.update(e.touchX, e.touchY));
 * engine.on('tap',            e => console.log('tap', e.x, e.y, e.intensity));
 * ```
 *
 * **Usage overlay (recommandé)**
 * ```js
 * import { TouchOverlay } from './tnt.js';
 *
 * const overlay = new TouchOverlay(element, {
 *   dist: 80, contactSize: 24, cursorSize: 14,
 * });
 * overlay.engine.on('tap', e => console.log('tap', e));
 * ```
 *
 * @module tnt
 * @version 0.8.5
 */

/**
 * Moteur de capture des événements touch avec machine à états.
 *
 * Toutes les coordonnées émises sont relatives à l'élément `el`.
 * Le `getBoundingClientRect()` est mis en cache au début de chaque geste.
 */
class TouchEngine {
  /**
   * @param {HTMLElement} el - Élément sur lequel écouter les événements touch.
   * @param {Object}  [opts={}]
   * @param {number}  [opts.dist=80]           - Distance (px) de déclenchement du grab ; aussi la longueur de la barre.
   * @param {number}  [opts.tapMax=500]        - Durée max (ms) d'un tap ; aussi le délai avant `pressing`.
   * @param {number}  [opts.pressMin=500]      - Durée min (ms) d'un press pour avoir une intensité > 0.
   * @param {number}  [opts.pressMax=1500]     - Durée max (ms) d'un press ; au-delà = zone morte.
   * @param {number}  [opts.longPressMin=3000] - Durée totale (ms) avant d'entrer en `longPressing`.
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

    this.handlers = {}; // { [eventName]: fn[] }
    this.touches  = new Map(); // identifier → { start, prev }

    /**
     * Position courante du curseur déporté, en coordonnées relatives à `el`.
     * Valide uniquement pendant un grab (`active === true`).
     * @type {{ x:number, y:number, active:boolean }}
     */
    this.cursor = { x: 0, y: 0, active: false };

    /**
     * État courant de la machine.
     * @type {'idle'|'tapping'|'pressing'|'longPressing'|'grabbing'|'pinching'|'catching'}
     */
    this.state = 'idle';

    /**
     * Nombre de doigts actuellement posés.
     * @type {number}
     */
    this.touchCount = 0;

    this.firstTouchId      = null;  // identifier du premier doigt
    this.grabId            = null;  // identifier du doigt en grab
    this.gestureStartStamp = null;  // performance.now() au premier contact
    this._grabActivatedAt  = null;  // position curseur à l'activation
    this._maxDelta         = 0;     // distance max parcourue (precision)
    this._tapTimer         = null;
    this._longPressTimer   = null;
    this._pinchInitDist    = 0;
    this._lastPinchScale   = 1;
    this._rect             = null;  // DOMRect mis en cache au début du geste
    // Discrimination 2 doigts (pinch vs catch)
    this._pending2         = false; // 2e doigt posé, geste pas encore discriminé
    this._pending2InitDist = 0;     // distance inter-doigts au moment du 2e contact
    this._pending2Center   = null;  // centre inter-doigts au moment du 2e contact

    this._bind();
  }

  /** Raccourci : `state === 'grabbing'`. @type {boolean} */
  get isGrabbing() { return this.state === 'grabbing'; }

  /** Distance de déclenchement du grab et longueur de barre (px). @type {number} */
  get dist()          { return this.opts.dist; }
  set dist(v)         { this.opts.dist = v; }

  /** Durée max d'un tap, aussi délai avant `pressing` (ms). @type {number} */
  get tapMax()        { return this.opts.tapMax; }
  set tapMax(v)       { this.opts.tapMax = v; }

  /** Durée min d'un press pour avoir intensity > 0 (ms). @type {number} */
  get pressMin()      { return this.opts.pressMin; }
  set pressMin(v)     { this.opts.pressMin = v; }

  /** Durée max d'un press ; au-delà = zone morte (ms). @type {number} */
  get pressMax()      { return this.opts.pressMax; }
  set pressMax(v)     { this.opts.pressMax = v; }

  /** Durée totale avant d'entrer en `longPressing` (ms). @type {number} */
  get longPressMin()  { return this.opts.longPressMin; }
  set longPressMin(v) { this.opts.longPressMin = v; }

  /**
   * Abonne un handler à un événement.
   * @param {string}   type - Nom de l'événement.
   * @param {function} fn   - Handler appelé avec le payload de l'événement.
   */
  on(type, fn) {
    (this.handlers[type] ||= []).push(fn);
  }

  /**
   * Émet un événement manuellement (utile pour les tests ou les extensions).
   * @param {string} type
   * @param {Object} data
   */
  emit(type, data) {
    console.debug(`[TNT] ${type}`, data);
    (this.handlers[type] || []).forEach(fn => fn(data));
  }

  /** @private */
  _setState(next) {
    console.debug(`[TNT] ${this.state} → ${next}`);
    this.state = next;
    this.emit('stateChange', { state: next });
  }

  /** @private */
  _clearTimers() {
    clearTimeout(this._tapTimer);
    clearTimeout(this._longPressTimer);
    this._tapTimer = null;
    this._longPressTimer = null;
  }

  /** @private */
  _toIdle() {
    this._clearTimers();
    this.state = 'idle';
    this.touchCount = 0;
    this.firstTouchId = null;
    this.grabId = null;
    this.gestureStartStamp = null;
    this._grabActivatedAt = null;
    this._maxDelta = 0;
    this._pinchInitDist    = 0;
    this._lastPinchScale   = 1;
    this._pending2         = false;
    this._pending2InitDist = 0;
    this._pending2Center   = null;
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

    // tapping + 2e doigt → discrimination en attente (pinch ou catch ?)
    if (this.touchCount === 2 && this.state === 'tapping') {
      this._clearTimers();
      const [a, b] = [...this.touches.values()];
      this._pending2         = true;
      this._pending2InitDist = Math.hypot(b.prev.x - a.prev.x, b.prev.y - a.prev.y);
      this._pending2Center   = { x: (a.prev.x + b.prev.x) / 2, y: (a.prev.y + b.prev.y) / 2 };
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

      // Tapping: check grab threshold (only when no 2nd finger pending)
      if (this.state === 'tapping' && !this._pending2 && t.identifier === this.firstTouchId) {
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

    // Discrimination pending2 : pinch ou catch ?
    if (this._pending2 && this.touches.size === 2) {
      const [a, b]    = [...this.touches.values()];
      const curDist   = Math.hypot(b.prev.x - a.prev.x, b.prev.y - a.prev.y);
      const center    = { x: (a.prev.x + b.prev.x) / 2, y: (a.prev.y + b.prev.y) / 2 };
      const deltaDist = Math.abs(curDist - this._pending2InitDist);
      const centerMov = Math.hypot(center.x - this._pending2Center.x, center.y - this._pending2Center.y);
      const threshold = this.opts.dist / 4;

      if (deltaDist >= threshold) {
        // Doigts s'éloignent ou se rapprochent → pinch
        this._pending2       = false;
        this._pinchInitDist  = curDist;
        this._lastPinchScale = 1;
        this._setState('pinching');
        this.emit('pinchStart', { scale: 1, state: 'pinching' });
      } else if (centerMov >= threshold) {
        // Doigts se translatent ensemble → catch
        this._pending2 = false;
        this._setState('catching');
        this.emit('catchAt', { x: center.x, y: center.y, state: 'catching' });
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

    // Catch update
    if (this.state === 'catching' && this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      this.emit('catchMove', {
        x: (a.prev.x + b.prev.x) / 2,
        y: (a.prev.y + b.prev.y) / 2,
        state: 'catching',
      });
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

    // Catch end on any lift while catching
    if (this.state === 'catching') {
      // Centre calculé avant suppression des touches
      const pts = [...this.touches.values()];
      const x   = pts.reduce((s, p) => s + p.prev.x, 0) / (pts.length || 1);
      const y   = pts.reduce((s, p) => s + p.prev.y, 0) / (pts.length || 1);
      this._toIdle();
      this.emit('catchDrop', { x, y, state: 'idle' });
      return;
    }

    // Doigt relevé avant discrimination → annulation silencieuse
    if (this._pending2) {
      this._toIdle();
      return;
    }

    // Single-touch gesture completion
    if (this.touchCount === 0 && this.gestureStartStamp !== null) {
      const dt         = performance.now() - this.gestureStartStamp;
      const finalState = this.state;
      const t0         = e.changedTouches[0];
      const { x, y }   = this._pos(t0);   // coordonnées relatives à l'élément
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
 * Positionnement géométrique du curseur déporté.
 *
 * Maintient le curseur à exactement `dist` px du doigt — barre rigide, sans ressort.
 * La direction est conservée : quand le doigt bouge, la barre pivote autour du
 * contact sans changer de longueur.
 *
 * Les coordonnées `x`, `y` de cette classe sont dans le même repère que les
 * coordonnées `touchX`, `touchY` fournies à `update()` (en pratique, relatives
 * à l'élément si on utilise les valeurs émises par {@link TouchEngine}).
 */
class CursorKinematics {
  /**
   * @param {Object} [opts={}]
   * @param {number} [opts.dist=80] - Distance fixe entre le doigt et le curseur (px).
   */
  constructor(opts = {}) {
    /** @type {number} */ this.x = 0;
    /** @type {number} */ this.y = 0;
    /** @type {number} */ this.dist = opts.dist ?? 80;
    /** @type {boolean} */ this.initialized = false;
  }

  /**
   * Place le curseur à `dist` px à droite du point de contact.
   * Utilisé en fallback par `update()` si le curseur n'est pas encore initialisé.
   * @param {number} px - X du contact.
   * @param {number} py - Y du contact.
   */
  init(px, py) {
    this.x = px + this.dist;
    this.y = py;
    this.initialized = true;
  }

  /**
   * Initialise le curseur à `dist` px du doigt, dans la direction `curseur → doigt`.
   * À appeler au `cursorActivate` avec les valeurs `e.x, e.y, e.touchX, e.touchY`.
   * @param {number} cursorX - X courant du curseur (indice de direction).
   * @param {number} cursorY - Y courant du curseur.
   * @param {number} touchX  - X du doigt.
   * @param {number} touchY  - Y du doigt.
   */
  activate(cursorX, cursorY, touchX, touchY) {
    const dx = cursorX - touchX;
    const dy = cursorY - touchY;
    const d  = Math.hypot(dx, dy) || 0.0001;
    this.x   = touchX + (dx / d) * this.dist;
    this.y   = touchY + (dy / d) * this.dist;
    this.initialized = true;
  }

  /**
   * Réinitialise le curseur (arrête le rendu jusqu'au prochain `activate`/`init`).
   * À appeler au `cursorRelease` et au `cancelCursor`.
   */
  reset() {
    this.initialized = false;
  }

  /**
   * Replace le curseur à exactement `dist` px du doigt en conservant la direction courante.
   * À appeler à chaque `cursorMove`, idéalement dans un `requestAnimationFrame`.
   * @param {number} px - X du doigt.
   * @param {number} py - Y du doigt.
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
 * Façade tout-en-un : crée les éléments DOM du curseur déporté et câble les
 * événements de {@link TouchEngine} et {@link CursorKinematics}.
 *
 * Recommandé pour un usage standard. Pour une personnalisation avancée,
 * utiliser `TouchEngine` et `CursorKinematics` séparément.
 */
class TouchOverlay {
  /**
   * @param {HTMLElement} container - Élément conteneur (doit être en `position:relative` ou `absolute`).
   * @param {Object}  [opts={}]
   * @param {number}  [opts.dist=80]           - Distance fixe doigt → curseur (px). Transmis à `TouchEngine` et `CursorKinematics`.
   * @param {number}  [opts.tapMax=500]        - Voir {@link TouchEngine}.
   * @param {number}  [opts.pressMin=500]      - Voir {@link TouchEngine}.
   * @param {number}  [opts.pressMax=1500]     - Voir {@link TouchEngine}.
   * @param {number}  [opts.longPressMin=3000] - Voir {@link TouchEngine}.
   * @param {number}  [opts.contactSize=24]    - Diamètre du point de contact (px).
   * @param {number}  [opts.cursorSize=14]     - Diamètre du curseur déporté (px).
   * @param {boolean} [opts.rodEnabled=true]   - Affiche le bras entre contact et curseur.
   * @param {boolean} [opts.pulseEnabled=true] - Animation pulse à l'activation du grab.
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

  /** Le {@link TouchEngine} sous-jacent. @type {TouchEngine} */
  get engine() { return this._engine; }

  /** Le {@link CursorKinematics} sous-jacent. @type {CursorKinematics} */
  get kine() { return this._kine; }

  /** Diamètre du point de contact (px), modifiable à l'exécution. @type {number} */
  set contactSize(v) {
    this._contactSize = v;
    if (this._contactEl) {
      this._contactEl.style.width  = v + 'px';
      this._contactEl.style.height = v + 'px';
    }
  }
  get contactSize() { return this._contactSize; }

  /** Diamètre du curseur déporté (px), modifiable à l'exécution. @type {number} */
  set cursorSize(v) {
    this._cursorSize = v;
    if (this._cursorEl) {
      this._cursorEl.style.width  = v + 'px';
      this._cursorEl.style.height = v + 'px';
    }
  }
  get cursorSize() { return this._cursorSize; }

  /** Active/désactive le bras entre contact et curseur. @type {boolean} */
  set rodEnabled(v) {
    this._rodEnabled = v;
    if (this._rodEl) this._rodEl.style.opacity = v ? '1' : '0';
  }
  get rodEnabled() { return this._rodEnabled; }

  /** Active/désactive l'animation pulse à l'activation du grab. @type {boolean} */
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
