import selfsigned from 'selfsigned';
import fs from 'fs';
import path from 'path';
import { X509Certificate } from 'crypto';

/**
 * Generates a self-signed certificate for local HTTPS development.
 * Saves them to the project root for persistence.
 */
export async function getOrCreateCertificates(localIp: string) {
  const certPath = path.join(__dirname, '..', '..', 'cert.pem');
  const keyPath = path.join(__dirname, '..', '..', 'key.pem');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const cert = fs.readFileSync(certPath);
    try {
      // Browsers validate the subject-alt-name, not only the common name. A
      // localhost-only certificate cannot be trusted for https://192.168.x.x
      // on iPhone, even after the user enables full certificate trust.
      const subjectAltName = new X509Certificate(cert).subjectAltName || '';
      if (subjectAltName.includes(`IP Address:${localIp}`)) {
        return { cert, key: fs.readFileSync(keyPath) };
      }
      console.log(`[CERT] Replacing certificate that does not cover LAN IP ${localIp}.`);
    } catch {
      console.log('[CERT] Existing certificate is unreadable; generating a replacement.');
    }
  }

  console.log(`[CERT] Generating self-signed certificate for localhost and ${localIp}...`);
  const attrs = [{ name: 'commonName', value: 'localhost' }];
  const pems = await selfsigned.generate(attrs, {
    days: 365 * 10,
    extensions: [{
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: localIp },
      ],
    }],
  } as any) as unknown as { cert: string; private: string };

  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath, pems.private);

  return {
    cert: pems.cert,
    key: pems.private
  };
}
