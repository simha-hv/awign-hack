/**
 * Screen wake lock.
 *
 * Two things make this fiddly:
 *  1. The lock is released automatically whenever the page is backgrounded,
 *     so it MUST be re-acquired on `visibilitychange` — acquiring once at
 *     startup means the screen dims the first time someone reads a text.
 *  2. It requires a secure context. Over plain http on a LAN IP the API is
 *     simply absent, so every call is guarded and failure is non-fatal.
 */

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', cb: () => void): void;
}

type WakeLockNavigator = Navigator & {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
};

export class WakeLock {
  private sentinel: WakeLockSentinelLike | null = null;
  private wanted = false;

  get supported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  }

  /** True once a lock is actually held. */
  get held(): boolean {
    return this.sentinel !== null && !this.sentinel.released;
  }

  async acquire(): Promise<void> {
    this.wanted = true;
    await this.request();
  }

  private async request(): Promise<void> {
    if (!this.wanted || this.held) return;
    const nav = navigator as WakeLockNavigator;
    if (!nav.wakeLock) return;
    if (document.visibilityState !== 'visible') return;

    try {
      const sentinel = await nav.wakeLock.request('screen');
      this.sentinel = sentinel;
      sentinel.addEventListener('release', () => {
        this.sentinel = null;
      });
    } catch {
      // NotAllowedError on insecure origins, or the OS refused. Not fatal —
      // the controller still works, the screen just sleeps on its own timer.
      this.sentinel = null;
    }
  }

  /** Wire up the re-acquire. Returns a teardown function. */
  attach(): () => void {
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void this.request();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // Safari fires pageshow on bfcache restore without a visibilitychange.
    window.addEventListener('pageshow', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onVisibility);
    };
  }

  async release(): Promise<void> {
    this.wanted = false;
    try {
      await this.sentinel?.release();
    } catch {
      /* ignore */
    }
    this.sentinel = null;
  }
}
