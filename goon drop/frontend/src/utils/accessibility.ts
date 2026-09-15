/** Accessibility utilities for screen reader announcements */

let announcementCounter = 0;

/**
 * Announce a message to screen readers using a live region.
 * Call this whenever important state changes occur.
 */
export function announce(message: string, priority: 'polite' | 'assertive' = 'polite'): void {
  const id = `announce-${++announcementCounter}`;
  let region = document.getElementById('announcements');

  if (!region) {
    region = document.createElement('div');
    region.id = 'announcements';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', priority);
    region.setAttribute('aria-atomic', 'true');
    document.body.appendChild(region);
  }

  // Update aria-live based on priority
  region.setAttribute('aria-live', priority);

  // Create a new element each time to ensure announcement fires
  const el = document.createElement('div');
  el.id = id;
  el.textContent = message;
  region.appendChild(el);

  // Clean up after announcement
  setTimeout(() => {
    const prev = document.getElementById(id);
    if (prev) prev.remove();
  }, 3000);
}

/** Announce clipboard sync event */
export function announceClipboardSync(deviceName: string): void {
  announce(`Clipboard synced from ${deviceName}`, 'polite');
}

/** Announce file transfer completion */
export function announceFileComplete(fileName: string): void {
  announce(`File received: ${fileName}`, 'polite');
}

/** Announce pairing state change */
export function announceDeviceConnected(deviceName: string): void {
  announce(`${deviceName} connected`, 'polite');
}

/** Announce device disconnected */
export function announceDeviceDisconnected(deviceName: string): void {
  announce(`${deviceName} disconnected`, 'polite');
}

/** Announce error */
export function announceError(message: string): void {
  announce(`Error: ${message}`, 'assertive');
}

/** Announce successful action */
export function announceSuccess(message: string): void {
  announce(message, 'polite');
}

/**
 * Trap focus within a modal element.
 * Returns a cleanup function.
 */
export function trapFocus(element: HTMLElement): () => void {
  const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const previouslyFocused = document.activeElement as HTMLElement;

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;

    const focusable = element.querySelectorAll<HTMLElement>(focusableSelector);
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // Focus first focusable element
  setTimeout(() => {
    const first = element.querySelector<HTMLElement>(focusableSelector);
    if (first) first.focus();
  }, 50);

  document.addEventListener('keydown', handleKeyDown);

  return () => {
    document.removeEventListener('keydown', handleKeyDown);
    if (previouslyFocused && previouslyFocused.focus) {
      previouslyFocused.focus();
    }
  };
}
