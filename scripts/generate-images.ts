/**
 * Icon generation — renders art/icon-master.svg to every PNG the manifest
 * needs, plus a padded maskable variant and the apple-touch icon.
 *
 *   npm run img:generate
 */

import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const master = readFileSync(join(root, 'art', 'icon-master.svg'));
const outDir = join(root, 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const SIZES = [48, 128, 192, 512];

async function main(): Promise<void> {
  for (const size of SIZES) {
    await sharp(master).resize(size, size).png().toFile(join(outDir, `icon-${size}.png`));
    console.log(`icon-${size}.png`);
  }

  // Maskable: the safe zone is a centered circle at 80% — scale the glyph
  // down onto a full-bleed paper background so nothing clips.
  const inner = await sharp(master).resize(410, 410).png().toBuffer();
  await sharp({
    create: { width: 512, height: 512, channels: 4, background: '#fafbfd' },
  })
    .composite([{ input: inner, gravity: 'center' }])
    .png()
    .toFile(join(outDir, 'icon-maskable-512.png'));
  console.log('icon-maskable-512.png');

  // Apple touch icon: 180px, opaque background (iOS composites its own radius)
  const appleInner = await sharp(master).resize(180, 180).png().toBuffer();
  await sharp({
    create: { width: 180, height: 180, channels: 4, background: '#fafbfd' },
  })
    .composite([{ input: appleInner }])
    .flatten({ background: '#fafbfd' })
    .png()
    .toFile(join(outDir, 'apple-touch-icon.png'));
  console.log('apple-touch-icon.png');

  // 32px favicon PNG fallback
  await sharp(master).resize(32, 32).png().toFile(join(root, 'public', 'favicon-32.png'));
  console.log('favicon-32.png');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
