/** Native FaceID / TouchID Biometric Authentication using HTML5 WebAuthn API */

/**
 * Enroll FaceID / TouchID on this device.
 * Triggers the native iOS FaceID / TouchID system verification popup!
 */
export async function enrollBiometrics(): Promise<boolean> {
  try {
    if (!window.PublicKeyCredential) return false;

    const challenge = new Uint8Array(32);
    window.crypto.getRandomValues(challenge);

    const options: CredentialCreationOptions = {
      publicKey: {
        challenge,
        rp: { name: "Goon Drop" },
        user: {
          id: new Uint8Array([9, 4, 1, 3, 4, 1]), // Custom unique ID
          name: "user@goondrop",
          displayName: "Goon Drop User"
        },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 algorithm
        authenticatorSelection: {
          authenticatorAttachment: "platform", // Native biometrics (FaceID, TouchID, Windows Hello)
          userVerification: "required"
        },
        timeout: 60000
      }
    };

    const credential = await navigator.credentials.create(options) as PublicKeyCredential | null;
    if (!credential) return false;

    // A WebAuthn assertion needs the credential ID on subsequent unlocks.
    // Storing this identifier locally is safe: it is public, not a biometric secret.
    const credentialId = btoa(String.fromCharCode(...new Uint8Array(credential.rawId)));
    window.localStorage.setItem('goondrop_biometric_credential_id', credentialId);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Verify FaceID / TouchID biometrics on this device.
 * Triggers the native iOS FaceID / TouchID system biometric check!
 */
export async function verifyBiometrics(): Promise<boolean> {
  try {
    if (!window.PublicKeyCredential) {
      console.error('[GoonDrop] Biometrics error: PublicKeyCredential not supported in this browser.');
      return false;
    }

    const challenge = new Uint8Array(32);
    window.crypto.getRandomValues(challenge);

    const savedCredentialId = window.localStorage.getItem('goondrop_biometric_credential_id');
    if (!savedCredentialId) return false;
    const rawCredentialId = Uint8Array.from(atob(savedCredentialId), char => char.charCodeAt(0));

    const options: CredentialRequestOptions = {
      publicKey: {
        challenge,
        timeout: 60000,
        userVerification: "required",
        allowCredentials: [{ type: 'public-key', id: rawCredentialId }]
      }
    };

    const assertion = await navigator.credentials.get(options);
    console.log('[GoonDrop] Biometrics verification successful');
    return !!assertion;
  } catch (err: any) {
    console.error('[GoonDrop] Biometrics error:', err.name, err.message);
    return false;
  }
}
