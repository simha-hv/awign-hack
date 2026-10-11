import {
  defaultName,
  JOIN_PATH_PREFIX,
  tokenStorageKey,
  WS_PATH,
  type ControlMessage,
} from '@brawl/protocol';
import { WsLink, wsUrlFor } from '@brawl/protocol/ws-link.js';

import { Buttons } from './buttons.js';
import { CustomiseSheet, loadPreferences, savePreferences } from './customise.js';
import { NameGate } from './name-gate.js';
import { Stick } from './stick.js';
import { InputTicker } from './ticker.js';
import { ControllerWsTransport } from './transport-ws.js';
import { WakeLock } from './wakelock.js';

/**
 * The phone. It is a gamepad, not a game client: it sends input snapshots
 * and receives lobby/UI state only. It never learns where anything is.
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  app: $('app'),
  status: $('status'),
  statusDot: $('statusDot'),
  you: $<HTMLButtonElement>('you'),
  youLabel: $('youLabel'),
  slot: $('slot'),
  stickZone: $('stickZone'),
  stickBase: $('stickBase'),
  stickKnob: $('stickKnob'),
  stickLabel: $('stickLabel'),
  btnA: $('btnA'),
  btnB: $('btnB'),
  btnC: $('btnC'),
  editHint: $('editHint'),
  sheet: $('sheet'),
  sheetPanel: $('sheetPanel'),
  sheetClose: $<HTMLButtonElement>('sheetClose'),
  nameInput: $<HTMLInputElement>('nameInput'),
  nameHint: $('nameHint'),
  colorGrid: $('colorGrid'),
  gameBanner: $('gameBanner'),
  gameTitle: $('gameTitle'),
  gameDetail: $('gameDetail'),
  coach: $('coach'),
  coachGoal: $('coachGoal'),
  coachKeys: $('coachKeys'),
  rotateAnyway: $<HTMLButtonElement>('rotateAnyway'),
  rotateGo: $<HTMLButtonElement>('rotateGo'),
  rotateTitle: $<HTMLElement>('rotateTitle'),
  rotateBody: $<HTMLElement>('rotateBody'),
  overlay: $('overlay'),
  overlayTitle: $('overlayTitle'),
  overlayBody: $('overlayBody'),
  overlayAction: $('overlayAction'),
  nameGate: $('nameGate'),
  nameGateForm: $<HTMLFormElement>('nameGateForm'),
  nameGateInput: $<HTMLInputElement>('nameGateInput'),
  nameGateHint: $('nameGateHint'),
  nameGateGo: $<HTMLButtonElement>('nameGateGo'),
};

/* ------------------------------ room + token ----------------------------- */

/** Code comes from the URL: /brawl-games/j/ABCD */
function codeFromUrl(): string {
  const path = location.pathname;
  const i = path.indexOf(JOIN_PATH_PREFIX);
  if (i < 0) return '';
  return path.slice(i + JOIN_PATH_PREFIX.length).split('/')[0]!.toUpperCase();
}

const CODE = codeFromUrl();

/**
 * Token persistence.
 *
 * sessionStorage is the primary store — it is per-tab, so two people sharing
 * a phone in different tabs get different slots, which is correct.
 *
 * localStorage is a fallback read for the case sessionStorage cannot cover:
 * scanning the QR again opens a NEW tab, which starts with an empty
 * sessionStorage and would otherwise burn a fresh slot while the old one sits
 * in its grace window. Both writes happen once at join, so this costs two
 * string writes per session and nothing per frame.
 */
