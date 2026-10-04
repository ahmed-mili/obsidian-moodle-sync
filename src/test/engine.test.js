'use strict';
// Tests du moteur : node --test .obsidian/plugins/moodle-sync/test/engine.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const E = require('../engine.js');

function tmpdir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'moodle-sync-'));
}

// Réponse get_contents de synthèse : un exemplaire de chaque cas rencontré sur Moodle Efrei.
const SECTIONS = [
	{ name: 'Généralités', modules: [
		{ id: 10, name: 'Présentation', modname: 'resource', uservisible: true, contents: [
			{ type: 'file', filename: 'Intro.pdf', filesize: 5, fileurl: 'https://m/webservice/pluginfile.php/1/mod_resource/content/1/Intro.pdf?forcedownload=1', timemodified: 100 },
		] },
		{ id: 11, name: 'Annonces', modname: 'forum', uservisible: true },
		{ id: 12, name: 'Consigne', modname: 'label', uservisible: true },
	] },
	{ name: 'Séance 1', modules: [
		{ id: 20, name: 'Supports', modname: 'folder', uservisible: true, contents: [
			{ type: 'file', filename: 'TP1.pdf', filepath: '/', filesize: 7, fileurl: 'https://m/f/TP1.pdf', timemodified: 200 },
			{ type: 'file', filename: 'Intro.pdf', filepath: '/old/', filesize: 4, fileurl: 'https://m/f/old/Intro.pdf', timemodified: 50 },
		] },
		{ id: 21, name: 'Cours', modname: 'page', uservisible: true, contents: [
			{ type: 'file', filename: 'index.html', fileurl: 'https://m/p/index.html', timemodified: 1 },
			{ type: 'file', filename: 'schema.png', filesize: 3, fileurl: 'https://m/p/schema.png', timemodified: 1 },
		] },
		{ id: 22, name: 'Doc officielle', modname: 'url', uservisible: true, contents: [{ type: 'url', fileurl: 'https://docs.python.org/' }] },
		{ id: 23, name: 'Rendu TP1', modname: 'assign', uservisible: true },
		{ id: 24, name: 'Caché', modname: 'resource', uservisible: false, contents: [{ type: 'file', filename: 'x.pdf', fileurl: 'https://m/x.pdf' }] },
	] },
];
const ASSIGNS = [{
	id: 900, cmid: 23, duedate: 5000, cutoffdate: 9000,
	introattachments: [{ filename: 'Sujet TP1.pdf', filesize: 9, fileurl: 'https://m/a/Sujet.pdf', timemodified: 300 }],
}];
// Réponse mod_assign_get_submission_status d'un devoir rendu.
const SUBMITTED = { lastattempt: { submission: { status: 'submitted', timemodified: 400, plugins: [
	{ type: 'file', fileareas: [{ area: 'submission_files', files: [
		{ filename: 'Compte-rendu TP1.pdf', filesize: 11, fileurl: 'https://m/s/cr.pdf', timemodified: 400 },
	] }] },
] } } };
const DEPOSITS = new Map([[23, E.parseSubmission(SUBMITTED)]]);

test('sanitize : NFC, caractères interdits, espaces compactés', () => {
	assert.equal(E.sanitize('Révision.pdf'), 'Révision.pdf');
	assert.equal(E.sanitize('a:b/c?.pdf'), 'a-b-c-.pdf');
	assert.equal(E.sanitize('Admin  avancée   Scripting.pdf'), 'Admin avancée Scripting.pdf');
});

test('decodeEntities : &amp; décodé en dernier', () => {
	assert.equal(E.decodeEntities('A &amp; B &quot;c&quot; &#039;d&#39; &lt;e&gt; &amp;lt;'), 'A & B "c" \'d\' <e> &lt;');
});

test('parseCourse : code, année, cohorte, nom nettoyé', () => {
	const c = E.parseCourse({
		id: '23101',
		shortname: 'XTI302-CYB-2627PSA01',
		fullname: '* XTI302-CYB-2627PSA01 - Administration système avancées &amp; Scripting (X-BAC-CS-2, X-BAC-ICS-2)',
	});
	assert.deepEqual(c, {
		id: 23101,
		name: 'XTI302-CYB-2627PSA01 - Administration système avancées & Scripting',
		code: 'XTI302',
		yearKey: '2026-2027',
		cohort: 'PSA01',
	});
	assert.equal(E.parseCourse({ id: 1, shortname: 'XCS-413-2627PSA01', fullname: 'x' }).code, 'XCS413');
	assert.equal(E.parseCourse({ id: 2, shortname: 'XMUT301-2627PSA01', fullname: 'x' }).code, 'XMUT301');
	assert.equal(E.parseCourse({ id: 3, shortname: 'LXP-4GOOD-2627PSA01', fullname: 'x' }).code, null);
	assert.equal(E.parseCourse({ id: 4, shortname: 'XTI305-CYB-2627BSA01', fullname: 'x' }).cohort, 'BSA01');
});

