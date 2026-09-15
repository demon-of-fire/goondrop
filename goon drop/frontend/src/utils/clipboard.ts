/** Clipboard utilities with iOS-aware fallbacks */

export interface ClipboardResult {
  text: string;
  success: boolean;
  error?: string;
}

/**
 * Read from clipboard with iOS PWA fallback.
 * On iOS, this requires user interaction and only works while app is focused.
 */
export async function readClipboard(): Promise<ClipboardResult> {
  try {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      return { text: '', success: false, error: 'Clipboard API not available' };
    }
    const text = await navigator.clipboard.readText();
    return { text, success: true };
  } catch (err: any) {
    // iOS PWA often throws on clipboard read
    return { text: '', success: false, error: err.message || 'Clipboard read failed' };
  }
}

/**
 * Write to clipboard with fallback.
 * Works on most modern browsers including iOS Safari.
 */
export async function writeClipboard(text: string): Promise<ClipboardResult> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return { text, success: true };
    }
  } catch (err) {
    // Fall back to text area technique
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.width = '2em';
    textarea.style.height = '2em';
    textarea.style.padding = '0';
    textarea.style.border = 'none';
    textarea.style.outline = 'none';
    textarea.style.boxShadow = 'none';
    textarea.style.background = 'transparent';
    document.body.appendChild(textarea);
    
    // Select and copy
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, 999999);
    
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    
    if (success) {
      return { text, success: true };
    }
    return { text, success: false, error: 'Clipboard fallback failed' };
  } catch (err: any) {
    return { text, success: false, error: err.message || 'Clipboard write failed' };
  }
}

/**
 * Purely synchronous clipboard copying.
 * ⚠️ CRITICAL FOR IOS: iOS Safari immediately blocks copying if there is any 
 * async/await or promise-hop (microtask) between the user's click and the copy operation.
 * Running this fully synchronously ensures iOS never loses the user gesture context!
 */
export function copyTextSync(text: string): boolean {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.width = '2em';
    textarea.style.height = '2em';
    textarea.style.padding = '0';
    textarea.style.border = 'none';
    textarea.style.outline = 'none';
    textarea.style.boxShadow = 'none';
    textarea.style.background = 'transparent';
    textarea.setAttribute('readonly', ''); // Crucial for iOS Safari focus
    document.body.appendChild(textarea);
    
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, 999999); // Crucial for iOS Safari selection
    
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    
    if (success) {
      return true;
    }
  } catch (err) {
    // Fallback failed, try Clipboard API synchronously (without awaiting)
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    // Ignore
  }

  return false;
}

/**
 * Simple hash for clipboard deduplication.
 * Uses DJB2 algorithm for speed.
 */
export function hashClipboard(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Detect if the current device is an iPhone/PWA.
 */
export function isIOSPwa(): boolean {
  const ua = navigator.userAgent;
  const isIOS = /iphone|ipad|ipod/i.test(ua);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches;
  return isIOS && isStandalone;
}

/**
 * Detect if running in standalone PWA mode (any platform).
 */
export function isPwaStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as any).standalone === true;
}
