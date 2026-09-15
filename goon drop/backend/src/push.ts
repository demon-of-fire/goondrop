const webpush = require('web-push');
import fs from 'fs';
import path from 'path';

/**
 * VAPID Key Management for Web Push Notifications
 */

const KEYS_PATH = path.join(__dirname, '..', '..', 'vapid-keys.json');

export function getVapidKeys() {
  if (fs.existsSync(KEYS_PATH)) {
    const data = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
    return {
      publicKey: data.publicKey,
      privateKey: data.privateKey
    };
  }

  console.log('[PUSH] Generating new VAPID keys...');
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
  return keys;
}

// Initialize web-push with the keys
const { publicKey, privateKey } = getVapidKeys();
webpush.setVapidDetails(
  'mailto:admin@goondrop.local',
  publicKey,
  privateKey
);

export { webpush, publicKey };