test('locate : dossier trouvé par le code, libellé d\'année harmonisé, tri par code', () => {
	const vault = tmpdir();
	const b2 = path.join(vault, 'Bachelor Cybersécurité & Ethical Hacking', 'B2 (2026-2027)');
	fs.mkdirSync(path.join(b2, 'XTI302 - Admin'), { recursive: true });
	fs.mkdirSync(path.join(b2, 'XCS413 - Fondamentaux'), { recursive: true });
	const list = E.locate([
		{ id: 1, name: 'a', code: 'XTI302', yearKey: '2026-2027', cohort: 'PSA01' },
		{ id: 2, name: 'b', code: 'XCS413', yearKey: '2026-2027', cohort: 'PSA01' },
		{ id: 3, name: 'c', code: 'XTI999', yearKey: '2026-2027', cohort: 'PSA01' },
		{ id: 4, name: 'd', code: null, yearKey: '2025-2026', cohort: null },
	], vault);
	assert.deepEqual(list.map((c) => c.code), ['XCS413', 'XTI302', 'XTI999', null]);
	assert.equal(list[1].dest, path.join(b2, 'XTI302 - Admin'));
	assert.equal(list[2].dest, null);
	assert.equal(list[2].yearLabel, 'B2 (2026-2027)');
	assert.equal(list[3].yearLabel, '2025-2026');
	assert.deepEqual(E.locate([{ id: 5, name: 'e', code: 'XTI302', yearKey: null, cohort: null }], tmpdir())[0].dest, null);
});

test('flattenContents : fichiers, dossiers, pages, liens, devoirs et état du dépôt', () => {
	const tree = E.flattenContents(SECTIONS, ASSIGNS, DEPOSITS);
	assert.deepEqual(tree.map((s) => s.name), ['Généralités', 'Séance 1']);
	assert.deepEqual(tree[0].activities.map((a) => a.type), ['resource', 'forum']);
	const s1 = Object.fromEntries(tree[1].activities.map((a) => [a.id, a]));
	assert.deepEqual(s1[20].files.map((f) => f.name), ['Intro.pdf', 'TP1.pdf']);
	assert.deepEqual(s1[21].files.map((f) => f.name), ['schema.png']);
	assert.deepEqual(s1[22].external, ['https://docs.python.org/']);
	// Le rendu de l'utilisateur n'est jamais un fichier à télécharger : seul le sujet l'est.
	assert.deepEqual(s1[23].files.map((f) => f.name), ['Sujet TP1.pdf']);
	assert.deepEqual(s1[23].deposit, {
		due: 5000, cutoff: 9000, status: 'submitted', submittedAt: 400,
		files: [{ name: 'Compte-rendu TP1.pdf', size: 11 }],
	});
	assert.equal(s1[20].deposit, undefined);
	assert.equal(s1[24], undefined);
	assert.deepEqual(tree[0].activities[0].files[0], {
		url: 'https://m/webservice/pluginfile.php/1/mod_resource/content/1/Intro.pdf?forcedownload=1',
		name: 'Intro.pdf', size: 5, timemodified: 100, status: 'missing',
	});
});

test('dedupe : un seul fichier par nom (casse ignorée), le plus récent gagne', () => {
	const tree = E.dedupe(E.flattenContents(SECTIONS, ASSIGNS, DEPOSITS));
	const intro = E.allFiles({ sections: tree }).filter((f) => f.name.toLowerCase() === 'intro.pdf');
	assert.equal(intro.length, 1);
	assert.equal(intro[0].timemodified, 100);
	assert.deepEqual(tree[1].activities.find((a) => a.id === 20).files.map((f) => f.name), ['TP1.pdf']);
	const cased = E.dedupe([{ name: 's', activities: [{ files: [
		{ name: 'Cours.pdf', timemodified: 1 }, { name: 'cours.pdf', timemodified: 2 },
	] }] }]);
	assert.deepEqual(cased[0].activities[0].files.map((f) => f.name), ['cours.pdf']);
});

