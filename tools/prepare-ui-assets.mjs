import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const sharp = require(process.argv[3] || 'sharp');
fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
await sharp(process.argv[2]).resize({ width: 320 }).webp({ quality: 85 }).toFile(path.join(root, 'assets/guide.webp'));
const names = ['house', 'headphones', 'message-circle', 'sparkles', 'star', 'rocket', 'users', 'settings', 'user-round', 'volume-2', 'square', 'captions', 'arrow-right', 'arrow-left', 'rotate-ccw', 'check', 'x', 'chevron-right', 'book-open', 'download', 'printer', 'send', 'refresh-cw'];
const icons = {};
for (const name of names) {
  const response = await fetch(`https://raw.githubusercontent.com/lucide-icons/lucide/0.468.0/icons/${name}.svg`);
  if (!response.ok) throw new Error(`Lucide ${name}: ${response.status}`);
  icons[name] = (await response.text()).replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>[\s\S]*$/, '').trim();
}
const license = await fetch('https://raw.githubusercontent.com/lucide-icons/lucide/0.468.0/LICENSE');
if (!license.ok) throw new Error('Lucide license could not be loaded');
fs.writeFileSync(path.join(root, 'assets/lucide-LICENSE'), await license.text());
const htmlPath = path.join(root, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
html = html.replace(/  <style>[\s\S]*?<\/style>/, '  <link rel="stylesheet" href="station.css">');
html = html.replace('/* ICON_PATHS */ {}', JSON.stringify(icons));
fs.writeFileSync(htmlPath, html);
console.log(JSON.stringify({ icons: names.length, guide: fs.statSync(path.join(root, 'assets/guide.webp')).size }));
