/**
 * Apple Shortcuts Catalog + File Generator
 *
 * Single source of truth for the downloadable .shortcut files served by the
 * backend. Shortcuts hit Goon Drop HTTP endpoints directly, which means iPhone
 * → PC actions (AirDrop, clipboard, handoff, power control, typing, location,
 * battery...) run 100% in the background with NO PWA open and NO pairing.
 */
import fs from 'fs';
import path from 'path';
import type { AppConfig } from './config';

export interface ShortcutAction {
  identifier: string;
  parameters: Record<string, any>;
  inputTypes?: string[];
}

export interface ShortcutDefinition {
  id: string;
  name: string;
  bundleIdentifier: string;
  description: string;
  category: string;
  input?: string;
  needsCode: boolean;
  method: 'GET' | 'POST';
  url: string;
  displayUrl: string;
  actions: ShortcutAction[];
}

function escapeXml(str: string): string {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build an Apple Shortcut plist. The key names mirror what Apple exports from
 * the Shortcuts app so iOS imports the file without complaints.
 */
export function buildShortcutPlist(def: ShortcutDefinition): string {
  const actionsXml = def.actions.map(action => {
    const paramsXml = Object.entries(action.parameters).map(([key, value]) => {
      const val = typeof value === 'string' ? escapeXml(value) : String(value);
      return `        <dict>
          <key>WFParameterKey</key>
          <string>${escapeXml(key)}</string>
          <key>WFParameterValue</key>
          <string>${val}</string>
        </dict>`;
    }).join('\n');

    return `      <dict>
        <key>WFWorkflowActionIdentifier</key>
        <string>${escapeXml(action.identifier)}</string>
        <key>WFWorkflowActionParameters</key>
        <dict>
${paramsXml}
        </dict>
      </dict>`;
  }).join('\n');

  const inputClasses = (def.actions[0]?.inputTypes || ['WFStringContentItem'])
    .map((t: string) => `    <string>${escapeXml(t)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>WFWorkflowClientVersion</key>
  <string>1320.8.12</string>
  <key>WFWorkflowClientRelease</key>
  <string>3.2.1</string>
  <key>WFWorkflowMinimumClientVersion</key>
  <integer>900</integer>
  <key>WFWorkflowMinimumClientVersionString</key>
  <string>900</string>
  <key>WFWorkflowIcon</key>
  <dict>
    <key>WFWorkflowIconStartColor</key>
    <integer>4282601983</integer>
    <key>WFWorkflowIconGlyphNumber</key>
    <integer>59510</integer>
  </dict>
  <key>WFWorkflowImportQuestionsDisable</key>
  <true/>
  <key>WFWorkflowHasShortcutInputVariables</key>
  <false/>
  <key>WFWorkflowHasOutputFallback</key>
  <false/>
  <key>WFWorkflowInputContentItemClasses</key>
  <array>
${inputClasses}
  </array>
  <key>WFWorkflowInputContentCardinality</key>
  <integer>1</integer>
  <key>WFWorkflowNoInputParameters</key>
  <true/>
  <key>WFWorkflowActions</key>
  <array>
${actionsXml}
  </array>
  <key>WFWorkflowTypes</key>
  <array>
    <string>NCWidget</string>
    <string>WatchKit</string>
    <string>ActionExtension</string>
  </array>
</dict>
</plist>`;
}

// ─── Action chain builders (mirror the shapes Apple's Shortcuts app uses) ──

const notify = (title: string, body: string): ShortcutAction => ({
  identifier: 'is.workflow.actions.notification',
  parameters: { WFNotificationActionTitle: title, WFNotificationActionBody: body },
});

/** Share-sheet photos/media/files → POST to endpoint as the request body. */
const uploadChain = (targetUrl: string, title: string, body: string, inputTypes: string[]): ShortcutAction[] => [
  {
    identifier: 'is.workflow.actions.getinput',
    parameters: { WFInputType: 'WFContentItemInputType' },
    inputTypes,
  },
  { identifier: 'is.workflow.actions.getcontentsurl', parameters: {}, inputTypes },
  { identifier: 'is.workflow.actions.url', parameters: { WFURLActionURL: targetUrl }, inputTypes: ['WFURLContentItem'] },
  { identifier: 'is.workflow.actions.contentsurl', parameters: {}, inputTypes: ['WFURLContentItem'] },
  { identifier: 'is.workflow.actions.downloadurl', parameters: {}, inputTypes: ['WFURLContentItem'] },
  notify(title, body),
];

/** Text coming out of a capture action (photo, scan, recording, clipboard...). */
const textBodyChain = (sourceAction: ShortcutAction, targetUrl: string, title: string, body: string): ShortcutAction[] => [
  sourceAction,
  { identifier: 'is.workflow.actions.url', parameters: { WFURLActionURL: targetUrl }, inputTypes: ['WFURLContentItem'] },
  { identifier: 'is.workflow.actions.contentsurl', parameters: {}, inputTypes: ['WFURLContentItem'] },
  { identifier: 'is.workflow.actions.downloadurl', parameters: {}, inputTypes: ['WFURLContentItem'] },
  notify(title, body),
];

/** Free text from the share sheet / Siri → POST as the request body. */
const textPostChain = (targetUrl: string, title: string, body: string): ShortcutAction[] => [
  {
    identifier: 'is.workflow.actions.getinput',
    parameters: { WFInputType: 'WFContentItemInputType' },
    inputTypes: ['WFStringContentItem', 'WFURLContentItem'],
  },
  { identifier: 'is.workflow.actions.url', parameters: { WFURLActionURL: targetUrl }, inputTypes: ['WFURLContentItem'] },
  { identifier: 'is.workflow.actions.contentsurl', parameters: {}, inputTypes: ['WFURLContentItem'] },
  { identifier: 'is.workflow.actions.downloadurl', parameters: {}, inputTypes: ['WFURLContentItem'] },
  notify(title, body),
];

const clipboardPostChain = (targetUrl: string, title: string, body: string): ShortcutAction[] => [
  { identifier: 'is.workflow.actions.getclipboard', parameters: {}, inputTypes: ['WFStringContentItem'] },
  { identifier: 'is.workflow.actions.url', parameters: { WFURLActionURL: targetUrl }, inputTypes: ['WFURLContentItem'] },
  { identifier: 'is.workflow.actions.contentsurl', parameters: {}, inputTypes: ['WFURLContentItem'] },
  { identifier: 'is.workflow.actions.downloadurl', parameters: {}, inputTypes: ['WFURLContentItem'] },
  notify(title, body),
];

/** One-tap action with no input → plain GET. */
const simpleGetChain = (href: string, title: string, body: string): ShortcutAction[] => [
  { identifier: 'is.workflow.actions.url', parameters: { WFURLActionURL: href }, inputTypes: ['WFURLContentItem'] },
  { identifier: 'is.workflow.actions.downloadurl', parameters: {}, inputTypes: ['WFURLContentItem'] },
  notify(title, body),
];

/** Fetch text → place into iPhone clipboard. */
const getThenSetClipboard = (href: string, title: string, body: string): ShortcutAction[] => [
  { identifier: 'is.workflow.actions.url', parameters: { WFURLActionURL: href }, inputTypes: ['WFURLContentItem'] },
  { identifier: 'is.workflow.actions.downloadurl', parameters: {}, inputTypes: ['WFURLContentItem'] },
  { identifier: 'is.workflow.actions.setclipboard', parameters: {}, inputTypes: ['WFStringContentItem'] },
  notify(title, body),
];

/**
 * Universal Clipboard sync — composite that stitches together the two proven
 * simple chains (push + pull). No conditional plist tricks, so the file imports
 * reliably. Runs great from a repeating Personal Automation:
 *
 *   1. Push the iPhone clipboard → PC (stores the text if it's newer).
 *   2. Run the "Paste from PC" shortcut → pulls whatever the PC now has.
 *      If nothing new, the PC echoes back the same text (harmless no-op).
 *
 * Requires the "Paste from PC" shortcut to also be installed (part of the suite).
 */
/**
 * Universal Clipboard sync — SELF-CONTAINED one-request design. No conditional
 * logic, no dependence on other shortcuts, so the plist imports reliably.
 *
 *   Get Clipboard → POST to /api/clipboard/sync → the plain-text response is
 *   ALREADY the text the iPhone should end up with → Set Clipboard → Notify.
 *
 * The server decides "newest wins": if the PC clipboard changed after the phone's
 * last sync it is returned (the iPhone adopts it); otherwise the iPhone text is
 * stored on the PC (real Windows clipboard) and echoed back (harmless no-op).
 */
const clipboardSyncChain = (syncHref: string, successTitle: string): ShortcutAction[] => [
  { identifier: 'is.workflow.actions.getclipboard', parameters: {}, inputTypes: ['WFStringContentItem'] },
  { identifier: 'is.workflow.actions.url', parameters: { WFURLActionURL: syncHref }, inputTypes: ['WFURLContentItem'] },
  { identifier: 'is.workflow.actions.contentsurl', parameters: {}, inputTypes: ['WFStringContentItem'] },
  { identifier: 'is.workflow.actions.downloadurl', parameters: {}, inputTypes: ['WFURLContentItem'] },
  { identifier: 'is.workflow.actions.setclipboard', parameters: {}, inputTypes: ['WFStringContentItem'] },
  notify(successTitle, 'Now matching the latest clipboard on both sides.'),
];

// ─── Catalog ────────────────────────────────────────────────────────────────

const CATEGORIES: Record<string, string> = {
  share: '✈️ Share & Files',
  clipboard: '📋 Clipboard & Notes',
  handoff: '🌐 Handoff & Search',
  control: '🎛️ Control Your PC',
  sensors: '📡 Location & Finding',
};

export function getShortcutDefinitions(config: AppConfig): ShortcutDefinition[] {
  const base = `http://${config.localIp}:${config.port}`;
  const code = config.pairingCode;
  const codeStr = `?code=${encodeURIComponent(code)}`;
  const drop = `${base}/api/drop`;

  // Helper to assemble a definition with a safe filename id.
  const make = (
    id: string,
    name: string,
    category: string,
    description: string,
    method: 'GET' | 'POST',
    url: string,
    actions: ShortcutAction[],
    opts: { input?: string; needsCode?: boolean } = {},
  ): ShortcutDefinition => ({
    id,
    name,
    bundleIdentifier: `com.goondrop.${id.replace(/[^a-zA-Z0-9-]/g, '')}`,
    description,
    category,
    method,
    url,
    displayUrl: url.replace(codeStr, '?code=••••••'),
    actions,
    input: opts.input,
    needsCode: opts.needsCode || false,
  });

  const defs: ShortcutDefinition[] = [
    // ── Share & Files ──────────────────────────────────────────────────────
    make(
      'airdrop-to-pc', 'AirDrop to PC', 'share',
      'Share any photo, video, PDF, or file from the native iOS Share Sheet straight into Downloads\\GoonDrop on Windows.',
      'POST', drop,
      uploadChain(drop, 'AirDrop to PC', 'File beamed to your Windows PC! 🚀', ['WFImageContentItem', 'WFVideoContentItem', 'WFURLContentItem']),
      { input: 'Share Sheet: Images, Media, Files' },
    ),
    make(
      'scan-document-to-pc', 'Scan Document to PC', 'share',
      'Scan a document with your iPhone camera and the pages land on your PC as images instantly.',
      'POST', drop,
      textBodyChain(
        { identifier: 'is.workflow.actions.scanDocument', parameters: {}, inputTypes: ['WFImageContentItem'] },
        drop, 'Scan Document to PC', 'Scanned pages beamed to your PC! 📄',
      ),
      { input: 'None (One-Tap Camera)' },
    ),
    make(
      'photo-to-pc', 'Photo to PC', 'share',
      'Take a photo and beam it straight to your Windows PC. Great for handing homework, receipts, or whiteboards.',
      'POST', drop,
      textBodyChain(
        { identifier: 'is.workflow.actions.takephoto', parameters: {}, inputTypes: ['WFImageContentItem'] },
        drop, 'Photo to PC', 'Photo beamed to your PC! 📸',
      ),
      { input: 'None (One-Tap Camera)' },
    ),
    make(
      'voice-memo-to-pc', 'Voice Memo to PC', 'share',
      'Record a voice memo from Siri or a shortcut button and it saves straight onto your PC as audio.',
      'POST', drop,
      textBodyChain(
        { identifier: 'is.workflow.actions.recordaudio', parameters: {}, inputTypes: ['WFAudioContentItem'] },
        drop, 'Voice Memo to PC', 'Voice memo beamed to your PC! 🎙️',
      ),
      { input: 'None (One-Tap Record)' },
    ),

    // ── Clipboard & Notes ──────────────────────────────────────────────────
    make(
      'copy-to-pc', 'Send Clipboard to PC', 'clipboard',
      'Instantly push your iPhone clipboard to the real Windows clipboard. Pair with Back Tap for a 0-second sync.',
      'POST', `${base}/api/clipboard`,
      clipboardPostChain(`${base}/api/clipboard`, 'Clipboard sent to Windows! 📋', ''),
      { input: 'None (One-Tap)' },
    ),
    make(
      'paste-from-pc', 'Paste from PC', 'clipboard',
      'Grab whatever is currently on the Windows clipboard and copy it into your iPhone clipboard.',
      'GET', `${base}/api/clipboard/latest?format=text`,
      getThenSetClipboard(`${base}/api/clipboard/latest?format=text`, 'Paste from PC', 'Windows clipboard copied to iPhone! 📥'),
      { input: 'None (One-Tap)' },
    ),
    make(
      'clipboard-sync', 'Universal Clipboard', 'clipboard',
      'FULLY AUTOMATIC two-way clipboard sync in ONE shortcut. It pushes your iPhone clipboard to the PC, and if the PC has something newer it pulls that back instead. Wire this to a repeating Personal Automation and your clipboard converges forever — with or without the app open.',
      'POST', `${base}/api/clipboard/sync?code=${encodeURIComponent(code)}`,
      clipboardSyncChain(
        `${base}/api/clipboard/sync?code=${encodeURIComponent(code)}`,
        'Universal Clipboard synced! 🔁',
      ),
      { input: 'None (Background Timer)' },
    ),
    make(
      'quick-note-to-pc', 'Quick Note to PC', 'clipboard',
      'Send a quick text note, to-do, or idea to your PC. Saved to Desktop\\GoonDrop_Backup and shown in the app.',
      'POST', `${base}/api/note`,
      textPostChain(`${base}/api/note`, 'Quick Note to PC', 'Note saved to your PC! 🗒️'),
      { input: 'Text / Share Sheet' },
    ),
    make(
      'pull-note-from-pc', 'Pull Latest Note', 'clipboard',
      'Fetch your most recent PC note and copy it into your iPhone clipboard.',
      'GET', `${base}/api/notes/latest?format=text`,
      getThenSetClipboard(`${base}/api/notes/latest?format=text`, 'Pull Latest Note', 'Latest note copied to iPhone!'),
      { input: 'None (One-Tap)' },
    ),

    // ── Handoff & Search ───────────────────────────────────────────────────
    make(
      'handoff-to-pc', 'Handoff to PC', 'handoff',
      'Instantly open the current Safari page (or any URL) in your Windows default browser.',
      'POST', `${base}/api/handoff`,
      textPostChain(`${base}/api/handoff`, 'Handoff to PC', 'Page opened on your PC! 🌐'),
      { input: 'Share Sheet: URLs' },
    ),
    make(
      'search-on-pc', 'Search the Web on PC', 'handoff',
      'Ask Siri or type a query and it opens the search results in your Windows browser.',
      'POST', `${base}/api/search`,
      textPostChain(`${base}/api/search`, 'Search on PC', 'Searching on your PC! 🔍'),
      { input: 'Text / Siri' },
    ),

    // ── Control Your PC ────────────────────────────────────────────────────
    make(
      'lock-pc', 'Lock PC', 'control',
      'One tap locks your Windows PC from anywhere in the house.',
      'GET', `${base}/api/system/lock${codeStr}`,
      simpleGetChain(`${base}/api/system/lock${codeStr}`, 'Lock PC', 'PC locked! 🔒'),
      { needsCode: true },
    ),
    make(
      'sleep-pc', 'Sleep PC', 'control',
      'Put your Windows machine to sleep instantly.',
      'GET', `${base}/api/system/sleep${codeStr}`,
      simpleGetChain(`${base}/api/system/sleep${codeStr}`, 'Sleep PC', 'PC going to sleep! 💤'),
      { needsCode: true },
    ),
    make(
      'restart-pc', 'Restart PC', 'control',
      'Restart your Windows PC. Great for after Windows updates or a frozen GPU.',
      'GET', `${base}/api/system/restart${codeStr}`,
      simpleGetChain(`${base}/api/system/restart${codeStr}`, 'Restart PC', 'PC restarting! 🔄'),
      { needsCode: true },
    ),
    make(
      'shutdown-pc', 'Shutdown PC', 'control',
      'Full shutdown of your Windows PC.',
      'GET', `${base}/api/system/shutdown${codeStr}`,
      simpleGetChain(`${base}/api/system/shutdown${codeStr}`, 'Shutdown PC', 'PC shutting down! ⏻'),
      { needsCode: true },
    ),
    make(
      'type-on-pc', 'Type on PC', 'control',
      'Send text and it gets TYPED on your Windows PC as if you were at the keyboard. Dictate, then send!',
      'POST', `${base}/api/type${codeStr}`,
      textPostChain(`${base}/api/type${codeStr}`, 'Type on PC', 'Typed on your PC! ⌨️'),
      { input: 'Text / Siri Dictation', needsCode: true },
    ),
    make(
      'pc-says', 'PC Says It (Text-to-Speech)', 'control',
      'Your PC speaks whatever text you send, out loud, through its speakers.',
      'POST', `${base}/api/speak${codeStr}`,
      textPostChain(`${base}/api/speak${codeStr}`, 'PC Says It', 'Your PC is speaking! 🗣️'),
      { input: 'Text / Siri Dictation', needsCode: true },
    ),
    make(
      'open-app-on-pc', 'Open App on PC', 'control',
      'Launch an app on Windows by name: spotify, notepad, calculator, chrome, youtube, netflix, cmd, explorer…',
      'POST', `${base}/api/open-app${codeStr}`,
      textPostChain(`${base}/api/open-app${codeStr}`, 'Open App on PC', 'Opening on your PC! 🚀'),
      { input: 'Text (app name)', needsCode: true },
    ),
    make(
      'find-my-pc', 'Find My PC', 'control',
      'Lost your laptop in the house? Your Windows PC beeps loudly and shouts "I\'m right here!" through its speakers.',
      'GET', `${base}/api/ping-pc${codeStr}`,
      simpleGetChain(`${base}/api/ping-pc${codeStr}`, 'Find My PC', 'Your PC is making noise right now! 🔊'),
      { needsCode: true },
    ),

    // ── Location & Finding ─────────────────────────────────────────────────
    make(
      'send-battery-to-pc', 'Send Battery to PC', 'sensors',
      'Send your iPhone battery %. Perfect for an Automation: "When Battery Level drops below 20%, run this".',
      'POST', `${base}/api/battery`,
      [
        { identifier: 'is.workflow.actions.getbatterylevel', parameters: {}, inputTypes: ['WFNumberContentItem'] },
        { identifier: 'is.workflow.actions.url', parameters: { WFURLActionURL: `${base}/api/battery?level=` }, inputTypes: ['WFURLContentItem'] },
        { identifier: 'is.workflow.actions.contentsurl', parameters: {}, inputTypes: ['WFURLContentItem'] },
        { identifier: 'is.workflow.actions.downloadurl', parameters: {}, inputTypes: ['WFURLContentItem'] },
        notify('Send Battery to PC', 'Battery % sent to your PC! 🔋'),
      ],
      { input: 'None (One-Tap)' },
    ),
    make(
      'send-location-to-pc', 'Send Location to PC', 'sensors',
      'Send your GPS location to your PC. Open it in Maps with one tap, or check where you dropped your phone.',
      'POST', `${base}/api/location`,
      [
        { identifier: 'is.workflow.actions.getcurrentlocation', parameters: {}, inputTypes: ['WFLocationContentItem'] },
        { identifier: 'is.workflow.actions.url', parameters: { WFURLActionURL: `${base}/api/location` }, inputTypes: ['WFURLContentItem'] },
        { identifier: 'is.workflow.actions.contentsurl', parameters: {}, inputTypes: ['WFURLContentItem'] },
        { identifier: 'is.workflow.actions.downloadurl', parameters: {}, inputTypes: ['WFURLContentItem'] },
        notify('Send Location to PC', 'Location sent to your PC! 📍'),
      ],
      { input: 'None (One-Tap)' },
    ),
    make(
      'find-my-phone', 'Find My Phone', 'sensors',
      'Push an alert to the Goon Drop app on your phone so it rings/vibrates even if you lost it in the couch.',
      'GET', `${base}/api/ping-phone${codeStr}`,
      simpleGetChain(`${base}/api/ping-phone${codeStr}`, 'Find My Phone', 'Your phone is ringing! 📱'),
      { needsCode: true },
    ),
  ];

  return defs;
}

/** Write all shortcut files (+ a machine-readable index) to shortcuts/. */
export function createShortcutFiles(config: AppConfig): void {
  const shortcutsDir = path.join(__dirname, '..', '..', 'shortcuts');
  if (!fs.existsSync(shortcutsDir)) {
    fs.mkdirSync(shortcutsDir, { recursive: true });
  }

  const defs = getShortcutDefinitions(config);
  for (const def of defs) {
    const safeName = def.name.replace(/\s+/g, '-');
    fs.writeFileSync(path.join(shortcutsDir, `${def.id}.shortcut`), buildShortcutPlist(def), 'utf8');
    fs.writeFileSync(path.join(shortcutsDir, `${safeName}.shortcut`), buildShortcutPlist(def), 'utf8');
  }

  fs.writeFileSync(
    path.join(shortcutsDir, 'index.json'),
    JSON.stringify({
      generatedAt: Date.now(),
      baseUrl: `http://${config.localIp}:${config.port}`,
      shortcuts: defs.map(d => ({ id: d.id, name: d.name, category: d.category, method: d.method, url: d.url, description: d.description })),
    }, null, 2),
    'utf8',
  );
}

export const SHORTCUT_CATEGORIES = CATEGORIES;