test('localStatus : absent, présent, remplacé sur Moodle, copie locale plus récente', () => {
	const dir = tmpdir();
	const f = (name, tm) => ({ name, timemodified: tm });
	assert.equal(E.localStatus(f('a.pdf', 1000), dir), 'missing');
	assert.equal(E.localStatus(f('a.pdf', 1000), null), 'missing');
	fs.writeFileSync(path.join(dir, 'a.pdf'), 'x');
	fs.utimesSync(path.join(dir, 'a.pdf'), 1000, 1000);
	assert.equal(E.localStatus(f('a.pdf', 1000), dir), 'present');
	assert.equal(E.localStatus(f('a.pdf', 1001), dir), 'present');
	assert.equal(E.localStatus(f('a.pdf', 1010), dir), 'outdated');
	assert.equal(E.localStatus(f('a.pdf', 500), dir), 'present');
});

test('applyStatus : une copie renommée (même taille, même extension) compte comme présente', () => {
	const dir = tmpdir();
	fs.mkdirSync(path.join(dir, 'Ignite'));
	fs.writeFileSync(path.join(dir, 'Ignite', 'Solution du challenge.pdf'), Buffer.alloc(4096));
	fs.writeFileSync(path.join(dir, 'petit.txt'), 'abc');
	fs.mkdirSync(path.join(dir, '.venv'));
	fs.writeFileSync(path.join(dir, '.venv', 'x.pdf'), Buffer.alloc(5000));
	const file = (name, size) => ({ name, size, timemodified: 1, status: 'missing' });
	const scan = { sections: [{ activities: [{ files: [
		file('Challenge Ignite-solution.pdf', 4096),   // renommée dans un sous-dossier
		file('Autre.docx', 4096),                      // même taille, autre extension : absente
		file('mini.txt', 3),                           // trop petite pour conclure : absente
		file('cache.pdf', 5000),                       // seule copie dans .venv : ignorée
	] }] }] };
	E.applyStatus(scan, dir);
	const st = E.allFiles(scan).map((x) => [x.name, x.status, x.localName || null]);
	assert.deepEqual(st, [
		['Challenge Ignite-solution.pdf', 'present', path.join('Ignite', 'Solution du challenge.pdf')],
		['Autre.docx', 'missing', null],
		['mini.txt', 'missing', null],
		['cache.pdf', 'missing', null],
	]);
});

test('pendingDeposits : à rendre, urgents, retards, nouveaux, ignorés', () => {
	const H = 3600;
	const now = 100 * H * 1000;
	const act = (id, o) => ({ id, name: `D${id}`, type: 'assign', files: [], external: [],
		deposit: { due: 0, cutoff: 0, status: 'new', submittedAt: 0, files: [], ...o } });
	const scan = { sections: [{ activities: [
		act(1, { due: 105 * H }),                      // urgent
		act(2, { due: 200 * H }),                      // à faire
		act(3, { due: 90 * H }),                       // en retard, dépôt possible
		act(8, { due: 80 * H }),                       // plus en retard encore : tout en haut
		act(4, { due: 90 * H, cutoff: 95 * H }),       // fermé : plus rien à faire
		act(5, { due: 150 * H, status: 'submitted' }), // déjà rendu
		act(6, { due: 300 * H }),                      // ignoré par l'utilisateur
		{ id: 7, name: 'Cours', type: 'resource', files: [], external: [] },
	] }] };
	const list = E.pendingDeposits(scan, { now, seen: new Set([2, 3]), ignored: new Set([6]) });
	assert.deepEqual(list.map((d) => [d.id, d.state, d.fresh]), [[8, 'late', true], [3, 'late', false], [1, 'urgent', true], [2, 'todo', false]]);
});

test('parseSubmission : statut, date, fichiers rendus, prolongation, devoir de groupe', () => {
	assert.deepEqual(E.parseSubmission(SUBMITTED), {
		status: 'submitted', submittedAt: 400, extension: 0, files: [{ name: 'Compte-rendu TP1.pdf', size: 11 }],
	});
	assert.deepEqual(E.parseSubmission({ lastattempt: { submission: { status: 'new', timemodified: 0 }, extensionduedate: 7000 } }), {
		status: 'new', submittedAt: 0, extension: 7000, files: [],
	});
	assert.equal(E.parseSubmission({ lastattempt: { teamsubmission: { status: 'submitted', timemodified: 5 } } }).status, 'submitted');
	assert.equal(E.parseSubmission({}).status, 'new');
});

