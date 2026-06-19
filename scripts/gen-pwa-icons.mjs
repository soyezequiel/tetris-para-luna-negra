import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

mkdirSync('public/icons', { recursive: true });

const iconSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a0f1a"/>
      <stop offset="1" stop-color="#04070c"/>
    </linearGradient>
    <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="10" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="512" height="512" rx="96" fill="url(#bg)"/>
  <g filter="url(#glow)">
    <g fill="#d94ae8">
      <rect x="120" y="120" width="120" height="120" rx="14"/>
      <rect x="272" y="120" width="120" height="120" rx="14"/>
      <rect x="120" y="272" width="120" height="120" rx="14"/>
    </g>
    <rect x="272" y="272" width="120" height="120" rx="14" fill="#00f5ff"/>
  </g>
</svg>`;

const maskableSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0a0f1a"/>
      <stop offset="1" stop-color="#04070c"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <g transform="translate(256,256) scale(0.62) translate(-256,-256)">
    <rect x="120" y="120" width="120" height="120" rx="14" fill="#d94ae8"/>
    <rect x="272" y="120" width="120" height="120" rx="14" fill="#d94ae8"/>
    <rect x="120" y="272" width="120" height="120" rx="14" fill="#d94ae8"/>
    <rect x="272" y="272" width="120" height="120" rx="14" fill="#00f5ff"/>
  </g>
</svg>`;

const render = (svg, size, out) =>
  sharp(Buffer.from(svg)).resize(size, size).png().toFile(out);

await render(iconSvg, 192, 'public/icons/icon-192.png');
await render(iconSvg, 512, 'public/icons/icon-512.png');
await render(iconSvg, 180, 'public/icons/apple-touch-icon.png');
await render(maskableSvg, 512, 'public/icons/icon-maskable-512.png');
console.log('icons generated');