function loadToken(): string | undefined {
  const key = tokenStorageKey(CODE);
  try {
    const fromSession = sessionStorage.getItem(key);
    if (fromSession) return fromSession;
  } catch {
    /* private mode */
  }
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function saveToken(token: string): void {
  const key = tokenStorageKey(CODE);
  try {
    sessionStorage.setItem(key, token);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(key, token);
  } catch {
    /* ignore */
  }
}

function clearToken(): void {
  const key = tokenStorageKey(CODE);
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ------------------------------- orientation ------------------------------ */

/**
 * Landscape is the intended grip, and the prompt is a request rather than a
 * gate.
 *
 * There is no reliable way to force it: `screen.orientation.lock()` requires
 * fullscreen, throws on desktop, and does not exist on iOS Safari at all. More
 * importantly, plenty of people play with the system rotation lock switched on
 * — for them the phone will NEVER turn, so a hard block would strand them on a
 * screen they cannot get past. Hence the escape hatch.
 */
const PORTRAIT_OK_KEY = 'brawl:portrait-ok';

try {
  if (sessionStorage.getItem(PORTRAIT_OK_KEY) === '1') el.app.classList.add('portrait-ok');
} catch {
  /* private mode; the prompt simply shows again */
}

el.rotateAnyway.addEventListener('click', () => {
  el.app.classList.add('portrait-ok');
  try {
    // Session, not local: a decision about how you are holding the phone right
    // now should not follow you into next week's game.
    sessionStorage.setItem(PORTRAIT_OK_KEY, '1');
  } catch {
    /* ignore */
  }
});

function lockLandscape(): void {
  // Wrapped because the sync throw on unsupported platforms would take the
  // caller with it.
  try {
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (o: string) => Promise<void>;
    };
    void orientation?.lock?.('landscape').catch(() => {});
  } catch {
    /* not available; the prompt covers it */
  }
}

/**
 * Android (and most non-iOS browsers): one tap goes full screen and locks the
 * phone sideways. That turns the phone for you, even with auto-rotate off, and
 * hides the browser's tabs and address bar so the controls get the whole
 * screen. iPhone has neither API, so there the prompt just asks.
 */
const canFullscreen = !!document.documentElement.requestFullscreen && document.fullscreenEnabled !== false;

function goLandscape(): void {
  if (!canFullscreen || document.fullscreenElement) return lockLandscape();
  document.documentElement
    .requestFullscreen({ navigationUI: 'hide' })
    .then(lockLandscape, () => {});
}

if (canFullscreen) {
  el.rotateTitle.textContent = 'Play sideways';
  el.rotateBody.textContent = 'One tap turns your phone into the controller.';
  el.rotateGo.hidden = false;
  el.rotateGo.addEventListener('click', goLandscape);
}
lockLandscape();

// Back in, e.g. after a reload: the first tap on the pad goes sideways too.
let triedLandscape = false;
function landscapeOnFirstTap(): void {
  if (triedLandscape || !canFullscreen || document.fullscreenElement) return;
  triedLandscape = true;
  goLandscape();
}

/* -------------------------------- controls -------------------------------- */

/**
 * Relabel the pad for the game being played.
 *
 * The same three buttons drive three different games, and in TEMPLE DASH A
 * shoves and B slides. A button that says PUNCH and then slides is worse than
 * a blank one, so the host sends the words with every status update and the
 * pad simply prints them.
 */
let controlsKey = '';

function applyControls(c: { a: string; b: string; c: string }, game?: string): void {
  const key = `${c.a}|${c.b}|${c.c}|${game ?? ''}`;
  if (key === controlsKey) return;
  controlsKey = key;
  for (const [btn, label] of [
    [el.btnA, c.a],
    [el.btnB, c.b],
    [el.btnC, c.c],
  ] as const) {
    const b = btn.querySelector('b');
    if (b) b.textContent = label;
  }
  el.coachKeys.textContent = `DRAG TO MOVE · A ${c.a} · B ${c.b} · C ${c.c}`;
  if (game) el.coachGoal.textContent = game;
}

/* --------------------------------- coach --------------------------------- */

/**
 * The one-line "what am I supposed to do" prompt.
 *
 * Shown from the moment the phone connects and taken down a few seconds into
 * the first round the player is actually alive for — then never again. That
 * rule matters more than it looks:
 *
 *  - It covers the person who joins MID-ROUND. They sit out as a spectator
 *    until the next round, which is precisely the window in which they have
 *    nothing to do but read, and an earlier version hid the prompt from them
 *    for exactly that reason.
 *  - It does not reappear every round. By the third round a banner explaining
 *    the controls is noise sitting on top of the controls.
 *
 * Driven entirely off the phase the host already sends, so it needs no new
 * message and cannot drift out of sync with the game.
 */
const COACH_LINGER_MS = 4500;
let coachDone = false;
let coachTimer: ReturnType<typeof setTimeout> | null = null;

function clearCoachTimer(): void {
  if (coachTimer !== null) {
    clearTimeout(coachTimer);
    coachTimer = null;
  }
}

function updateCoach(phase: string, alive: boolean): void {
  if (coachDone) return;

  el.coach.hidden = false;
  el.coach.classList.remove('fading');

  // Only a round you are actually playing starts the countdown to retiring it.
  if (phase !== 'playing' || !alive) {
    clearCoachTimer();
    return;
  }
  if (coachTimer !== null) return;

  coachTimer = setTimeout(() => {
    coachDone = true;
    el.coach.classList.add('fading');
    coachTimer = setTimeout(() => {
      el.coach.hidden = true;
      coachTimer = null;
    }, 400);
  }, COACH_LINGER_MS);
}

/* -------------------------------- wiring --------------------------------- */

const stick = new Stick(el.stickZone, el.stickBase, el.stickKnob, el.stickLabel);
const buttons = new Buttons(el.btnA, el.btnB, el.btnC);
const link = new WsLink(wsUrlFor(WS_PATH), true);
const transport = new ControllerWsTransport(link);
const ticker = new InputTicker(transport, stick, buttons);
const wakeLock = new WakeLock();

const sheet = new CustomiseSheet({
  sheet: el.sheet,
  panel: el.sheetPanel,
  open: el.you,
  close: el.sheetClose,
  nameInput: el.nameInput,
  nameHint: el.nameHint,
  colorGrid: el.colorGrid,
});

let joined = false;

sheet.onChange = (patch) => {
  if (!joined) return;
  link.sendControl({ t: 'set_profile', ...patch });
};

const nameGate = new NameGate({
  gate: el.nameGate,
  form: el.nameGateForm,
  input: el.nameGateInput,
  hint: el.nameGateHint,
  go: el.nameGateGo,
});

nameGate.onSubmit = (name) => {
  if (joined) link.sendControl({ t: 'set_profile', name });
  // The I'M IN! tap is a user gesture, so it can turn the phone sideways.
  triedLandscape = true;
  goLandscape();
};

/** Either panel over the pad: touches belong to it, not to the controls. */
const panelOpen = (): boolean => sheet.isOpen || nameGate.isOpen;

sheet.onVisibility = nameGate.onVisibility = (open) => {
  if (!open) return;
  // Drop every held touch when the sheet opens, so a thumb that was mid-drag
  // does not leave the character walking into a wall behind the panel.
  stick.reset();
  buttons.reset();
  if (link.isOpen && ticker.running) ticker.flushNeutral();
};

/* ------------------------------ touch input ------------------------------ *
 * Every handler walks `changedTouches` and dispatches by `identifier`.
 * Never `touches[0]` — with a thumb on the stick and a thumb on a button the
 * indices shuffle constantly, and index-based code produces a stick that
 * jumps to the button whenever the other thumb lifts.
 * ------------------------------------------------------------------------ */

function onTouchStart(event: TouchEvent): void {
  if (panelOpen()) return;
  for (const touch of Array.from(event.changedTouches)) {
    // Buttons first: they sit inside the right zone and are smaller targets.
    if (buttons.tryClaim(touch)) continue;
    stick.tryClaim(touch);
  }
  event.preventDefault();
}

function onTouchMove(event: TouchEvent): void {
  // The sheet is the one place scrolling is allowed, so bail before
  // preventDefault — otherwise the colour grid cannot be scrolled to.
  if (panelOpen()) return;
  for (const touch of Array.from(event.changedTouches)) {
    if (stick.owns(touch.identifier)) stick.move(touch);
    // Buttons intentionally ignore movement: sliding off a held button keeps
    // it held, which is how every physical gamepad behaves.
  }
  event.preventDefault();
}

function onTouchEnd(event: TouchEvent): void {
  if (panelOpen()) return;
  for (const touch of Array.from(event.changedTouches)) {
    stick.release(touch.identifier);
    buttons.release(touch.identifier);
  }
  event.preventDefault();
  if (event.touches.length === 0) landscapeOnFirstTap();
}

// Non-passive so preventDefault actually suppresses scroll/zoom gestures.
const opts: AddEventListenerOptions = { passive: false };
el.app.addEventListener('touchstart', onTouchStart, opts);
// move/end on window: a thumb that slides off the zone must keep tracking.
window.addEventListener('touchmove', onTouchMove, opts);
window.addEventListener('touchend', onTouchEnd, opts);
window.addEventListener('touchcancel', onTouchEnd, opts);

// Desktop dev convenience: WASD + J/K, so the host can be tested without a phone.
installKeyboardFallback();

/* -------------------------------- control -------------------------------- */

function setStatus(text: string, tone: 'ok' | 'warn' | 'bad'): void {
  el.status.textContent = text;
  el.statusDot.dataset.tone = tone;
}

function showOverlay(title: string, body: string, action?: { label: string; onTap: () => void }): void {
  el.overlayTitle.textContent = title;
  el.overlayBody.textContent = body;
  if (action) {
    el.overlayAction.textContent = action.label;
    el.overlayAction.hidden = false;
    el.overlayAction.onclick = action.onTap;
  } else {
    el.overlayAction.hidden = true;
  }
  el.overlay.hidden = false;
}

const hideOverlay = (): void => {
  el.overlay.hidden = true;
};

/** Paint the profile the server says is in effect. Never applied optimistically. */
function applyProfile(profile: { name: string; color: string; colorName: string }): void {
  document.documentElement.style.setProperty('--player', profile.color);
  el.youLabel.textContent = profile.name
    ? profile.name.toUpperCase()
    : `YOU ARE ${profile.colorName}`;
  sheet.setProfile({ name: profile.name, color: profile.color });
}

function onControl(msg: ControlMessage): void {
  switch (msg.t) {
    case 'joined': {
      joined = true;
      saveToken(msg.token);
      hideOverlay();

      el.slot.textContent = defaultName(msg.slot);
      el.editHint.hidden = false;
      setStatus(msg.resumed ? 'reconnected' : 'connected', 'ok');

      sheet.setOwnSlot(msg.slot);
      sheet.setTaken(msg.taken);
      applyProfile(msg);

      ticker.start();
      void wakeLock.acquire();

      // Reuse the name from a previous room, if this player has played
      // before. Sent after joining, so it never delays getting in.
      if (!msg.resumed) {
        const prefs = loadPreferences();
        if (!msg.name && prefs) link.sendControl({ t: 'set_profile', name: prefs.name });
        // Ask every fresh join for a name; a reconnect keeps the one it had.
        nameGate.open(msg.name || prefs?.name || '');
      }
      return;
    }

    case 'profile': {
      applyProfile(msg);
      savePreferences({ name: msg.name });
      if (msg.error) sheet.showError(msg.error);
      return;
    }

    case 'game_ui': {
      // UI status only — a banner and whether the controls read as live. The
      // phone still has no idea where anything is; it is a gamepad.
      const showBanner = msg.phase !== 'playing';
      el.gameBanner.hidden = !showBanner;
      // Replay the punch-in whenever the call-out changes ("3" -> "2" -> ...).
      if (el.gameTitle.textContent !== msg.title) {
        el.gameTitle.style.animation = 'none';
        void el.gameTitle.offsetWidth;
        el.gameTitle.style.animation = '';
      }
      el.gameTitle.textContent = msg.title;
      if (msg.controls) applyControls(msg.controls, msg.game);
      // Digit-sized only for an actual digit. Some games say "On your marks"
      // during their countdown, and at 90px that runs under the buttons.
      el.gameTitle.classList.toggle('count', msg.phase === 'countdown' && msg.title.trim().length <= 3);
      el.gameDetail.textContent = msg.detail;
      el.app.classList.toggle('out', !msg.youAlive);
      updateCoach(msg.phase, msg.youAlive);
      return;
    }

    case 'lobby':
      // The only state a phone ever gets. No positions, no scores.
      setStatus(`connected · ${msg.playerCount} playing`, 'ok');
      // Put the prompt up as soon as we are in a room, rather than waiting for
      // the first game_ui — the host may still be loading the 3D engine, and
      // that wait is the best possible moment to read one line of instructions.
      updateCoach('lobby', false);
      // Keeps an open colour picker honest as people join, leave or recolour.
      sheet.setTaken(msg.taken);
      return;

    case 'join_error': {
      joined = false;
      ticker.stop();
      // A stale token pointing at a dead room must not wedge us in a retry
      // loop — drop it so the next attempt joins fresh.
      if (msg.reason === 'no_room') clearToken();
      showOverlay(
        msg.reason === 'room_full' ? 'Room is full' : 'Room not found',
        msg.reason === 'room_full'
          ? 'All four slots are taken. Try again when someone drops out.'
          : 'That game has ended. Scan the code on the big screen again.',
        { label: 'Retry', onTap: () => location.reload() },
      );
      return;
    }

    case 'host_gone':
      joined = false;
      ticker.stop();
      showOverlay('Game ended', 'The big screen disconnected.', {
        label: 'Retry',
        onTap: () => location.reload(),
      });
      return;

    default:
      return;
  }
}

link.onControl(onControl);

link.onOpen(() => {
  setStatus(joined ? 'reconnecting…' : 'joining…', 'warn');
  const token = loadToken();
  link.sendControl(token ? { t: 'join', code: CODE, token } : { t: 'join', code: CODE });
});

link.onClosed(({ willRetry }) => {
  ticker.stop();
  if (willRetry) setStatus('reconnecting…', 'warn');
  else setStatus('disconnected', 'bad');
});

/* ----------------------------- app lifecycle ----------------------------- */

const detachWakeLock = wakeLock.attach();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // Drop every held touch and tell the host to stop the character. Without
    // this the last non-zero axes stand for the full silence timeout and the
    // circle keeps sliding after the player has switched apps.
    stick.reset();
    buttons.reset();
    if (link.isOpen) ticker.flushNeutral();
    ticker.stop();
    return;
  }

  // Back in the foreground: reconnect now rather than waiting out the backoff,
  // and resume sending only once the join is re-acknowledged.
  link.poke();
  if (joined && link.isOpen) ticker.start();
});