test('depositState : déposé, à faire, urgent sous 8 h, en retard, fermé, sans date', () => {
	const H = 3600;
	const dep = (o) => ({ due: 100 * H, cutoff: 0, status: 'new', submittedAt: 0, files: [], ...o });
	const at = (sec) => sec * 1000;
	assert.equal(E.depositState(dep({ status: 'submitted', submittedAt: 50 * H }), at(200 * H)).state, 'submitted');
	assert.equal(E.depositState(dep({}), at(91 * H)).state, 'todo');
	const urgent = E.depositState(dep({}), at(92 * H));
	assert.equal(urgent.state, 'urgent');
	assert.equal(urgent.remaining, 8 * H * 1000);
	assert.equal(E.depositState(dep({}), at(101 * H)).state, 'late');
	assert.equal(E.depositState(dep({ cutoff: 110 * H }), at(105 * H)).state, 'late');
	assert.equal(E.depositState(dep({ cutoff: 110 * H }), at(111 * H)).state, 'closed');
	assert.equal(E.depositState(dep({ due: 0 }), at(1)).state, 'open');
	// Brouillon non envoyé : pas déposé pour le prof.
	assert.equal(E.depositState(dep({ status: 'draft' }), at(95 * H)).state, 'urgent');
	// Une prolongation remplace la date limite.
	const ext = E.depositState(dep({ extension: 200 * H }), at(150 * H));
	assert.equal(ext.state, 'todo');
	assert.equal(ext.due, 200 * H);
});

test('formatRemaining : minutes, heures, jours', () => {
	const M = 60 * 1000;
	assert.equal(E.formatRemaining(42 * M), '42 min');
	assert.equal(E.formatRemaining(5 * 60 * M + 7 * M), '5 h 07');
	assert.equal(E.formatRemaining(3 * 24 * 60 * M + 4 * 60 * M), '3 j 4 h');
	assert.equal(E.formatRemaining(30 * 1000), 'moins d\'une minute');
});

test('applyStatus, pending, summarize : les échecs comptent comme manquants', () => {
	const dir = tmpdir();
	fs.writeFileSync(path.join(dir, 'ici.pdf'), 'x');
	const scan = { sections: [{ name: 's', activities: [{ files: [
		{ name: 'ici.pdf', timemodified: 1, status: 'missing' },
		{ name: 'absent.pdf', timemodified: 1, status: 'present' },
		{ name: 'raté.pdf', timemodified: 1, status: 'failed' },
		{ name: 'encours.pdf', timemodified: 1, status: 'busy' },
	] }] }] };
	E.applyStatus(scan, dir);
	assert.deepEqual(E.allFiles(scan).map((x) => x.status), ['present', 'missing', 'failed', 'busy']);
	assert.deepEqual(E.pending(scan).map((x) => x.name), ['absent.pdf', 'raté.pdf']);
	assert.deepEqual(E.summarize(scan), { missing: 2, outdated: 0 });
});

test('uniqueJobs : un téléchargement par chemin (casse ignorée), le plus récent', () => {
	const jobs = [
		{ dir: 'D', file: { name: 'Plan.pdf', timemodified: 1 }, tag: 'PSA' },
		{ dir: 'D', file: { name: 'plan.pdf', timemodified: 5 }, tag: 'BSA' },
		{ dir: 'E', file: { name: 'Plan.pdf', timemodified: 1 }, tag: 'autre' },
	];
	assert.deepEqual(E.uniqueJobs(jobs).map((j) => j.tag), ['BSA', 'autre']);
});

