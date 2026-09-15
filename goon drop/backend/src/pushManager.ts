import { webpush } from './push';
import type { Client } from './websocket';

export class PushManager {
  // Map of deviceId -> PushSubscription object
  private subscriptions = new Map<string, any>();

  /** Register a device's push subscription */
  registerSubscription(deviceId: string, subscription: any) {
    this.subscriptions.set(deviceId, subscription);
  }

  /** Unregister a device's push subscription */
  unregisterSubscription(deviceId: string) {
    this.subscriptions.delete(deviceId);
  }

  /** Send a push notification with interactive actions */
  async sendNotification(deviceId: string, title: string, body: string, actions: { label: string; value: string }[] = [], icon = '/icons/icon-192.svg') {
    const subscription = this.subscriptions.get(deviceId);
    
    // If it's a Windows PC, also trigger the native Windows prompt
    try {
      // The launcher uses a dedicated loopback port, separate from HTTPS (3942).
      const response = await fetch('http://127.0.0.1:3945/control/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          message: body,
          actionType: actions[0]?.label || 'Accept',
          payloadId: deviceId
        })
      });
    } catch { /* Launcher might not be running */ }

    if (!subscription) return;

    try {
      await webpush.sendNotification(subscription, JSON.stringify({
        title,
        body,
        icon,
        actions,
        timestamp: Date.now()
      }));
    } catch (err) {
      console.error(`[PUSH] Failed to send notification to ${deviceId}:`, err);
      if ((err as any).statusCode === 410 || (err as any).statusCode === 404) {
        this.unregisterSubscription(deviceId);
      }
    }
  }

  /** Broadcast a push notification with interactive actions */
  async broadcastNotification(title: string, body: string, actions: { label: string; value: string }[] = [], excludeId?: string, icon = '/icons/icon-192.svg') {
    const promises = [];
    for (const [deviceId, subscription] of this.subscriptions) {
      if (deviceId !== excludeId) {
        promises.push(this.sendNotification(deviceId, title, body, actions, icon));
      }
    }
    await Promise.all(promises);
  }
}
