# TNT.js — Dossier d'intégration

**Version 0.8.5** — Touch & No-Touch  
Module ES, zéro dépendance, surfaces tactiles uniquement.

---

## Problème résolu

Sur mobile, le doigt masque ce qu'il touche. TNT déplace le point de pointage actif **au-dessus du doigt** via un curseur déporté maintenu à distance fixe par une barre rigide. Précision maximale pour manipuler des objets fins (briques, pièces).

```
  ╭──────────╮
  │  doigt   │  ← contact réel (masqué)
  ╰────┬─────╯
       │  barre rigide (dist px)
     ╭─▼─╮
     │ ● │  ← curseur de travail (visible, précis)
     ╰───╯
```

---

## Intégration minimale

```js
import { TouchOverlay } from './tnt.js';

const overlay = new TouchOverlay(document.getElementById('stage'), {
  dist: 80,          // distance barre (px)
  tappingToPressingFrontier:      400,   // tap < 400ms
  pressingToLongPressingFrontier: 1400,  // press < 1400ms, longPress au-delà
});

// Accès au moteur pour s'abonner aux événements
const engine = overlay.engine;

engine.on('tap',       e => { /* sélection */ });
engine.on('longPress', e => { /* suppression */ });
engine.on('cursorMove', e => { /* déplacement */ });
engine.on('pinchChange', e => { /* zoom */ });
engine.on('catchMove',   e => { /* pan */ });
```

**Contrainte de positionnement** : `TouchOverlay` force automatiquement `position:relative` sur le container s'il est en `position:static`. Le container ne doit pas avoir de `padding` ni de `border` — ou alors en tenir compte dans les coordonnées reçues.

---

## Système de coordonnées

Toutes les coordonnées `x, y` émises dans les événements sont **relatives au container** (origin = coin haut-gauche du border-box du container).

```
container (0,0)
  ┌──────────────────────────────┐
  │                              │
  │         doigt → (230, 410)   │
  │                              │
  └──────────────────────────────┘
```

`getBoundingClientRect()` est mis en cache au début de chaque geste — si le container se déplace pendant un geste (scroll, animation), les coordonnées peuvent dériver légèrement.

---

## Machine à états

```
                 ┌──────────────────────────────────────────────────────────┐
                 │                    5 doigts (tout état)                  │
                 ▼                                                          │
IDLE ─(1 doigt)──► TAPPING ─(dépl. ≥ dist)──► GRABBING ─(relâché)──────► IDLE
                      │                                                     ▲
                      ├──(tappingToPressingFrontier)──► PRESSING           │
                      │                    │                               │
                      │    (pressingToLongPressingFrontier − frontier1)    │
                      │                    │                               │
                      │               LONGPRESSING                         │
                      │                    │                               │
                      └──(2e doigt)──► [discrimination dist/4]             │
                                          │                                │
                               ┌──────────┴──────────┐                    │
                  dist change  │                      │  centre bouge      │
                               ▼                      ▼                    │
                           PINCHING              CATCHING                  │
                               └──────────────────────┴──(relâché)────────┘
```

### Seuil de discrimination pinch / catch

Après la pose du 2e doigt, le premier mouvement décide :
- **distance inter-doigts change ≥ `dist/4`** → `pinching`
- **centre des doigts se déplace ≥ `dist/4`** (distance stable) → `catching`

---

## Référence des événements

Toutes les coordonnées sont relatives au container.

### Gestes à 1 doigt

| Événement | Payload | Description |
|---|---|---|
| `tap` | `{ x, y, intensity, precision }` | Contact bref relâché avant `tappingToPressingFrontier` |
| `press` | `{ x, y, intensity, precision }` | Contact moyen (entre les deux frontières) |
| `longPress` | `{ x, y, msAfterMin, precision }` | Contact long (au-delà de `pressingToLongPressingFrontier`) |
| `cancel` | `{ x, y, state }` | Press/longPress annulé par déplacement ≥ `dist` |

**`intensity`** `[0–1]` :
- `tap` : `dt / tappingToPressingFrontier` — 0 = tap vif, 1 = tap à la limite du press
- `press` : `(dt − b1) / (b2 − b1)` où `b1` = `tappingToPressingFrontier`, `b2` = `pressingToLongPressingFrontier`

**`precision`** : distance max (px) parcourue par le doigt depuis le départ. Proche de 0 = doigt immobile.

> Aucune zone morte : chaque relâché émet exactement un événement (`tap`, `press` ou `longPress`).

### Curseur déporté (grab)

| Événement | Payload | Description |
|---|---|---|
| `cursorActivate` | `{ x, y, touchX, touchY, state }` | Grab commence, curseur apparu |
| `cursorMove` | `{ x, y, touchX, touchY, state }` | Doigt se déplace |
| `cursorRelease` | `{ x, y, activatedAt, vector, state }` | Doigt relevé |
| `cancelCursor` | `{ x, y, state }` | Annulé par 5 doigts |

- `x, y` : position du **curseur déporté** (point de travail)
- `touchX, touchY` : position du **doigt** (contact réel)
- `activatedAt` : position du curseur à l'activation
- `vector` : `{ x, y }` déplacement total depuis l'activation

### Pinch (2 doigts, distance change)

| Événement | Payload | Description |
|---|---|---|
| `pinchStart` | `{ scale, x1, y1, x2, y2, state }` | Pinch commence |
| `pinchChange` | `{ scale, x1, y1, x2, y2, state }` | En cours |
| `pinchEnd` | `{ scale, duration, state }` | Terminé |