window.addEventListener('pagehide', () => {
  ticker.stop();
  void wakeLock.release();
  detachWakeLock();
});

/* --------------------------------- boot ---------------------------------- */

if (!CODE || CODE.length !== 4) {
  showOverlay('No room code', 'Scan the QR code on the big screen to join.');
} else {
  setStatus('connecting…', 'warn');
  // transport.connect() attaches to the link and opens it if nobody has yet.
  // WsLink.connect() is idempotent, so the ordering here does not matter.
  void transport.connect();
}

/* ------------------------------ dev fallback ----------------------------- */

function installKeyboardFallback(): void {
  // Only useful on a desktop browser; harmless on a phone.
  if (matchMedia('(pointer: coarse)').matches) return;

  const held = new Set<string>();
  const axis = (): void => {
    stick.x = (held.has('d') ? 1 : 0) - (held.has('a') ? 1 : 0);
    stick.y = (held.has('s') ? 1 : 0) - (held.has('w') ? 1 : 0);
  };

  addEventListener('keydown', (e) => {
    // Typing a name is not steering.
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    if (held.has(k)) return;
    held.add(k);
    if (k === 'j') el.btnA.dispatchEvent(new Event('devpress'));
    if (k === 'k') el.btnB.dispatchEvent(new Event('devpress'));
    if (k === 'l') el.btnC.dispatchEvent(new Event('devpress'));
    axis();
  });
  addEventListener('keyup', (e) => {
    held.delete(e.key.toLowerCase());
    axis();
  });

  // Reuse the real click path so the counter logic stays single-sourced.
  for (const [el2, key] of [
    [el.btnA, 'j'],
    [el.btnB, 'k'],
    [el.btnC, 'l'],
  ] as const) {
    el2.addEventListener('devpress', () => {
      const fake = { identifier: key === 'j' ? -101 : key === 'k' ? -102 : -103, clientX: 0, clientY: 0 } as Touch;
      // Bypass hit testing for the synthetic press.
      const rect = el2.getBoundingClientRect();
      Object.assign(fake, {
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      });
      buttons.tryClaim(fake);
      setTimeout(() => buttons.release(fake.identifier), 80);
    });
  }
}
