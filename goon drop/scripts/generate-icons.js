/**
 * Simple SVG icon generation for Goon Drop PWA.
 * SVG icons are already provided in frontend/public/icons/.
 * This script copies them for platforms that need explicit references.
 */
const fs = require('fs');
const path = require('path');

const iconDir = path.join(__dirname, '..', 'frontend', 'public', 'icons');

const icons = [
  { name: 'icon-192.svg', size: 192 },
  { name: 'icon-512.svg', size: 512 },
  { name: 'icon-192-maskable.svg', size: 192 },
  { name: 'icon-512-maskable.svg', size: 512 },
];

console.log('Goon Drop icon generator');
console.log('-----------------------');
console.log(`Icon directory: ${iconDir}`);
console.log();

// Ensure directory exists
if (!fs.existsSync(iconDir)) {
  fs.mkdirSync(iconDir, { recursive: true });
}

// Check all icons exist
let allExist = true;
for (const icon of icons) {
  const iconPath = path.join(iconDir, icon.name);
  if (fs.existsSync(iconPath)) {
    const stats = fs.statSync(iconPath);
    console.log(`✓ ${icon.name} (${(stats.size / 1024).toFixed(1)} KB)`);
  } else {
    console.log(`✗ ${icon.name} - MISSING`);
    allExist = false;
  }
}

if (allExist) {
  console.log();
  console.log('All PWA icons are ready. No generation needed - SVG icons work in modern browsers.');
  console.log('For maximum compatibility, you can convert SVGs to PNGs using a tool like');
  console.log('svgexport, sharp, or online converters.');
} else {
  console.log();
  console.log('Some icons are missing. SVG icons should be created manually.');
  process.exit(1);
}