- `scale` : ratio distance courante / initiale. `1.0` = inchangé, `> 1` = écartement, `< 1` = rapprochement
- `x1,y1,x2,y2` : positions individuelles des deux doigts

### Catch (2 doigts, translation ensemble)

| Événement | Payload | Description |
|---|---|---|
| `catchAt` | `{ x, y, x1, y1, x2, y2, state }` | Catch commence |
| `catchMove` | `{ x, y, x1, y1, x2, y2, state }` | En cours |
| `catchDrop` | `{ x, y, state }` | Terminé |

- `x, y` : centre entre les deux doigts (point de travail)
- `x1,y1,x2,y2` : positions individuelles

### Divers

| Événement | Payload | Description |
|---|---|---|
| `stateChange` | `{ state }` | Émis à chaque transition d'état |

---

## Scénarios d'intégration — assemblage de briques

### Sélectionner une brique (tap)

```js
engine.on('tap', ({ x, y, intensity, precision }) => {
  const brick = board.brickAt(x, y);
  if (!brick) return;

  if (intensity < 0.3) {
    board.select(brick);              // tap vif → sélection simple
  } else {
    board.selectWithTooltip(brick);   // tap appuyé → info contextuelle
  }
});
```

### Déplacer une brique (grab)

Le curseur déporté permet de voir la cible sous le doigt.

```js
let dragged = null;

engine.on('cursorActivate', ({ x, y, touchX, touchY }) => {
  dragged = board.brickAt(x, y);
  if (dragged) board.beginDrag(dragged);
});

engine.on('cursorMove', ({ x, y }) => {
  // x, y = position du curseur déporté = point de dépôt visé
  if (dragged) board.moveDragTo(x, y);
});

engine.on('cursorRelease', ({ x, y }) => {
  if (dragged) { board.dropAt(x, y); dragged = null; }
});

engine.on('cancelCursor', () => {
  if (dragged) { board.cancelDrag(); dragged = null; }
});
```

### Supprimer une brique (longPress)

```js
engine.on('longPress', ({ x, y, precision }) => {
  if (precision < 15) {              // doigt n'a pas bougé
    const brick = board.brickAt(x, y);
    if (brick) board.remove(brick);
  }
});

engine.on('cancel', () => board.cancelPendingAction());
```

### Zoomer la vue (pinch)

```js
let baseScale = 1;

engine.on('pinchStart', () => { baseScale = board.scale; });

engine.on('pinchChange', ({ scale }) => {
  board.scale = Math.max(0.25, Math.min(8, baseScale * scale));
});
```

### Déplacer la vue (catch)

```js
let panOrigin = null;
let viewOrigin = null;

engine.on('catchAt', ({ x, y }) => {
  panOrigin  = { x, y };
  viewOrigin = { ...board.viewOffset };
});

engine.on('catchMove', ({ x, y }) => {
  board.viewOffset = {
    x: viewOrigin.x + (x - panOrigin.x),
    y: viewOrigin.y + (y - panOrigin.y),
  };
});
```

---

## Options de configuration

### `TouchEngine` (via `TouchOverlay`)

| Option | Défaut | Description |
|---|---|---|
| `dist` | `80` | Distance barre (px) et seuil de déclenchement du grab |
| `tappingToPressingFrontier` | `500` | Frontière (ms) tapping → pressing |
| `pressingToLongPressingFrontier` | `1500` | Frontière (ms) pressing → longPressing |

Toutes modifiables à l'exécution : `engine.dist = 60`, `engine.tappingToPressingFrontier = 400`, etc.

### `TouchOverlay` (visuels)

| Option | Défaut | Description |
|---|---|---|
| `contactSize` | `24` | Diamètre point de contact (px) |
| `cursorSize` | `14` | Diamètre curseur déporté (px) |
| `rodEnabled` | `true` | Affiche la barre grab |
| `pulseEnabled` | `true` | Animation pulse au début du grab |

Modifiables à l'exécution : `overlay.contactSize = 28`, etc.

### `CursorKinematics` (via `overlay.kine`)

| Option | Défaut | Description |
|---|---|---|
| `dist` | `80` | Distance fixe doigt → curseur (px) |

---

## Rendu visuel fourni par `TouchOverlay`

`TouchOverlay` injecte tous les éléments DOM directement dans le container. Aucun élément HTML ni CSS n'est à ajouter.

| Geste | Couleur | Éléments |
|---|---|---|
| Grab | rouge / vert | Point contact (rouge), curseur (vert), barre (gris) |
| Pinch | orange `#f80` | 2 points + barre + centre creux |
| Catch | bleu `#08f` | 2 points + barre + centre creux |

---

## Détruire proprement

```js
overlay.engine.destroy(); // retire tous les listeners touch
```

---

## Notes importantes

- **Touch uniquement** — aucun support souris. Tester sur appareil réel ou émulateur tactile.
- **Pas de padding sur le container** — les coordonnées sont relatives au border-box. Un padding décalerait l'origine.
- **`touchAction: none`** sur le container — nécessaire pour empêcher le scroll natif du navigateur d'interférer.
- **5 doigts** — n'importe quel état est annulé proprement si 5 doigts ou plus sont détectés.
- **Discrimination pinch/catch** — le seuil est `dist / 4` (20 px par défaut). Un mouvement trop court avant de lever un doigt peut ne pas être discriminé → `idle` silencieux.