test('launchUrl et verifyLaunchToken : seule la réponse à notre passport est acceptée', () => {
	assert.equal(E.launchUrl('p1', 'obsidian'),
		'https://moodle.myefrei.fr/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=p1&urlscheme=obsidian');
	assert.ok(E.launchUrl('p1', 'moodlesync', true).endsWith('&urlscheme=moodlesync&confirmed=1'));
	const token = 'a'.repeat(32);
	const sig = crypto.createHash('md5').update(E.ROOT + 'p123').digest('hex');
	assert.equal(E.verifyLaunchToken(Buffer.from(`${sig}:::${token}`).toString('base64'), 'p123'), token);
	assert.equal(E.verifyLaunchToken(Buffer.from(`${sig}:::${token}:::prive`).toString('base64'), 'p123'), token);
	assert.throws(() => E.verifyLaunchToken(Buffer.from(`${sig}:::${token}`).toString('base64'), 'autre'), { code: 'badlaunch' });
	assert.throws(() => E.verifyLaunchToken('bm9uc2Vucw==', 'p123'), { code: 'badlaunch' });
	assert.throws(() => E.verifyLaunchToken(Buffer.from(`${sig}:::pas-un-jeton`).toString('base64'), 'p123'), { code: 'badlaunch' });
});

test('limiter : jamais plus de N tâches en même temps', async () => {
	const limit = E.limiter(3);
	let active = 0;
	let peak = 0;
	const task = () => limit(async () => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((r) => setTimeout(r, 5));
		active--;
		return 1;
	});
	const r = await Promise.all(Array.from({ length: 10 }, task));
	assert.equal(r.length, 10);
	assert.equal(peak, 3);
});

// ------------------------------------------------------------------ réseau
// Serveur http local : le client choisit http ou https d'après l'URL, ce qui permet de
// tester sans toucher à Moodle.
const http = require('http');

function server(handler) {
	return new Promise((resolve) => {
		const s = http.createServer(handler);
		s.listen(0, '127.0.0.1', () => resolve({ s, root: `http://127.0.0.1:${s.address().port}` }));
	});
}

function stop(s) {
	s.closeAllConnections();
	s.close();
}

function readBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		req.on('data', (d) => chunks.push(d));
		req.on('end', () => resolve(Buffer.concat(chunks).toString()));
	});
}

test('call et siteInfo : POST du jeton et de la fonction, JSON renvoyé', async () => {
	const { s, root } = await server(async (req, res) => {
		const p = new URLSearchParams(await readBody(req));
		const out = p.get('wsfunction') === 'core_webservice_get_site_info'
			? { userid: 42, fullname: 'Ahmed', sitename: 'x' }
			: { path: req.url, token: p.get('wstoken'), fn: p.get('wsfunction'), fmt: p.get('moodlewsrestformat'), x: p.get('courseids[0]') };
		res.end(JSON.stringify(out));
	});
	const c = E.createClient('tok', { root });
	try {
		assert.deepEqual(await c.call('mod_x', { 'courseids[0]': 7 }),
			{ path: '/webservice/rest/server.php', token: 'tok', fn: 'mod_x', fmt: 'json', x: '7' });
		assert.deepEqual(await E.siteInfo(c), { userid: 42, fullname: 'Ahmed' });
	} finally {
		c.close();
		stop(s);
	}
});

