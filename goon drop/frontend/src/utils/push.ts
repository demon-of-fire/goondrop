/**
 * Web Push Subscription Helper for iOS PWA
 */

export async function subscribeToPush(publicKey: string, deviceId: string) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Push notifications not supported in this browser.');
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    
    // Check if already subscribed
    const existingSubscription = await registration.pushManager.getSubscription();
    if (existingSubscription) {
      return existingSubscription;
    }

    // Subscribe to push notifications
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: publicKey
    });

    // Send subscription to backend
    const res = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        subscription
      })
    });

    if (!res.ok) {
      throw new Error('Failed to register subscription with server');
    }

    return subscription;
  } catch (err) {
    console.error('[GoonDrop Push] Subscription failed:', err);
    throw err;
  }
}
