// Construit le main.js distribuable en inlinant engine.js.
// BRAT ne récupère que main.js / manifest.json / styles.css depuis une release ; le plugin
// charge sinon engine.js comme fichier voisin, absent d'une install BRAT. On l'inline donc ici.
// Le vault de dev garde les deux fichiers séparés (src/) ; seule la distribution est fusionnée.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const engine = readFileSync(join(root, 'src', 'engine.js'), 'utf8');
let main = readFileSync(join(root, 'src', 'main.js'), 'utf8');

// Remplace le chargement runtime d'engine.js par le module inliné.
const marker = 'this.engine = window.require(enginePath);';
const start = main.indexOf('const dir = this.manifest.dir');
const end = main.indexOf(marker);
if (start === -1 || end === -1) throw new Error('Bloc de chargement engine introuvable dans src/main.js');
main = main.slice(0, start) + 'this.engine = __MOODLE_ENGINE__;' + main.slice(end + marker.length);

// Inline engine.js comme fabrique, juste après le premier 'use strict';.
const wrapper = `
// --- engine.js inliné pour la distribution (voir src/build.mjs) ---
const __MOODLE_ENGINE__ = (() => {
\tconst module = { exports: {} };
\tconst exports = module.exports;
${engine}
\treturn module.exports;
})();
`;
main = main.replace("'use strict';\n", "'use strict';\n" + wrapper);

writeFileSync(join(root, 'main.js'), main);
console.log(`main.js construit : ${main.length} octets`);