test('call : jeton invalide ou expiré -> TokenError, autre erreur -> MoodleError', async () => {
	const replies = [
		{ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Invalid token' },
		{ exception: 'webservice_access_exception', errorcode: 'accessexception', message: 'Invalid token - token expired' },
		{ exception: 'require_login_exception', errorcode: 'requireloginerror', message: 'Course hidden' },
	];
	const { s, root } = await server((req, res) => res.end(JSON.stringify(replies.shift())));
	const c = E.createClient('tok', { root });
	try {
		await assert.rejects(c.call('f'), (e) => e instanceof E.TokenError && e.code === 'invalidtoken');
		await assert.rejects(c.call('f'), (e) => e instanceof E.TokenError && e.code === 'accessexception');
		await assert.rejects(c.call('f'), (e) => !(e instanceof E.TokenError) && e instanceof E.MoodleError && e.code === 'requireloginerror');
	} finally {
		c.close();
		stop(s);
	}
});

test('listCourses, searchCourses, courseById : cours localisés dans le vault', async () => {
	const vault = tmpdir();
	const b2 = path.join(vault, 'Bachelor Cybersécurité & Ethical Hacking', 'B2 (2026-2027)');
	fs.mkdirSync(path.join(b2, 'XTI302 - Admin'), { recursive: true });
	const raw = [
		{ id: 1, shortname: 'XTI302-CYB-2627PSA01', fullname: '* XTI302-CYB-2627PSA01 - Admin (X-BAC-CS-2)' },
		{ id: 2, shortname: 'LXP-4GOOD-2627PSA01', fullname: 'LXP' },
	];
	const seen = [];
	const { s, root } = await server(async (req, res) => {
		const p = new URLSearchParams(await readBody(req));
		const fn = p.get('wsfunction');
		seen.push([fn, p.get('userid') || p.get('criteriavalue') || p.get('value')]);
		const out = fn === 'core_enrol_get_users_courses' ? raw
			: fn === 'core_course_search_courses' ? { total: 2, courses: raw }
			: fn === 'core_course_get_courses_by_field' ? { courses: p.get('value') === '1' ? [raw[0]] : [] }
			: null;
		res.end(JSON.stringify(out));
	});
	const c = E.createClient('tok', { root });
	try {
		const list = await E.listCourses(c, 42, vault);
		// LXP-4GOOD (« Efrei For Good Xperience ») n'a pas de code module : listCourses l'exclut.
		assert.deepEqual(list.map((co) => [co.id, co.code, co.dest !== null]), [[1, 'XTI302', true]]);
		assert.deepEqual((await E.searchCourses(c, 'XTI', vault)).map((co) => co.id), [1]);
		assert.equal((await E.courseById(c, 1, vault)).dest, path.join(b2, 'XTI302 - Admin'));
		await assert.rejects(E.courseById(c, 9, vault), { code: 'nocourse' });
		assert.deepEqual(seen.slice(0, 2), [['core_enrol_get_users_courses', '42'], ['core_course_search_courses', 'XTI']]);
	} finally {
		c.close();
		stop(s);
	}
});

test('scanCourse : contenu + devoirs + état des dépôts, statuts calculés', async () => {
	const dir = tmpdir();
	fs.writeFileSync(path.join(dir, 'TP1.pdf'), 'x');
	fs.utimesSync(path.join(dir, 'TP1.pdf'), 1000, 1000);
	fs.writeFileSync(path.join(dir, 'Compte-rendu TP1.pdf'), 'x');
	fs.utimesSync(path.join(dir, 'Compte-rendu TP1.pdf'), 10, 10);
	const { s, root } = await server(async (req, res) => {
		const p = new URLSearchParams(await readBody(req));
		const fn = p.get('wsfunction');
		const out = fn === 'core_course_get_contents' ? SECTIONS
			: fn === 'mod_assign_get_assignments' ? { courses: [{ id: 5, assignments: ASSIGNS }] }
			: fn === 'mod_assign_get_submission_status'
				? SUBMITTED
				: { exception: 'x', errorcode: 'unexpected', message: fn };
		res.end(JSON.stringify(out));
	});
	const c = E.createClient('tok', { root });
	try {
		const scan = await E.scanCourse(c, 5, dir);
		const byName = Object.fromEntries(E.allFiles(scan).map((f) => [f.name, f.status]));
		assert.equal(byName['TP1.pdf'], 'present');
		assert.equal(byName['Sujet TP1.pdf'], 'missing');
		assert.equal(byName['Compte-rendu TP1.pdf'], undefined);
		const assign = scan.sections[1].activities.find((a) => a.id === 23);
		assert.equal(assign.deposit.status, 'submitted');
		assert.equal(byName['Intro.pdf'], 'missing');
		assert.deepEqual(scan.external, ['https://docs.python.org/']);
	} finally {
		c.close();
		stop(s);
	}
});

test('downloadFiles : écrit, suit une redirection, vérifie la taille, date Moodle, existant intact en cas d\'échec', async () => {
	const dir = tmpdir();
	fs.writeFileSync(path.join(dir, 'garde.pdf'), 'ancien');
	const { s, root } = await server((req, res) => {
		const u = new URL(req.url, 'http://x');
		if (u.searchParams.get('token') !== 'tok') { res.statusCode = 403; res.end(); return; }
		if (u.pathname === '/ok.pdf') { res.setHeader('Content-Type', 'application/pdf'); res.end('12345'); return; }
		if (u.pathname === '/redir.pdf') { res.statusCode = 302; res.setHeader('Location', '/ok.pdf?token=tok'); res.end(); return; }
		if (u.pathname === '/court.pdf') { res.setHeader('Content-Type', 'application/pdf'); res.end('12'); return; }
		res.setHeader('Content-Type', 'application/json');
		res.end('{"error":"x","errorcode":"invalidtoken"}');
	});
	const c = E.createClient('tok', { root });
	const f = (name, p, size) => ({ name, url: `${root}${p}?forcedownload=1`, size, timemodified: 1700000000 });
	const done = [];
	try {
		const r = await E.downloadFiles(c, [
			{ file: f('ok.pdf', '/ok.pdf', 5), dir },
			{ file: f('redir.pdf', '/redir.pdf', 5), dir },
			{ file: f('garde.pdf', '/court.pdf', 5), dir },
			{ file: f('refus.pdf', '/json', null), dir },
		], (job, err) => done.push([job.file.name, err ? err.code : 'ok']));
		assert.deepEqual(r.map((x) => x.ok), [true, true, false, false]);
		assert.equal(fs.readFileSync(path.join(dir, 'ok.pdf'), 'utf8'), '12345');
		assert.equal(Math.round(fs.statSync(path.join(dir, 'ok.pdf')).mtimeMs / 1000), 1700000000);
		assert.equal(fs.readFileSync(path.join(dir, 'redir.pdf'), 'utf8'), '12345');
		assert.equal(fs.readFileSync(path.join(dir, 'garde.pdf'), 'utf8'), 'ancien');
		assert.equal(fs.existsSync(path.join(dir, 'refus.pdf')), false);
		assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
		assert.equal(done.length, 4);
		assert.deepEqual(done.find((d) => d[0] === 'garde.pdf'), ['garde.pdf', 'incomplete']);
		assert.deepEqual(done.find((d) => d[0] === 'refus.pdf'), ['refus.pdf', 'refused']);
	} finally {
		c.close();
		stop(s);
	}
});

test('friendly : fichier verrouillé -> message explicite, erreurs Moodle inchangées', () => {
	for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
		const e = E.friendly(Object.assign(new Error('x'), { code }));
		assert.equal(e.code, 'locked');
		assert.match(e.message, /ouvert dans une autre application/);
	}
	assert.equal(E.friendly(new E.MoodleError('timeout', 't')).code, 'timeout');
});

