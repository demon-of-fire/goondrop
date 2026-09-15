const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const iconDir = path.join(__dirname, '..', 'frontend', 'public', 'icons');

const icons = [
  { name: 'icon-192.svg', outName: 'icon-192.png', size: 192 },
  { name: 'icon-512.svg', outName: 'icon-512.png', size: 512 },
  { name: 'icon-192-maskable.svg', outName: 'icon-192-maskable.png', size: 192 },
  { name: 'icon-512-maskable.svg', outName: 'icon-512-maskable.png', size: 512 },
];

console.log('Converting SVG icons to PNG for iOS compatibility...');

async function run() {
  for (const icon of icons) {
    const inPath = path.join(iconDir, icon.name);
    const outPath = path.join(iconDir, icon.outName);
    
    if (fs.existsSync(inPath)) {
      try {
        await sharp(inPath)
          .resize(icon.size, icon.size)
          .png()
          .toFile(outPath);
        console.log(`✓ Converted ${icon.name} -> ${icon.outName}`);
      } catch (err) {
        console.error(`✗ Failed converting ${icon.name}:`, err);
      }
    } else {
      console.log(`✗ Source missing: ${icon.name}`);
    }
  }
}

run();
