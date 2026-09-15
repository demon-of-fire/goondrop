/**
 * Native Windows/iOS Notification Helper
 * 
 * IMPORTANT: On iOS, notifications MUST be shown via the Service Worker 
 * (navigator.serviceWorker.ready.then(reg => reg.showNotification())) 
 * because 'new Notification()' is not supported in the main thread.
 */

export async function showNativeNotification(title: string, options: NotificationOptions = {}) {
  if (!('Notification' in window)) {
    return;
  }

  if (Notification.permission !== 'granted') {
    return;
  }

  // On iOS and most modern browsers, using the Service Worker is the most reliable way 
  // to show notifications, especially when the app is in the background.
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(title, options);
      return; // Success!
    } catch (err) {
      console.warn('[GoonDrop] Service Worker notification failed, falling back to main thread', err);
    }
  }

  // Fallback for desktop browsers or environments where Service Worker is not available
  try {
    new Notification(title, options);
  } catch (err) {
    console.error('[GoonDrop] Native notification failed completely', err);
  }
}
