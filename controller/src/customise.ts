import {
  NAME_MAX_LENGTH,
  PALETTE,
  PROFILE_STORAGE_KEY,
  sanitizeName,
  type ColorClaim,
} from '@brawl/protocol';

/**
 * The customise sheet: name and colour.
 *
 * Opened only AFTER the player is already in the game. Nothing here blocks
 * joining — a player scans, plays immediately with an auto-assigned colour,
 * and changes their identity whenever they feel like it, mid-match included.
 *
 * The server is authoritative on both fields, so this never applies a
 * change optimistically. A colour two people tap at the same instant would
 * otherwise show as "mine" on both phones and then flicker back on one.
 */

export interface ProfileState {
  name: string;
  color: string;
}

/** The name is remembered across rooms; colour depends on who else is there. */
export interface StoredPreferences {
  name: string;
}

export function loadPreferences(): StoredPreferences | null {
  try {
    const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPreferences>;
    const name = sanitizeName(parsed.name ?? '');
    return name ? { name } : null;
  } catch {
    return null;
  }
}

export function savePreferences(prefs: StoredPreferences): void {
  try {
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode — preferences just do not persist */
  }
}

export interface SheetElements {
  sheet: HTMLElement;
  panel: HTMLElement;
  open: HTMLButtonElement;
  close: HTMLButtonElement;
  nameInput: HTMLInputElement;
  nameHint: HTMLElement;
  colorGrid: HTMLElement;
}

export class CustomiseSheet {
  private colorButtons = new Map<string, HTMLButtonElement>();
  private taken: ColorClaim[] = [];
  private state: ProfileState = { name: '', color: '' };
  private ownSlot = -1;
  private nameTimer: ReturnType<typeof setTimeout> | null = null;

  /** Called when the player changes something. Send it to the server. */
  onChange: (patch: { name?: string; color?: string }) => void = () => {};
  /** Called when the sheet opens or closes, so input can be neutralised. */
  onVisibility: (open: boolean) => void = () => {};

  constructor(private readonly el: SheetElements) {
    this.buildColors();

    el.open.addEventListener('click', () => this.setOpen(true));
    el.close.addEventListener('click', () => this.setOpen(false));

    // Tapping the dimmed backdrop closes; taps inside the panel must not.
    el.sheet.addEventListener('click', (event) => {
      if (event.target === el.sheet) this.setOpen(false);
    });

    el.nameInput.addEventListener('input', () => this.onNameInput());
    el.nameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        el.nameInput.blur();
        this.flushName();
      }
    });
    el.nameInput.addEventListener('blur', () => this.flushName());
  }

  get isOpen(): boolean {
    return !this.el.sheet.hidden;
  }

  setOpen(open: boolean): void {
    this.el.sheet.hidden = !open;
    if (!open) {
      this.flushName();
      this.el.nameInput.blur();
    }
    this.onVisibility(open);
  }

  /* ------------------------------ building ------------------------------ */

  private buildColors(): void {
    for (const color of PALETTE) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.style.setProperty('--swatch', color.hex);
      button.setAttribute('aria-label', color.name);
      button.setAttribute('aria-pressed', 'false');
      button.innerHTML = '<i></i>';
      button.addEventListener('click', () => {
        if (button.disabled || this.state.color === color.hex) return;
        this.onChange({ color: color.hex });
      });
      this.colorButtons.set(color.hex, button);
      this.el.colorGrid.append(button);
    }
  }

  /* -------------------------------- name -------------------------------- */

  private onNameInput(): void {
    const raw = this.el.nameInput.value;
    const clean = sanitizeName(raw);

    if (raw.trim() !== '' && clean === '') {
      this.el.nameHint.textContent = 'Pick a different name.';
      this.el.nameHint.dataset.bad = '1';
    } else {
      const left = NAME_MAX_LENGTH - clean.length;
      this.el.nameHint.textContent = left <= 4 ? `${left} characters left` : '';
      delete this.el.nameHint.dataset.bad;
    }

    // Debounced: typing "Priya" should not be five round trips, and the host
    // should not watch the name grow letter by letter.
    if (this.nameTimer !== null) clearTimeout(this.nameTimer);
    this.nameTimer = setTimeout(() => this.flushName(), 500);
  }

  private flushName(): void {
    if (this.nameTimer !== null) {
      clearTimeout(this.nameTimer);
      this.nameTimer = null;
    }
    const clean = sanitizeName(this.el.nameInput.value);
    if (clean === this.state.name) return;
    this.onChange({ name: clean });
  }

  /* ------------------------------- state -------------------------------- */

  /** Apply the profile the server says is in effect. */
  setProfile(profile: ProfileState): void {
    this.state = profile;

    if (document.activeElement !== this.el.nameInput) {
      this.el.nameInput.value = profile.name;
    }

    for (const [hex, button] of this.colorButtons) {
      button.setAttribute('aria-pressed', String(hex === profile.color));
    }
    this.refreshAvailability();
  }

  setOwnSlot(slot: number): void {
    this.ownSlot = slot;
  }

  /** Grey out colours other players hold. Updates live as the room changes. */
  setTaken(taken: ColorClaim[]): void {
    this.taken = taken;
    this.refreshAvailability();
  }

  private refreshAvailability(): void {
    const byOthers = new Set(
      this.taken.filter((c) => c.slot !== this.ownSlot).map((c) => c.color.toLowerCase()),
    );
    for (const [hex, button] of this.colorButtons) {
      button.disabled = byOthers.has(hex.toLowerCase());
    }
  }

  showError(error: string): void {
    const messages: Record<string, string> = {
      color_taken: 'Someone just took that colour.',
      bad_name: 'Pick a different name.',
      bad_color: 'That colour is not available.',
    };
    this.el.nameHint.textContent = messages[error] ?? 'That did not work.';
    this.el.nameHint.dataset.bad = '1';
  }
}
