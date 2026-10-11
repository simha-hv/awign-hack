import { NAME_MAX_LENGTH, sanitizeName } from '@brawl/protocol';

/**
 * "What's your name?", straight after scanning.
 *
 * The player is already seated by the time this shows, so it never delays
 * getting in; it only holds the controls until they confirm. The name is what
 * the big screen prints on their seat and over their character, which is how
 * four people find themselves on a TV across the room. A returning player
 * finds last time's name filled in and is one tap away.
 *
 * Like the customise sheet, nothing is applied optimistically: the name goes
 * to the server, and the `profile` reply is what actually changes the pad.
 */
export interface NameGateElements {
  gate: HTMLElement;
  form: HTMLFormElement;
  input: HTMLInputElement;
  hint: HTMLElement;
  go: HTMLButtonElement;
}

export class NameGate {
  /** Called with a clean, non-empty name when the player confirms. */
  onSubmit: (name: string) => void = () => {};
  /** Called whenever the gate opens or closes. */
  onVisibility: (open: boolean) => void = () => {};

  constructor(private readonly el: NameGateElements) {
    el.input.maxLength = NAME_MAX_LENGTH;
    el.input.addEventListener('input', () => this.refresh());
    el.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const name = sanitizeName(el.input.value);
      if (!name) {
        this.hint(el.input.value.trim() ? 'Try another name' : 'Type a name first', true);
        return;
      }
      el.input.blur();
      this.close();
      this.onSubmit(name);
    });
  }

  get isOpen(): boolean {
    return !this.el.gate.hidden;
  }

  open(prefill: string): void {
    this.el.input.value = prefill;
    this.el.gate.hidden = false;
    this.refresh();
    this.onVisibility(true);
    // Phones only raise the keyboard from a tap, but desktops focus here.
    setTimeout(() => this.el.input.focus(), 50);
  }

  close(): void {
    if (this.el.gate.hidden) return;
    this.el.gate.hidden = true;
    this.onVisibility(false);
  }

  private refresh(): void {
    const raw = this.el.input.value.trim();
    const ok = sanitizeName(raw) !== '';
    this.el.go.disabled = !ok;
    if (raw && !ok) this.hint('Try another name', true);
    else this.hint(`Up to ${NAME_MAX_LENGTH} letters`, false);
  }

  private hint(text: string, bad: boolean): void {
    this.el.hint.textContent = text;
    this.el.hint.dataset.bad = bad ? '1' : '0';
  }
}
