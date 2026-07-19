import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dir = join(__dirname, '..', 'public', 'images', 'sponsors');

const mappings = [
  ['ansys.svg', 'ansys.png'],
  ['siemens.svg', 'siemens.png'],
  ['altium.svg', 'altium.png'],
  ['shell.svg', 'shell-eco-marathon.png'],
  ['shell-quaker-state.svg', 'shell-quaker-state.png'],
  ['solidworks.svg', 'solidworks.png'],
  ['tec-de-monterrey.svg', 'tec-de-monterrey.png'],
  ['cimb.svg', 'cimb.png'],
];

for (const [svgName, pngName] of mappings) {
  const svgPath = join(dir, svgName);
  const pngPath = join(dir, pngName);
  if (!existsSync(svgPath)) {
    console.log(`SKIP ${pngName} — missing ${svgName}`);
    continue;
  }
  const svg = readFileSync(svgPath, 'utf8');
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 512 },
    background: 'rgba(0,0,0,0)',
  });
  const png = resvg.render().asPng();
  writeFileSync(pngPath, png);
  console.log(`OK ${pngName} (${png.length} bytes)`);
}