test('call : Moodle muet -> MoodleError timeout', async () => {
	const { s, root } = await server(() => { /* ne répond jamais */ });
	const c = E.createClient('tok', { root, apiTimeout: 100 });
	try {
		await assert.rejects(c.call('f'), (e) => e instanceof E.MoodleError && e.code === 'timeout');
	} finally {
		c.close();
		stop(s);
	}
});

test('downloadFiles : flux interrompu -> timeout, temporaire supprimé, existant intact', async () => {
	const dir = tmpdir();
	fs.writeFileSync(path.join(dir, 'lent.pdf'), 'ancien');
	const { s, root } = await server((req, res) => {
		res.setHeader('Content-Type', 'application/pdf');
		res.write('12');   // puis plus rien
	});
	const c = E.createClient('tok', { root, idleTimeout: 100 });
	try {
		const [r] = await E.downloadFiles(c, [{ file: { name: 'lent.pdf', url: `${root}/lent.pdf`, size: 5, timemodified: 1 }, dir }]);
		assert.equal(r.ok, false);
		assert.match(r.error, /aucune donnée depuis 60 s/);
		assert.equal(fs.readFileSync(path.join(dir, 'lent.pdf'), 'utf8'), 'ancien');
		assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
	} finally {
		c.close();
		stop(s);
	}
});

test('prettyName : code de module, « Etudiant », « _ » et séance nettoyés', () => {
	const cases = {
		'XTI302-CYB-Seance2_TP_Socle_Etudiant.pdf': 'Séance 2 - TP Socle.pdf',
		'XTI302-CYB-CM2.pdf': 'CM2.pdf',
		'XTI302-CYB-Presentation_du_cours.pdf': 'Presentation du cours.pdf',
		'Projet_Fil_Rouge_ColisRelais_Document_3_Classes_Seance_3_VERSION_ETUDIANTE.pdf':
			'Séance 3 - Projet Fil Rouge ColisRelais Document 3 Classes.pdf',
		'TD1 _ Etudiants.pdf': 'TD1.pdf',
		'TD_3_Etudiants_V3.pdf': 'TD 3.pdf',
		'TP1.PDF': 'TP1.pdf',
	};
	for (const [from, to] of Object.entries(cases)) assert.equal(E.prettyName(from), to, from);
	assert.equal(E.prettyName('XTI302-CYB-Seance2_TP_Socle_Etudiant.pdf', 'TP Socle - Écrire ses premiers scripts shell'),
		'Séance 2 - TP Socle - Écrire ses premiers scripts shell.pdf');
	assert.equal(E.prettyName('a.pdf', 'Cours : partie 1/2'), 'Cours - partie 1-2.pdf');
	assert.equal(E.prettyName('TP1.pdf', 'Mise en place - Prise en main'), 'TP1 - Mise en place - Prise en main.pdf');
	assert.equal(E.prettyName('TD_3_Etudiants.pdf', 'TD 3 Classes'), 'TD 3 Classes.pdf');
});

