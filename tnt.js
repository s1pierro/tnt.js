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
 *          │            ├──(tappingToPressingFrontier)──► PRESSING          │
 *          │            │                     │                           │
 *          │            │    (pressingToLongPressingFrontier - frontier1)  │
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
 * | `tntBang`      | `{ x, y }` — raccourci 5 doigts, maintenu `pressingToLongPressingFrontier` ms |
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
   * @param {number}  [opts.tappingToPressingFrontier=500]        - Frontière (ms) tapping → pressing.
   * @param {number}  [opts.pressingToLongPressingFrontier=1500]  - Frontière (ms) pressing → longPressing.
   */
  constructor(el, opts = {}) {
    /** @type {HTMLElement} */
    this.el = el;
    this.opts = {
      dist: 80,
      tappingToPressingFrontier:       500,
      pressingToLongPressingFrontier: 1500,
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
    this._bangTimer        = null;
    this._bangPending      = false;
    this._pinchInitDist    = 0;
    this._lastPinchScale   = 1;
    this._rect             = null;  // DOMRect mis en cache au début du geste
    // Discrimination 2 doigts (pinch vs catch)
    this._pending2         = false; // 2e doigt posé, geste pas encore discriminé
    this._pending2InitDist = 0;     // distance inter-doigts au moment du 2e contact
    this._pending2Center   = null;  // centre inter-doigts au moment du 2e contact
    this._lastCenter       = null;  // dernier centre médian connu (pinch ou catch)

    this._bind();
  }

  /** Raccourci : `state === 'grabbing'`. @type {boolean} */
  get isGrabbing() { return this.state === 'grabbing'; }

  /** Distance de déclenchement du grab et longueur de barre (px). @type {number} */
  get dist()          { return this.opts.dist; }
  set dist(v)         { this.opts.dist = v; }

  /** Frontière tapping → pressing (ms). @type {number} */
  get tappingToPressingFrontier()        { return this.opts.tappingToPressingFrontier; }
  set tappingToPressingFrontier(v)       { this.opts.tappingToPressingFrontier = v; }

  /** Frontière pressing → longPressing (ms). @type {number} */
  get pressingToLongPressingFrontier()   { return this.opts.pressingToLongPressingFrontier; }
  set pressingToLongPressingFrontier(v)  { this.opts.pressingToLongPressingFrontier = v; }

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
    clearTimeout(this._bangTimer);
    this._tapTimer = null;
    this._longPressTimer = null;
    this._bangTimer = null;
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
    this._bangPending      = false;
    this._pinchInitDist    = 0;
    this._lastPinchScale   = 1;
    this._pending2         = false;
    this._pending2InitDist = 0;
    this._pending2Center   = null;
    this._lastCenter       = null;
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

    // 5+ fingers → annuler le geste en cours et armer le raccourci tntBang
    if (this.touchCount >= 5) {
      if (this.cursor.active) {
        this.emit('cancelCursor', { x: this.cursor.x, y: this.cursor.y, state: 'idle' });
      }
      // Annuler timers et état geste sans effacer touchCount/touches
      this._clearTimers();
      this.state = 'idle';
      this.firstTouchId = null; this.grabId = null;
      this.gestureStartStamp = null; this._grabActivatedAt = null;
      this._maxDelta = 0; this._pinchInitDist = 0; this._lastPinchScale = 1;
      this._pending2 = false; this._pending2InitDist = 0;
      this._pending2Center = null; this._lastCenter = null;
      this.cursor.active = false;
      this.emit('stateChange', { state: 'idle' });

      if (!this._bangPending) {
        this._bangPending = true;
        this._bangTimer = setTimeout(() => {
          this._bangPending = false;
          const pts = [...this.touches.values()];
          const x = pts.length ? pts.reduce((s, t) => s + t.prev.x, 0) / pts.length : 0;
          const y = pts.length ? pts.reduce((s, t) => s + t.prev.y, 0) / pts.length : 0;
          this.emit('tntBang', { x, y });
          this._toIdle();
        }, this.opts.pressingToLongPressingFrontier);
      }
      return;
    }

    // idle → tapping on first touch
    if (this.state === 'idle' && this.touchCount === 1) {
      const t0  = e.changedTouches[0];
      const pos0 = this._pos(t0);
      this.firstTouchId = t0.identifier;
      this.gestureStartStamp = e.timeStamp;
      this.cursor.x = pos0.x;
      this.cursor.y = pos0.y;
      this.cursor.active = true;
      this._setState('tapping');

      // tapping → pressing at tappingToPressingFrontier
      this._tapTimer = setTimeout(() => {
        if (this.state !== 'tapping') return;
        this._setState('pressing');

        // pressing → longPressing at pressingToLongPressingFrontier
        const remaining = this.opts.pressingToLongPressingFrontier - this.opts.tappingToPressingFrontier;
        this._longPressTimer = setTimeout(() => {
          if (this.state !== 'pressing') return;
          this._setState('longPressing');
        }, Math.max(0, remaining));
      }, this.opts.tappingToPressingFrontier);

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
    if (this._bangPending || this.state === 'idle') return;
    // Mise à jour des positions des touches en attente de bang (pour le centroïde)
    if (this.touchCount >= 5) {
      for (const t of e.changedTouches) {
        const data = this.touches.get(t.identifier);
        if (data) data.prev = this._pos(t);
      }
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
        this._lastCenter     = { x: center.x, y: center.y };
        this._setState('pinching');
        this.emit('pinchStart', { scale: 1, state: 'pinching',
          x1: a.prev.x, y1: a.prev.y, x2: b.prev.x, y2: b.prev.y });
      } else if (centerMov >= threshold) {
        // Doigts se translatent ensemble → catch
        this._pending2   = false;
        this._lastCenter = { x: center.x, y: center.y };
        this._setState('catching');
        this.emit('catchAt', { x: center.x, y: center.y, state: 'catching',
          x1: a.prev.x, y1: a.prev.y, x2: b.prev.x, y2: b.prev.y });
      }
    }

    // Pinch update
    if (this.state === 'pinching' && this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      const curDist = Math.hypot(b.prev.x - a.prev.x, b.prev.y - a.prev.y);
      const scale   = this._pinchInitDist > 0 ? curDist / this._pinchInitDist : 1;
      this._lastPinchScale = scale;
      this._lastCenter = { x: (a.prev.x + b.prev.x) / 2, y: (a.prev.y + b.prev.y) / 2 };
      this.emit('pinchChange', { scale, state: 'pinching',
        x1: a.prev.x, y1: a.prev.y, x2: b.prev.x, y2: b.prev.y });
    }

    // Catch update
    if (this.state === 'catching' && this.touches.size === 2) {
      const [a, b] = [...this.touches.values()];
      this._lastCenter = { x: (a.prev.x + b.prev.x) / 2, y: (a.prev.y + b.prev.y) / 2 };
      this.emit('catchMove', {
        x: this._lastCenter.x, y: this._lastCenter.y,
        x1: a.prev.x, y1: a.prev.y, x2: b.prev.x, y2: b.prev.y,
        state: 'catching',
      });
    }
  }

  /** @private */
  _end(e) {
    this.touchCount = Math.max(0, this.touchCount - e.changedTouches.length);

    // Un doigt levé pendant l'attente tntBang → annulation
    if (this._bangPending) {
      this._clearTimers();
      this._bangPending = false;
      for (const t of e.changedTouches) this.touches.delete(t.identifier);
      this._toIdle();
      return;
    }

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
      const { x, y } = this._lastCenter ?? { x: 0, y: 0 };
      this._toIdle();
      this.emit('pinchEnd', { x, y, scale, duration, state: 'idle' });
      return;
    }

    // Catch end on any lift while catching
    if (this.state === 'catching') {
      const { x, y } = this._lastCenter ?? { x: 0, y: 0 };
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
      const dt         = e.timeStamp - this.gestureStartStamp;
      const finalState = this.state;
      const t0         = e.changedTouches[0];
      const { x, y }   = this._pos(t0);
      const precision  = this._maxDelta;

      // Guard : only emit for single-touch gestures (not grab/pinch/catch)
      const isSingleTouch = finalState === 'tapping'
                         || finalState === 'pressing'
                         || finalState === 'longPressing';
      this._toIdle();

      if (!isSingleTouch) return;

      // dt est la source de vérité — pas l'état — pour éviter les races timer/event-loop.
      // Séquence sans zone morte : [0, b1) tap | [b1, b2) press | [b2, ∞) longPress
      const b1 = this.opts.tappingToPressingFrontier;
      const b2 = this.opts.pressingToLongPressingFrontier;
      if (dt < b1) {
        this.emit('tap',       { x, y, intensity: dt / b1, precision });
      } else if (dt < b2) {
        this.emit('press',     { x, y, intensity: (dt - b1) / (b2 - b1), precision });
      } else {
        this.emit('longPress', { x, y, msAfterMin: dt - b2, precision });
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
 * **Positionnement** : tous les éléments visuels sont en `position:absolute`
 * dans le container. `TouchOverlay` garantit que le container est un contexte
 * de positionnement en forçant `position:relative` s'il est encore `static`.
 * Les coordonnées émises par les événements sont relatives au border-box du
 * container — assurez-vous que celui-ci n'a pas de `padding` ou de `border`
 * qui décalerait l'origine, ou tenez-en compte dans votre application.
 *
 * Recommandé pour un usage standard. Pour une personnalisation avancée,
 * utiliser `TouchEngine` et `CursorKinematics` séparément.
 */
class TouchOverlay {
  /**
   * @param {HTMLElement} container - Élément conteneur. Doit couvrir la zone tactile.
   *   `TouchOverlay` force `position:relative` si le container est en `position:static`.
   * @param {Object}  [opts={}]
   * @param {number}  [opts.dist=80]           - Distance fixe doigt → curseur (px). Transmis à `TouchEngine` et `CursorKinematics`.
   * @param {number}  [opts.tappingToPressingFrontier=500]       - Voir {@link TouchEngine}.
   * @param {number}  [opts.pressingToLongPressingFrontier=1500] - Voir {@link TouchEngine}.
   * @param {number}  [opts.contactSize=24]    - Diamètre du point de contact (px).
   * @param {number}  [opts.cursorSize=14]     - Diamètre du curseur déporté (px).
   * @param {boolean} [opts.rodEnabled=true]   - Affiche le bras entre contact et curseur.
   * @param {boolean} [opts.pulseEnabled=true] - Animation pulse à l'activation du grab.
   */
  constructor(container, opts = {}) {
    // Garantit un contexte de positionnement pour les éléments absolus
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    this.contactSize  = opts.contactSize  ?? 24;
    this.cursorSize   = opts.cursorSize   ?? 14;
    this.rodEnabled   = opts.rodEnabled   ?? true;
    this.pulseEnabled = opts.pulseEnabled ?? true;

    this._engine = new TouchEngine(container, {
      dist:         opts.dist         ?? 80,
      tappingToPressingFrontier:       opts.tappingToPressingFrontier       ?? 500,
      pressingToLongPressingFrontier:  opts.pressingToLongPressingFrontier  ?? 1500,
    });

    this._kine = new CursorKinematics({
      dist: opts.dist ?? 80,
    });

    this._el         = container;
    this._contactEl  = null;
    this._cursorEl   = null;
    this._rodEl      = null;
    this._dot1El      = null;
    this._dot2El      = null;
    this._multiLineEl = null;
    this._dotCenterEl = null;

    this._buildDOM();
    this._bindEvents();
  }

  /** Le {@link TouchEngine} sous-jacent. @type {TouchEngine} */
  get engine() { return this._engine; }

  /** Le {@link CursorKinematics} sous-jacent. @type {CursorKinematics} */
  get kine() { return this._kine; }

  /** L'élément container sur lequel l'overlay est monté. @type {HTMLElement} */
  get el() { return this._el; }

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

    const dotBase = [
      'position:absolute', 'border-radius:50%',
      'transform:translate(-50%,-50%)', 'pointer-events:none',
      'opacity:0', 'transition:opacity 0.1s',
      `width:${this._contactSize}px`, `height:${this._contactSize}px`,
    ].join(';');

    this._dot1El = document.createElement('div');
    this._dot1El.style.cssText = dotBase;
    this._el.appendChild(this._dot1El);

    this._dot2El = document.createElement('div');
    this._dot2El.style.cssText = dotBase;
    this._el.appendChild(this._dot2El);

    this._multiLineEl = document.createElement('div');
    this._multiLineEl.style.cssText = [
      'position:absolute', 'height:2px',
      'transform-origin:left center', 'pointer-events:none',
      'opacity:0', 'transition:opacity 0.1s',
    ].join(';');
    this._el.appendChild(this._multiLineEl);

    const cSize = Math.round(this._contactSize * 0.6);
    this._dotCenterEl = document.createElement('div');
    this._dotCenterEl.style.cssText = [
      'position:absolute', 'border-radius:50%', 'background:transparent',
      'border:2px solid', 'transform:translate(-50%,-50%)', 'pointer-events:none',
      'opacity:0', 'transition:opacity 0.1s',
      `width:${cSize}px`, `height:${cSize}px`,
    ].join(';');
    this._el.appendChild(this._dotCenterEl);

    const style = document.createElement('style');
    style.textContent = `
@keyframes tnt-pulse {
  from { opacity:0.8; transform:translate(-50%,-50%) scale(1); }
  to   { opacity:0;   transform:translate(-50%,-50%) scale(2.8); }
}
@keyframes tnt-disc {
  from { opacity:0.65; transform:translate(-50%,-50%) scale(0.8); }
  to   { opacity:0;    transform:translate(-50%,-50%) scale(2.8); }
}
@keyframes tnt-ring-shrink {
  from { opacity:0.7; transform:translate(-50%,-50%) scale(2.4); }
  to   { opacity:0;   transform:translate(-50%,-50%) scale(0.4); }
}
@keyframes tnt-burst-dot {
  from { opacity:0.9; transform:translate(-50%,-50%); }
  to   { opacity:0;   transform:translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))); }
}
@keyframes tnt-burst-in {
  from { opacity:0.9; transform:translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))); }
  to   { opacity:0;   transform:translate(-50%,-50%); }
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
  _showMulti(color) {
    this._dot1El.style.background      = color;
    this._dot2El.style.background      = color;
    this._multiLineEl.style.background = color;
    this._dotCenterEl.style.borderColor = color;
    this._dot1El.style.opacity          = '1';
    this._dot2El.style.opacity          = '1';
    this._multiLineEl.style.opacity     = '1';
    this._dotCenterEl.style.opacity     = '1';
  }

  /** @private */
  _hideMulti() {
    this._dot1El.style.opacity      = '0';
    this._dot2El.style.opacity      = '0';
    this._multiLineEl.style.opacity = '0';
    this._dotCenterEl.style.opacity = '0';
  }

  /** @private */
  _renderMulti(x1, y1, x2, y2) {
    this._dot1El.style.left = x1 + 'px';
    this._dot1El.style.top  = y1 + 'px';
    this._dot2El.style.left = x2 + 'px';
    this._dot2El.style.top  = y2 + 'px';
    this._dotCenterEl.style.left = ((x1 + x2) / 2) + 'px';
    this._dotCenterEl.style.top  = ((y1 + y2) / 2) + 'px';
    const dx    = x2 - x1;
    const dy    = y2 - y1;
    const len   = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    this._multiLineEl.style.left      = x1 + 'px';
    this._multiLineEl.style.top       = y1 + 'px';
    this._multiLineEl.style.width     = len + 'px';
    this._multiLineEl.style.transform = `rotate(${angle}rad)`;
  }

  /**
   * Spawn a one-shot animation element on the overlay.
   * @private
   * @param {'ring'|'disc'|'ring-shrink'|'burst'} type
   * @param {number} x
   * @param {number} y
   * @param {string} color
   * @param {object} [opts]
   * @param {number} [opts.size]
   * @param {string} [opts.duration]
   * @param {string} [opts.delay]
   */
  _anim(type, x, y, color, { size = this._cursorSize * 3, duration = '0.45s', delay = '0s' } = {}) {
    if (!this._pulseEnabled) return;

    if (type === 'burst' || type === 'burst-in') {
      const N  = 8, r = size * 2.1;
      const kf = type === 'burst-in' ? 'tnt-burst-in' : 'tnt-burst-dot';
      const ease = type === 'burst-in' ? 'ease-in' : 'ease-out';
      for (let i = 0; i < N; i++) {
        const angle = (i / N) * Math.PI * 2;
        const dot   = document.createElement('div');
        dot.style.cssText = [
          'position:absolute', 'border-radius:50%', 'pointer-events:none',
          `background:${color}`, 'width:20px', 'height:20px',
          `left:${x}px`, `top:${y}px`,
          `--dx:${(Math.cos(angle) * r).toFixed(1)}px`,
          `--dy:${(Math.sin(angle) * r).toFixed(1)}px`,
          `animation:${kf} ${duration} ${ease} ${delay} forwards`,
        ].join(';');
        this._el.appendChild(dot);
        dot.addEventListener('animationend', () => dot.remove(), { once: true });
      }
      return;
    }

    const kf  = type === 'disc' ? 'tnt-disc'
               : type === 'ring-shrink' ? 'tnt-ring-shrink'
               : 'tnt-pulse';
    const el  = document.createElement('div');
    const isFilled = type === 'disc';
    el.style.cssText = [
      'position:absolute', 'border-radius:50%', 'pointer-events:none',
      'transform:translate(-50%,-50%)',
      `left:${x}px`, `top:${y}px`,
      `width:${size}px`, `height:${size}px`,
      isFilled ? `background:${color}; opacity:0` : `border:2px solid ${color}; opacity:0`,
      `animation:${kf} ${duration} ease-out ${delay} forwards`,
    ].join(';');
    this._el.appendChild(el);
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }

  /** @private */
  _bindEvents() {
    this._engine.on('tap', e => {
      this._anim('ring', e.x, e.y, '#0ff', { size: this._cursorSize * 2.5, duration: '0.3s' });
    });

    this._engine.on('press', e => {
      this._anim('ring', e.x, e.y, '#ff0', { duration: '0.5s' });
      this._anim('ring', e.x, e.y, '#ff0', { duration: '0.5s', delay: '0.12s' });
    });

    this._engine.on('longPress', e => {
      this._anim('ring', e.x, e.y, '#f0f', { duration: '0.55s' });
      this._anim('ring', e.x, e.y, '#f0f', { duration: '0.55s', delay: '0.1s' });
      this._anim('ring', e.x, e.y, '#f0f', { duration: '0.55s', delay: '0.2s' });
    });

    this._engine.on('cursorActivate', e => {
      this._kine.activate(e.x, e.y, e.touchX, e.touchY);
      this._show();
      this._render(e.touchX, e.touchY);
      this._anim('ring', e.x, e.y, '#0f8', { duration: '0.5s' });
    });

    this._engine.on('cursorMove', e => {
      this._kine.update(e.touchX, e.touchY);
      this._render(e.touchX, e.touchY);
    });

    this._engine.on('cursorRelease', e => {
      this._hide();
      this._anim('ring-shrink', e.x, e.y, '#8fc', { duration: '0.35s' });
    });

    this._engine.on('cancelCursor', e => {
      this._hide();
      this._anim('ring-shrink', e.x, e.y, '#f88', { duration: '0.3s' });
    });

    // Pinch (orange) — disque plein expansif
    this._engine.on('pinchStart', e => {
      this._showMulti('#f80');
      this._renderMulti(e.x1, e.y1, e.x2, e.y2);
      const cx = (e.x1 + e.x2) / 2, cy = (e.y1 + e.y2) / 2;
      this._anim('disc', cx, cy, '#f80', { duration: '0.4s' });
    });
    this._engine.on('pinchChange', e => this._renderMulti(e.x1, e.y1, e.x2, e.y2));
    this._engine.on('pinchEnd', e => {
      this._hideMulti();
      this._anim('disc', e.x, e.y, '#fc8', { size: this._cursorSize * 2, duration: '0.35s' });
    });

    // tntBang (5 doigts) — toutes les animations simultanément
    this._engine.on('tntBang', e => {
      const S = this._cursorSize;
      // ring (tap, press, longPress, cursorActivate)
      this._anim('ring',        e.x, e.y, '#0ff', { size: S * 2.5, duration: '0.5s' });
      this._anim('ring',        e.x, e.y, '#ff0', { size: S * 3,   duration: '0.55s', delay: '0.04s' });
      this._anim('ring',        e.x, e.y, '#f0f', { size: S * 3.5, duration: '0.6s',  delay: '0.08s' });
      this._anim('ring',        e.x, e.y, '#0f8', { size: S * 4,   duration: '0.65s', delay: '0.12s' });
      // ring-shrink (cursorRelease, cancelCursor)
      this._anim('ring-shrink', e.x, e.y, '#8fc', { size: S * 4,   duration: '0.5s',  delay: '0.05s' });
      this._anim('ring-shrink', e.x, e.y, '#f88', { size: S * 3.5, duration: '0.45s', delay: '0.1s'  });
      // disc (pinchStart, pinchEnd)
      this._anim('disc',        e.x, e.y, '#f80', { size: S * 4,   duration: '0.55s', delay: '0.06s' });
      this._anim('disc',        e.x, e.y, '#fc8', { size: S * 3,   duration: '0.5s',  delay: '0.12s' });
      // burst (catchDrop) + burst-in (catchAt)
      this._anim('burst',       e.x, e.y, '#7cf', { size: S * 4,   duration: '0.6s',  delay: '0.03s' });
      this._anim('burst-in',    e.x, e.y, '#08f', { size: S * 4.5, duration: '0.65s', delay: '0.07s' });
    });

    // Catch (bleu) — explosion de points
    this._engine.on('catchAt', e => {
      this._showMulti('#08f');
      this._renderMulti(e.x1, e.y1, e.x2, e.y2);
      const cx = (e.x1 + e.x2) / 2, cy = (e.y1 + e.y2) / 2;
      this._anim('burst-in', cx, cy, '#08f', { size: this._cursorSize * 3, duration: '0.5s' });
    });
    this._engine.on('catchMove', e => this._renderMulti(e.x1, e.y1, e.x2, e.y2));
    this._engine.on('catchDrop', e => {
      this._hideMulti();
      this._anim('burst', e.x, e.y, '#7cf', { size: this._cursorSize * 2.5, duration: '0.45s' });
    });
  }
}

// ─── DropCursor ──────────────────────────────────────────────────────────────
let _dcCount = 0;

/**
 * Curseur en goutte d'eau escamotable.
 *
 * Structure DOM : conteneur (_el) → outline SVG + disque de déplacement (_baseDisc)
 * + disque d'orientation (_orientDisc). Les deux disques reçoivent les événements
 * tactiles directement — pas de calcul de hit-test en rotation inverse.
 *
 * @example
 * const drop = new DropCursor(stage, { x: 200, y: 300, enabled: true });
 */
class DropCursor {
  /**
   * @param {HTMLElement} container  - Élément parent (doit être positionné).
   * @param {object}      [opts]
   * @param {number}  [opts.x=150]       - Position X du centre de la base.
   * @param {number}  [opts.y=200]       - Position Y du centre de la base.
   * @param {number}  [opts.angle=0]     - Orientation en degrés (0 = pointe en haut, sens horaire +).
   * @param {number}  [opts.size=52]     - Rayon de la base (px).
   * @param {number}  [opts.height=115]  - Distance centre-base → pointe (px).
   * @param {boolean} [opts.enabled=false]
   */
  constructor(container, opts = {}) {
    this._id  = ++_dcCount;
    this._con = container;
    this._x   = opts.x      ?? 150;
    this._y   = opts.y      ?? 200;
    this._ang = opts.angle  ?? 0;
    this._R   = opts.size   ?? 52;
    this._H   = opts.height ?? 115;
    this._pad = 16;

    this._el          = null;
    this._svg         = null;
    this._baseDisc    = null;
    this._orientDisc  = null;

    this._mode       = null;   // 'move' | 'orient'
    this._tid        = null;
    this._sx = 0; this._sy = 0;
    this._ox = 0; this._oy = 0;
    this._isDrag      = false;
    this._interactive = true;

    this._handlers = {};
    this._onMove   = null;
    this._onEnd    = null;

    if (opts.enabled) this._mount();
  }

  // ── Accesseurs ─────────────────────────────────────────────────────────────

  /** Active ou masque le curseur. @type {boolean} */
  get enabled() { return !!this._el; }
  set enabled(v) { !!v === this.enabled ? null : v ? this._mount() : this._unmount(); }

  /** Angle d'orientation en degrés. @type {number} */
  get angle()   { return this._ang; }
  set angle(v)  { this._ang = v; this._el && this._render(); }

  /** Autorise les interactions (false annule le geste en cours). @type {boolean} */
  get interactive()  { return this._interactive; }
  set interactive(v) {
    this._interactive = !!v;
    if (!this._interactive && this._mode) {
      this._mode = null; this._tid = null; this._isDrag = false;
    }
  }

  /** Rayon de la base (px). @type {number} */
  get size()    { return this._R; }
  set size(v)   { this._R = v; this._el && this._render(); }

  /** Distance centre-base → pointe (px). @type {number} */
  get height()  { return this._H; }
  set height(v) { this._H = v; this._el && this._render(); }

  /** Position X du centre de la base. @type {number} */
  get x() { return this._x; }
  /** Position Y du centre de la base. @type {number} */
  get y() { return this._y; }

  // ── Événements ───────────────────────────────────────────────────────────

  /** @param {string} type - 'click' | 'move' | 'orient' */
  on(type, fn) { (this._handlers[type] ??= []).push(fn); return this; }

  /** @private */
  emit(type, data) { (this._handlers[type] ?? []).forEach(fn => fn(data)); }

  // ── Montage / démontage ──────────────────────────────────────────────────

  /** @private */
  _mount() {
    if (getComputedStyle(this._con).position === 'static')
      this._con.style.position = 'relative';

    // Conteneur principal — reçoit la rotation
    this._el = document.createElement('div');
    this._el.style.cssText = 'position:absolute;z-index:9998;pointer-events:none;';

    // Outline SVG (sans pointer-events)
    this._svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this._svg.style.cssText = 'display:block;overflow:visible;pointer-events:none;';
    this._el.appendChild(this._svg);

    // Disque de déplacement (base)
    this._baseDisc = document.createElement('div');
    this._baseDisc.style.cssText =
      'position:absolute;border-radius:50%;touch-action:none;pointer-events:auto;box-sizing:border-box;';
    this._el.appendChild(this._baseDisc);

    // Disque d'orientation (pointe)
    this._orientDisc = document.createElement('div');
    this._orientDisc.style.cssText =
      'position:absolute;border-radius:50%;touch-action:none;pointer-events:auto;box-sizing:border-box;';
    this._el.appendChild(this._orientDisc);

    this._con.appendChild(this._el);
    this._render();
    this._bindTouch();
  }

  /** @private */
  _unmount() {
    if (!this._el) return;
    document.removeEventListener('touchmove',   this._onMove);
    document.removeEventListener('touchend',    this._onEnd);
    document.removeEventListener('touchcancel', this._onEnd);
    this._el.remove();
    this._el = this._svg = this._baseDisc = this._orientDisc = null;
  }

  // ── Rendu ────────────────────────────────────────────────────────────────

  /** @private */
  _render() {
    const R = this._R, H = this._H, p = this._pad;
    const W  = 2 * (R + p);
    const Ht = H + R + 2 * p;
    const cx = R + p;          // centre de la base dans le SVG / dans _el
    const cy = H + p;          // centre de la base dans le SVG / dans _el
    const tx = cx, ty = p;     // pointe

    // ── Outline SVG (contour seul, sans fill) ──
    const d = [
      `M ${tx} ${ty}`,
      `C ${cx + R*0.38} ${ty + H*0.42}  ${cx + R} ${cy - R*0.58}  ${cx + R} ${cy}`,
      `A ${R} ${R} 0 0 1 ${cx - R} ${cy}`,
      `C ${cx - R} ${cy - R*0.58}  ${cx - R*0.38} ${ty + H*0.42}  ${tx} ${ty} Z`,
    ].join(' ');

    this._svg.setAttribute('width',  W);
    this._svg.setAttribute('height', Ht);
    this._svg.setAttribute('viewBox', `0 0 ${W} ${Ht}`);
    this._svg.style.filter = 'drop-shadow(0 2px 8px rgba(0,0,0,0.6))';
    this._svg.innerHTML = `<path d="${d}"
      fill="none"
      stroke="rgba(255,255,255,0.75)"
      stroke-width="2"
      stroke-linejoin="round"/>`;

    // ── Disque de déplacement — centré sur la base ──
    const bd = this._baseDisc.style;
    bd.width  = bd.height = `${R * 2}px`;
    bd.left   = `${cx - R}px`;
    bd.top    = `${cy - R}px`;
    bd.background = 'rgba(255,255,255,0.13)';
    bd.border = '1.5px solid rgba(255,255,255,0.40)';

    // ── Disque d'orientation — centré sur la pointe ──
    const or = 12;   // rayon fixe du disque orient
    const od = this._orientDisc.style;
    od.width  = od.height = `${or * 2}px`;
    od.left   = `${tx - or}px`;
    od.top    = `${ty - or}px`;
    od.background = 'rgba(255,255,255,0.10)';
    od.border = '2px solid rgba(255,255,255,0.88)';

    // ── Positionnement et rotation du conteneur ──
    this._el.style.left            = `${this._x - cx}px`;
    this._el.style.top             = `${this._y - cy}px`;
    this._el.style.width           = `${W}px`;
    this._el.style.height          = `${Ht}px`;
    this._el.style.transformOrigin = `${cx}px ${cy}px`;
    this._el.style.transform       = `rotate(${this._ang}deg)`;
  }

  // ── Gestion tactile ──────────────────────────────────────────────────────

  /** @private */
  _bindTouch() {
    const startHandler = (mode) => (e) => {
      if (!this._interactive) return;
      e.stopPropagation();
      e.preventDefault();
      if (this._mode) return;

      const t    = e.changedTouches[0];
      const rect = this._con.getBoundingClientRect();
      this._mode   = mode;
      this._tid    = t.identifier;
      this._sx     = t.clientX - rect.left;
      this._sy     = t.clientY - rect.top;
      this._ox     = this._x;
      this._oy     = this._y;
      this._isDrag = false;
    };

    this._baseDisc.addEventListener('touchstart',   startHandler('move'),   { passive: false });
    this._orientDisc.addEventListener('touchstart', startHandler('orient'), { passive: false });

    this._onMove = e => {
      if (!this._mode) return;
      e.preventDefault();
      const t = Array.from(e.changedTouches).find(t => t.identifier === this._tid);
      if (!t) return;

      const rect = this._con.getBoundingClientRect();
      const tx   = t.clientX - rect.left;
      const ty   = t.clientY - rect.top;

      if (this._mode === 'move') {
        if (!this._isDrag && Math.hypot(tx - this._sx, ty - this._sy) > 8)
          this._isDrag = true;
        if (this._isDrag) {
          this._x = this._ox + (tx - this._sx);
          this._y = this._oy + (ty - this._sy);
          this._render();
        }
      } else {
        // Orient : angle = direction base → doigt courant
        this._ang    = Math.atan2(tx - this._x, -(ty - this._y)) * 180 / Math.PI;
        this._isDrag = true;
        this._render();
      }
    };

    this._onEnd = e => {
      if (!Array.from(e.changedTouches).some(t => t.identifier === this._tid)) return;
      const endedMode = this._mode;
      const endedDrag = this._isDrag;
      this._mode = null; this._tid = null; this._isDrag = false;

      if (endedMode === 'move') {
        if (endedDrag) {
          this.emit('move', { x: this._x, y: this._y });
        } else {
          const { x: tx, y: ty } = this._tipPos();
          this._clickEffect(tx, ty);
          this.emit('click', { x: tx, y: ty });
        }
      } else if (endedMode === 'orient') {
        this.emit('orient', { angle: this._ang });
      }
    };

    document.addEventListener('touchmove',   this._onMove,   { passive: false });
    document.addEventListener('touchend',    this._onEnd);
    document.addEventListener('touchcancel', this._onEnd);
  }

  /** Coordonnées de la pointe dans le repère du container. @private */
  _tipPos() {
    const rad = this._ang * Math.PI / 180;
    return {
      x: this._x + this._H * Math.sin(rad),
      y: this._y - this._H * Math.cos(rad),
    };
  }

  /** Animation carrée au point de clic. @private */
  _clickEffect(tx, ty) {
    const s = 26;
    const div = document.createElement('div');
    div.style.cssText =
      `position:absolute;width:${s}px;height:${s}px;` +
      `left:${tx - s / 2}px;top:${ty - s / 2}px;` +
      `border:2px solid rgba(255,255,255,0.92);box-sizing:border-box;` +
      `pointer-events:none;z-index:9999;` +
      `transform:scale(0.35);opacity:1;` +
      `transition:transform 380ms ease-out,opacity 380ms ease-out;`;
    this._con.appendChild(div);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      div.style.transform = 'scale(2.4)';
      div.style.opacity   = '0';
    }));
    setTimeout(() => div.remove(), 420);
  }

  /** Retire le curseur du DOM et libère tous les listeners. */
  destroy() { this._unmount(); }
}

// ─── TouchPanel ──────────────────────────────────────────────────────────────

/**
 * Panneau de configuration modal pour TouchOverlay.
 * Génère son propre DOM, gère les réglages, la console d'événements,
 * l'historique des états, l'export et le DropCursor intégré.
 * Se toggle via tntBang (5 doigts).
 */
class TouchPanel {
  /**
   * @param {TouchOverlay} overlay
   * @param {object}  [opts]
   * @param {number}  [opts.markerTtl=3500]     - Durée de vie des marqueurs (ms).
   * @param {number}  [opts.trailTtl=1200]      - Durée de vie de la traînée (ms).
   * @param {boolean} [opts.trailEnabled=true]  - Traînée activée au démarrage.
   * @param {string}  [opts.storageKey='tnt-cfg'] - Clé localStorage.
   */
  constructor(overlay, opts = {}) {
    this._ov  = overlay;
    this._eng = overlay.engine;
    this._key  = opts.storageKey ?? 'tnt-cfg';

    const saved = this._load();

    // Config interne — source de vérité pour les sliders
    this._cfg = {
      contactSize:                    overlay.contactSize,
      cursorSize:                     overlay.cursorSize,
      rodEnabled:                     overlay.rodEnabled,
      pulseEnabled:                   overlay.pulseEnabled,
      dist:                           this._eng.dist,
      tappingToPressingFrontier:      this._eng.tappingToPressingFrontier,
      pressingToLongPressingFrontier: this._eng.pressingToLongPressingFrontier,
      dropEnabled:  false,
      markerTtl:    opts.markerTtl    ?? 3500,
      trailTtl:     opts.trailTtl     ?? 1200,
      trailEnabled: opts.trailEnabled ?? true,
      ...saved,
    };

    this._visible       = false;
    this._el            = null;
    this._histLastStamp = Date.now();

    // DropCursor — créé sur le même container que l'overlay
    const con = overlay.el;
    this._drop = new DropCursor(con, {
      x:       con.clientWidth  * 0.35,
      y:       con.clientHeight * 0.5,
      angle:   -30,
      size:    this._cfg.contactSize,
      height:  this._cfg.dist,
      enabled: this._cfg.dropEnabled,
    });

    this._injectCSS();
    this._mount();
    this._bindEngine();

    this._eng.on('tntBang', () => this.toggle());
  }

  // ── Accesseurs publics ────────────────────────────────────────────────────

  get markerTtl()    { return this._cfg.markerTtl; }
  get trailTtl()     { return this._cfg.trailTtl; }
  get trailEnabled() { return this._cfg.trailEnabled; }

  /** Le {@link DropCursor} géré par ce panneau. @type {DropCursor} */
  get drop() { return this._drop; }

  toggle() { this._visible ? this.hide() : this.show(); }
  show()   { this._visible = true;  this._el.classList.add('tnt-panel-open'); }
  hide()   { this._visible = false; this._el.classList.remove('tnt-panel-open'); }

  // ── localStorage ─────────────────────────────────────────────────────────

  _load() {
    try { return JSON.parse(localStorage.getItem(this._key) || '{}'); } catch { return {}; }
  }
  _save() {
    try { localStorage.setItem(this._key, JSON.stringify(this._cfg)); } catch {}
  }

  // ── CSS ──────────────────────────────────────────────────────────────────

  _injectCSS() {
    if (document.getElementById('tnt-panel-css')) return;
    const s = document.createElement('style');
    s.id = 'tnt-panel-css';
    s.textContent = `
.tnt-panel-backdrop{position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,.78);
  display:none;align-items:center;justify-content:center;touch-action:none}
.tnt-panel-backdrop.tnt-panel-open{display:flex}
.tnt-panel-modal{position:relative;width:94vw;max-width:94vw;height:92vh;max-height:92vh;
  background:#1a1a1a;color:#ddd;border-radius:12px;border:1px solid #333;
  display:flex;flex-direction:column;overflow:hidden;
  box-shadow:0 20px 60px rgba(0,0,0,.85)}
.tnt-ph{display:flex;align-items:center;justify-content:space-between;
  padding:11px 16px;background:#222;border-bottom:1px solid #2e2e2e;flex-shrink:0}
.tnt-ph-title{font-family:monospace;font-size:13px;font-weight:bold;
  color:#aaa;letter-spacing:.5px}
.tnt-ph-close{background:none;border:none;color:#666;font-size:20px;
  cursor:pointer;padding:0 4px;line-height:1;touch-action:manipulation}
.tnt-ph-close:active{color:#fff}
.tnt-pb{flex:1;overflow-y:auto;padding:10px;
  display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;
  align-content:start}
.tnt-card{background:#222;border-radius:8px;padding:10px 12px;
  border:1px solid #2a2a2a}
.tnt-card.wide{grid-column:1/-1}
.tnt-card h4{margin:0 0 8px;font-size:10px;color:#666;
  text-transform:uppercase;letter-spacing:.8px;font-weight:bold}
.tnt-card label{display:flex;align-items:center;gap:6px;
  font-size:12px;margin:5px 0;color:#bbb;flex-wrap:wrap}
.tnt-card label span.val{margin-left:auto;color:#888;font-size:11px;font-family:monospace}
.tnt-card input[type=range]{width:100%;margin:2px 0;flex-basis:100%}
.tnt-card input[type=checkbox]{width:16px;height:16px;flex-shrink:0}
.tnt-sbadge{display:inline-block;font-family:monospace;font-size:11px;
  padding:3px 10px;border-radius:3px;background:#444;color:#ccc;
  min-width:90px;text-align:center;text-transform:uppercase;letter-spacing:.5px;
  margin-bottom:6px}
.tnt-sbadge.idle         {background:#444;color:#bbb}
.tnt-sbadge.tapping      {background:#268bd2;color:#fff}
.tnt-sbadge.pressing     {background:#b58900;color:#000}
.tnt-sbadge.longPressing {background:#d33682;color:#fff}
.tnt-sbadge.grabbing     {background:#2aa198;color:#000}
.tnt-sbadge.pinching     {background:#859900;color:#000}
.tnt-sbadge.catching     {background:#08f;color:#fff}
.tnt-ev-live{font-family:monospace;font-size:11px;background:#0a0a0a;
  padding:3px 6px;border-radius:3px 3px 0 0;min-height:18px;border-bottom:1px solid #1a1a1a}
.tnt-ev-hist{font-family:monospace;font-size:11px;background:#000;
  padding:4px 6px;border-radius:0 0 3px 3px;max-height:120px;overflow-y:auto}
.tnt-ev{padding:2px 0;border-bottom:1px solid #111}
.tnt-ev-label{color:#888}
.tnt-ev-meta{color:#444;font-size:10px}
.tnt-ev-live-row{color:#334;font-size:11px}
.tnt-ev-live-row .tnt-ev-label{color:#445}
.tnt-hist{font-family:monospace;font-size:11px;background:#000;padding:4px 6px;
  border-radius:3px;max-height:130px;overflow-y:auto;
  display:flex;flex-direction:column-reverse}
.tnt-hrow{display:flex;align-items:baseline;gap:5px;padding:2px 0;
  border-bottom:1px solid #1a1a1a}
.tnt-hbadge{display:inline-block;padding:1px 5px;border-radius:2px;font-size:10px;
  text-transform:uppercase;letter-spacing:.4px;min-width:76px;text-align:center;flex-shrink:0}
.tnt-hbadge.idle         {background:#444;color:#bbb}
.tnt-hbadge.tapping      {background:#268bd2;color:#fff}
.tnt-hbadge.pressing     {background:#b58900;color:#000}
.tnt-hbadge.longPressing {background:#d33682;color:#fff}
.tnt-hbadge.grabbing     {background:#2aa198;color:#000}
.tnt-hbadge.pinching     {background:#859900;color:#000}
.tnt-hbadge.catching     {background:#08f;color:#fff}
.tnt-hdur{color:#555;font-size:10px;flex-shrink:0;width:48px;text-align:right}
.tnt-btn{width:100%;padding:5px;background:#2d2d2d;color:#888;border:none;
  border-radius:3px;font-size:11px;cursor:pointer;margin-top:4px;
  touch-action:manipulation}
.tnt-btn:active{background:#3a3a3a}
.tnt-btn.tnt-btn-accent{background:#2aa198;color:#000;font-size:12px;padding:7px;margin:0 0 6px}
.tnt-btn.tnt-btn-accent:active{background:#1d7a72}
.tnt-export{background:#000;color:#b58900;font-family:monospace;font-size:11px;
  padding:7px;border-radius:3px;white-space:pre-wrap;word-break:break-all;
  max-height:110px;overflow-y:auto;margin:0}
`;
    document.head.appendChild(s);
  }

  // ── DOM ───────────────────────────────────────────────────────────────────

  _mount() {
    const c = this._cfg;
    this._el = document.createElement('div');
    this._el.className = 'tnt-panel-backdrop';
    this._el.innerHTML = `
<div class="tnt-panel-modal">
  <div class="tnt-ph">
    <span class="tnt-ph-title">TNT.js — Paramètres</span>
    <button class="tnt-ph-close">✕</button>
  </div>
  <div class="tnt-pb">

    <div class="tnt-card">
      <h4>Apparence</h4>
      <label>Contact<span class="val" data-v="contactSize">${c.contactSize}</span>
        <input type="range" data-s="contactSize" min="4" max="80" step="2" value="${c.contactSize}"></label>
      <label>Curseur<span class="val" data-v="cursorSize">${c.cursorSize}</span>
        <input type="range" data-s="cursorSize" min="4" max="60" step="2" value="${c.cursorSize}"></label>
      <label><input type="checkbox" data-s="rodEnabled" ${c.rodEnabled?'checked':''}> Barre</label>
      <label><input type="checkbox" data-s="pulseEnabled" ${c.pulseEnabled?'checked':''}> Pulse</label>
      ${this._drop ? `<label><input type="checkbox" data-s="dropEnabled" ${c.dropEnabled?'checked':''}> Curseur goutte</label>` : ''}
    </div>

    <div class="tnt-card">
      <h4>Cinématique & Temporel</h4>
      <label>Distance<span class="val" data-v="dist">${c.dist}</span>
        <input type="range" data-s="dist" min="20" max="200" step="10" value="${c.dist}"></label>
      <label>Tapping → Pressing<span class="val" data-v="tappingToPressingFrontier">${c.tappingToPressingFrontier}ms</span>
        <input type="range" data-s="tappingToPressingFrontier" min="100" max="2000" step="50" value="${c.tappingToPressingFrontier}"></label>
      <label>Pressing → LongPressing<span class="val" data-v="pressingToLongPressingFrontier">${c.pressingToLongPressingFrontier}ms</span>
        <input type="range" data-s="pressingToLongPressingFrontier" min="200" max="5000" step="50" value="${c.pressingToLongPressingFrontier}"></label>
    </div>

    <div class="tnt-card">
      <h4>Rendu</h4>
      <label>Marqueurs (fade)<span class="val" data-v="markerTtl">${c.markerTtl}ms</span>
        <input type="range" data-s="markerTtl" min="500" max="10000" step="100" value="${c.markerTtl}"></label>
      <label><input type="checkbox" data-s="trailEnabled" ${c.trailEnabled?'checked':''}> Traînée</label>
      <label>Traînée (fade)<span class="val" data-v="trailTtl">${c.trailTtl}ms</span>
        <input type="range" data-s="trailTtl" min="100" max="5000" step="100" value="${c.trailTtl}"></label>
    </div>

    <div class="tnt-card">
      <h4>État & Événements</h4>
      <div class="tnt-sbadge" data-role="state-badge">idle</div>
      <div class="tnt-ev-live" data-role="ev-live"></div>
      <div class="tnt-ev-hist" data-role="ev-hist"></div>
      <button class="tnt-btn" data-role="clear-ev">Effacer</button>
    </div>

    <div class="tnt-card">
      <h4>Historique des états</h4>
      <div class="tnt-hist" data-role="hist"></div>
      <button class="tnt-btn" data-role="clear-hist">Effacer</button>
    </div>

    <div class="tnt-card wide">
      <h4>Export</h4>
      <button class="tnt-btn tnt-btn-accent" data-role="export-btn">Copier la configuration</button>
      <pre class="tnt-export" data-role="export-code"></pre>
    </div>

  </div>
</div>`;

    document.body.appendChild(this._el);

    // Références
    this._badge    = this._el.querySelector('[data-role="state-badge"]');
    this._evLive   = this._el.querySelector('[data-role="ev-live"]');
    this._evHist   = this._el.querySelector('[data-role="ev-hist"]');
    this._hist     = this._el.querySelector('[data-role="hist"]');
    this._exportPre = this._el.querySelector('[data-role="export-code"]');

    this._el.querySelector('.tnt-ph-close').addEventListener('click', () => this.hide());

    // Sliders & checkboxes
    this._el.querySelectorAll('[data-s]').forEach(input => {
      const key = input.dataset.s;
      input.addEventListener('input', () => {
        const v = input.type === 'checkbox' ? input.checked : +input.value;
        this._cfg[key] = v;
        const valEl = this._el.querySelector(`[data-v="${key}"]`);
        if (valEl) valEl.textContent = this._isTime(key) ? v + 'ms' : v;
        this._apply(key, v);
        this._save();
        this._updateExport();
      });
    });

    this._el.querySelector('[data-role="clear-ev"]').addEventListener('click', () => {
      this._evHist.innerHTML = '';
      this._evLive.innerHTML = '';
    });
    this._el.querySelector('[data-role="clear-hist"]').addEventListener('click', () => {
      this._hist.innerHTML = '';
      this._histLastStamp = Date.now();
    });

    const exportBtn = this._el.querySelector('[data-role="export-btn"]');
    exportBtn.addEventListener('click', () => {
      const txt = this._buildExport();
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(txt).then(() => {
          exportBtn.textContent = '✓ Copié !';
          setTimeout(() => { exportBtn.textContent = 'Copier la configuration'; }, 1500);
        }).catch(() => this._fallbackCopy(txt));
      } else { this._fallbackCopy(txt); }
    });

    this._updateExport();
  }

  _isTime(key) {
    return key.includes('Frontier') || key.includes('Ttl') || key.includes('ttl');
  }

  // ── Application des réglages ──────────────────────────────────────────────

  _apply(key, v) {
    const ov  = this._ov;
    const eng = this._eng;
    switch (key) {
      case 'contactSize':                    ov.contactSize  = v; if (this._drop) this._drop.size   = v; break;
      case 'cursorSize':                     ov.cursorSize   = v; break;
      case 'rodEnabled':                     ov.rodEnabled   = v; break;
      case 'pulseEnabled':                   ov.pulseEnabled = v; break;
      case 'dist':                           eng.dist = v; ov.kine.dist = v; if (this._drop) this._drop.height = v; break;
      case 'tappingToPressingFrontier':      eng.tappingToPressingFrontier      = v; break;
      case 'pressingToLongPressingFrontier': eng.pressingToLongPressingFrontier = v; break;
      case 'dropEnabled':                    if (this._drop) this._drop.enabled = v; break;
      // markerTtl, trailTtl, trailEnabled → lus via getters par index.html
    }
  }

  // ── Événements moteur ─────────────────────────────────────────────────────

  _bindEngine() {
    const eng = this._eng;

    eng.on('stateChange', e => {
      this._badge.textContent  = e.state;
      this._badge.className    = 'tnt-sbadge ' + e.state;
      this._addHist(e.state);
      this._drop.interactive   = (e.state === 'idle');
    });

    const show = (n, d, live) => this._showEv(n, d, live);
    eng.on('tap',       e => show('tap',       e));
    eng.on('press',     e => show('press',     e));
    eng.on('longPress', e => show('longPress', e));
    eng.on('cancel',    e => show('cancel',    e));
    eng.on('tntBang',   e => show('tntBang',   e));
    eng.on('cursorActivate', e => show('cursorActivate', e));
    eng.on('cursorMove',     e => show('cursorMove',     e, true));
    eng.on('cursorRelease',  e => show('cursorRelease',  e));
    eng.on('cancelCursor',   e => show('cancelCursor',   e));
    eng.on('pinchStart',  e => show('pinchStart',  e));
    eng.on('pinchChange', e => show('pinchChange', e, true));
    eng.on('pinchEnd',    e => show('pinchEnd',    e));
    eng.on('catchAt',   e => show('catchAt',   e));
    eng.on('catchMove', e => show('catchMove',  e, true));
    eng.on('catchDrop', e => show('catchDrop',  e));

    if (this._drop) {
      this._drop.on('click',  e => show('drop:click',  e));
      this._drop.on('move',   e => show('drop:move',   e));
      this._drop.on('orient', e => show('drop:orient', e));
    }
  }

  _showEv(name, data, live = false) {
    const html = this._fmtEv(name, data);
    if (live) {
      let row = this._evLive.querySelector(`[data-ev="${name}"]`);
      if (!row) {
        row = document.createElement('div');
        row.className = 'tnt-ev tnt-ev-live-row';
        row.dataset.ev = name;
        this._evLive.appendChild(row);
      }
      row.innerHTML = html;
    } else {
      const row = document.createElement('div');
      row.className = 'tnt-ev';
      row.innerHTML = html;
      this._evHist.prepend(row);
      while (this._evHist.children.length > 80) this._evHist.removeChild(this._evHist.lastChild);
    }
  }

  _fmtEv(name, data) {
    let s = `<span class="tnt-ev-label">${name}</span>`;
    if (!data) return s;
    const m = (v) => `<span class="tnt-ev-meta">${v}</span>`;
    if (data.state      !== undefined) s += ' ' + m(`[${data.state}]`);
    if (data.intensity  !== undefined) s += ' ' + m(`i:${data.intensity.toFixed(2)}`);
    if (data.msAfterMin !== undefined) s += ' ' + m(`+${data.msAfterMin|0}ms`);
    if (data.precision  !== undefined) s += ' ' + m(`p:${data.precision|0}`);
    if (data.x          !== undefined) s += ` x:${data.x|0}`;
    if (data.y          !== undefined) s += ` y:${data.y|0}`;
    if (data.touchX     !== undefined) s += ` tx:${data.touchX|0}`;
    if (data.touchY     !== undefined) s += ` ty:${data.touchY|0}`;
    if (data.x1         !== undefined) s += ` (${data.x1|0},${data.y1|0})→(${data.x2|0},${data.y2|0})`;
    if (data.scale      !== undefined) s += ' ' + m(`sc:${data.scale.toFixed(2)}`);
    if (data.angle      !== undefined) s += ' ' + m(`∠${data.angle.toFixed(1)}°`);
    if (data.duration   !== undefined) s += ' ' + m(`${data.duration|0}ms`);
    return s;
  }

  // ── Historique des états ──────────────────────────────────────────────────

  _addHist(state) {
    const now = Date.now();
    const dur = now - this._histLastStamp;
    this._histLastStamp = now;

    const row   = document.createElement('div');
    row.className = 'tnt-hrow';
    const badge = document.createElement('span');
    badge.className = 'tnt-hbadge ' + state;
    badge.textContent = state;
    const durEl = document.createElement('span');
    durEl.className = 'tnt-hdur';
    durEl.textContent = dur < 10000 ? `${dur}ms` : `${(dur/1000).toFixed(1)}s`;
    row.appendChild(badge);
    row.appendChild(durEl);
    this._hist.prepend(row);
    while (this._hist.children.length > 60) this._hist.removeChild(this._hist.lastChild);
  }

  // ── Export ────────────────────────────────────────────────────────────────

  _buildExport() {
    const c = this._cfg;
    return JSON.stringify({
      dist: c.dist,
      tappingToPressingFrontier:      c.tappingToPressingFrontier,
      pressingToLongPressingFrontier: c.pressingToLongPressingFrontier,
      contactSize:  c.contactSize,
      cursorSize:   c.cursorSize,
      rodEnabled:   c.rodEnabled,
      pulseEnabled: c.pulseEnabled,
    }, null, 2);
  }

  _updateExport() { this._exportPre.textContent = this._buildExport(); }

  _fallbackCopy(txt) {
    const ta = document.createElement('textarea');
    ta.value = txt;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch {}
    document.body.removeChild(ta);
  }
}

export { TouchEngine, CursorKinematics, TouchOverlay, DropCursor, TouchPanel };
