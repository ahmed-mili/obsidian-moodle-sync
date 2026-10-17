'use strict';
// Mode lié à Neo Quiz : node --test src/test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const E = require('../engine.js');

const vault = () => fs.mkdtempSync(path.join(os.tmpdir(), 'moodle-sync-lie-'));

test('un vault sans .neo-quiz reste autonome, avec il est lié', () => {
	const v = vault();
	assert.equal(E.estLie(v), false);
	fs.mkdirSync(path.join(v, '.neo-quiz'));
	assert.equal(E.estLie(v), true);
});

test('les listes partagées : le geste le plus récent gagne, un retrait gagne une égalité, les fichiers de Neo Quiz sont lus', () => {
	const v = vault();
	const dir = path.join(v, '.neo-quiz', 'moodle');
	fs.mkdirSync(dir, { recursive: true });
	const tard = Date.now() + 60_000;
	// le fichier de Neo Quiz (un autre appareil), une copie de conflit ignorée, un fichier abîmé
	fs.writeFileSync(path.join(dir, 'e45a22d9-fd2f-4226-802e-3208a698464d.json'), JSON.stringify({ v: 1, lists: { favoris: { 23108: { on: true, at: 5 }, 23088: { on: false, at: tard } } } }));
	fs.writeFileSync(path.join(dir, 'x.sync-conflict-20261017-1.json'), JSON.stringify({ v: 1, lists: { favoris: { 66: { on: true, at: 5 } } } }));
	fs.writeFileSync(path.join(dir, 'broken.json'), '{');
	const moi = 'obsidian-00000000-0000-4000-8000-000000000000';
	let { own, autres } = E.lireListesPartagees(v, moi);
	assert.equal(own, null);
	assert.deepEqual(E.fusionner([own || {}, ...autres], 'favoris'), [23108]);
	// poser une étoile sur 23088 : daté après le retrait de Neo Quiz, même avec son horloge en avance
	E.ecrireListesPartagees(v, moi, E.poser(own || {}, autres, 'favoris', 23088, true, Date.now()));
	({ own, autres } = E.lireListesPartagees(v, moi));
	assert.deepEqual(E.fusionner([own, ...autres], 'favoris'), [23108, 23088]);
	assert.equal(fs.readdirSync(dir).some((n) => n.endsWith('.tmp')), false, 'aucun fichier temporaire laissé');
	// le fichier écrit a le format que Neo Quiz relit
	const ecrit = JSON.parse(fs.readFileSync(path.join(dir, `${moi}.json`), 'utf8'));
	assert.equal(ecrit.v, 1);
	assert.equal(typeof ecrit.lists.favoris['23088'].at, 'number');
});

test('une date forgée dans le futur, un id hostile ou une liste inconnue sont écartés à la lecture', () => {
	const t = E.lireTable({ v: 1, lists: { favoris: { 7: { on: false, at: 1e308 }, 0: { on: true, at: 1 }, __proto__: { on: true, at: 1 }, 8: { on: true, at: 2 } }, autre: { 1: { on: true, at: 1 } } } }, 1000);
	assert.deepEqual(t, { favoris: { 8: { on: true, at: 2 } } });
	for (const bad of [null, [], 'x', { lists: [] }]) assert.deepEqual(E.lireTable(bad), {});
});