test('pickTitle : garde un vrai titre, écarte nom du module, police cassée et fragments', () => {
	const co = { name: 'XTI302-CYB-2627PSA01 - Administration Systèmes avancées et Scripting' };
	assert.equal(E.pickTitle(['TP Socle', 'Écrire ses premiers scripts shell'], co), 'TP Socle - Écrire ses premiers scripts shell');
	assert.equal(E.pickTitle(['Atelier Bonus - Enregistrement', 'de session'], co), 'Atelier Bonus - Enregistrement de session');
	assert.equal(E.pickTitle(['TD2 — Diagrammes de cas', 'Usage'], co), 'TD2 — Diagrammes de cas - Usage');
	assert.equal(E.pickTitle(['Ethical Hacking 1 — Initiation'], { name: 'XTI305 - Ethical Hacking 1 - Initiation' }), null);
	assert.equal(E.pickTitle(['Projet fil rouge —', 'ColisRelais+'], co), 'Projet fil rouge — ColisRelais+');
	assert.equal(E.pickTitle(['Administration Systèmes avancées et Scripting (XTI302-CYB)'], co), null);
	assert.equal(E.pickTitle(['Administration Systèmes avancées et Scripting'], co), null);
	assert.equal(E.pickTitle(['CM 1 :'], co), null);
	assert.equal(E.pickTitle(['TP1 — Analyse progressive de schémas informa9ques'], co), null);
	assert.equal(E.pickTitle(['pl ace rt ie ai de yt on'], co), null);
	assert.equal(E.pickTitle([], co), null);
	assert.equal(E.pickTitle(['Partie 1 - NumPy'], co), null);
	assert.equal(E.pickTitle(['I - Entrées, sorties, exceptions'], co), null);
});

test('downloadFiles : renommage proposé, jamais par-dessus un autre fichier', async () => {
	const dir = tmpdir();
	const body = 'x'.repeat(2048);
	fs.writeFileSync(path.join(dir, 'Pris.pdf'), 'autre');
	const { s, root } = await server((req, res) => {
		res.setHeader('Content-Type', 'application/pdf');
		res.end(req.url.startsWith('/petit') ? 'abc' : req.url.startsWith('/a') ? 'y'.repeat(3000) : body);
	});
	const c = E.createClient('tok', { root });
	const f = (name, p, size) => ({ name, url: `${root}${p}`, size, timemodified: 1700000000 });
	try {
		const r = await E.downloadFiles(c, [
			{ file: f('a_b.pdf', '/a', 3000), dir, rename: async () => 'Propre.pdf' },
			{ file: f('c.pdf', '/c', 2048), dir, rename: async () => 'Pris.pdf' },
			{ file: f('d.pdf', '/d', 2048), dir, rename: async () => { throw new Error('pdf illisible'); } },
			{ file: f('petit.pdf', '/petit', 3), dir, rename: async () => 'Petit propre.pdf' },
			{ file: f('e.pdf', '/e', 2048), dir },
		]);
		assert.deepEqual(r.map((x) => x.saved), ['Propre.pdf', 'c.pdf', 'd.pdf', 'petit.pdf', 'e.pdf']);
		assert.equal(fs.readFileSync(path.join(dir, 'Pris.pdf'), 'utf8'), 'autre');
		assert.deepEqual(fs.readdirSync(dir).sort(), ['Pris.pdf', 'Propre.pdf', 'c.pdf', 'd.pdf', 'e.pdf', 'petit.pdf']);
		// Le fichier renommé reste reconnu comme présent (même taille, même extension).
		const scan = { sections: [{ activities: [{ files: [f('a_b.pdf', '/a', 3000)] }] }] };
		E.applyStatus(scan, dir);
		assert.equal(scan.sections[0].activities[0].files[0].status, 'present');
		assert.equal(scan.sections[0].activities[0].files[0].localName, 'Propre.pdf');
	} finally {
		c.close();
		stop(s);
	}
});
