'use strict';
// Moteur de Moodle Sync : API mobile de Moodle (webservice REST), sans dépendance à Obsidian.
// main.js le charge par son chemin réel ; test/engine.test.js le teste avec node --test.

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream');

const ROOT = 'https://moodle.myefrei.fr';   // wwwroot exact : sert aussi à vérifier le passport
const COURSES_DIR = 'Bachelor Cybersécurité & Ethical Hacking';
const MTIME_TOLERANCE = 2000;               // ms : arrondis de date des systèmes de fichiers
const API_CONCURRENCY = 16;
const DOWNLOAD_CONCURRENCY = 8;
const API_TIMEOUT = 30000;                  // ms par appel API
const IDLE_TIMEOUT = 60000;                 // ms sans données avant d'abandonner un téléchargement
const MAX_REDIRECTS = 3;

class MoodleError extends Error {
	constructor(code, message) {
		super(message || code);
		this.name = 'MoodleError';
		this.code = code;
	}
}

// Jeton refusé ou expiré : main.js relance alors une connexion.
class TokenError extends MoodleError {
	constructor(code, message) {
		super(code, message);
		this.name = 'TokenError';
	}
}

// ------------------------------------------------------------ fonctions pures

function sanitize(name) {
	// NFC obligatoire : Moodle sert parfois des noms en NFD, ce qui crée des doublons invisibles.
	return String(name).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
	// &amp; en dernier : « &amp;lt; » doit donner « &lt; », pas « < ».
	return String(s || '').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
		.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// shortname « XTI302-CYB-2627PSA01 » ou « XCS-413-2627PSA01 » -> code, année, cohorte.
function parseCourse(raw) {
	const short = String(raw.shortname || '');
	const name = decodeEntities(raw.fullname || raw.displayname || short)
		.replace(/^\s*\*\s*/, '')
		// La liste des groupes entre parenthèses n'apprend rien ici.
		.replace(/\s*\((?:[A-Z0-9-]+\s*,\s*)*[A-Z0-9-]+(?:,\s*\.\.\.)?\)\s*$/, '')
		.trim();
	const code = short.match(/^([A-Z]{2,5})-?(\d{3})(?!\d)/);
	const year = short.match(/-(\d{2})(\d{2})[PB]/);
	const cohort = short.match(/-\d{4}([A-Z]{3}\d*)/);
	return {
		id: Number(raw.id),
		name,
		code: code ? code[1] + code[2] : null,
		yearKey: year ? `20${year[1]}-20${year[2]}` : null,
		cohort: cohort ? cohort[1] : null,
	};
}

// Dossiers de modules du vault : <vault>/Bachelor…/<année>/<CODE - Intitulé>.
function moduleDirs(vaultRoot) {
	const root = path.join(vaultRoot, COURSES_DIR);
	const out = [];
	if (!fs.existsSync(root)) return out;
	for (const year of fs.readdirSync(root, { withFileTypes: true })) {
		if (!year.isDirectory()) continue;
		const yearPath = path.join(root, year.name);
		for (const mod of fs.readdirSync(yearPath, { withFileTypes: true })) {
			if (mod.isDirectory()) out.push({ key: mod.name.toUpperCase(), path: path.join(yearPath, mod.name), year: year.name });
		}
	}
	return out;
}

// Ajoute dest (dossier du module) et yearLabel (« B2 (2026-2027) », le vocabulaire du vault), trie par code.
function locate(courses, vaultRoot) {
	const dirs = moduleDirs(vaultRoot);
	const list = courses.map((c) => {
		const d = c.code ? dirs.find((x) => x.key.startsWith(c.code.toUpperCase())) : null;
		return { ...c, dest: d ? d.path : null, yearLabel: d ? d.year : c.yearKey };
	});
	// Un seul libellé par année : dès qu'un cours de l'année a un dossier, son nom vaut pour toute l'année.
	const labels = new Map();
	for (const c of list) if (c.dest && c.yearKey) labels.set(c.yearKey, c.yearLabel);
	return list
		.map((c) => (c.yearKey && labels.has(c.yearKey) ? { ...c, yearLabel: labels.get(c.yearKey) } : c))
		.sort((a, b) => (a.code || 'zz').localeCompare(b.code || 'zz', 'fr'));
}

function toFile(c) {
	return {
		url: c.fileurl,
		name: sanitize(c.filename),
		size: c.filesize ?? null,
		timemodified: c.timemodified || 0,
		status: 'missing',
	};
}

// Réponse de mod_assign_get_submission_status -> ce que l'utilisateur a déposé. Les fichiers
// rendus ne servent qu'à l'affichage : ils sont déjà dans le vault (Rendus/) et ne se
// téléchargent jamais.
function parseSubmission(st) {
	const last = (st && st.lastattempt) || {};
	const sub = last.submission || last.teamsubmission || {};
	const files = (sub.plugins || [])
		.flatMap((p) => (p.fileareas || []).flatMap((fa) => fa.files || []))
		.map((c) => ({ name: sanitize(c.filename), size: c.filesize ?? null }));
	return {
		status: sub.status || 'new',
		submittedAt: sub.timemodified || 0,
		extension: last.extensionduedate || 0,
		files,
	};
}

const URGENT_MS = 8 * 3600 * 1000;

// État d'un dépôt à l'instant now (ms). Dates Moodle en secondes.
//   submitted : envoyé au prof
//   todo      : pas envoyé, plus de 8 h devant soi
//   urgent    : pas envoyé, 8 h ou moins avant la date limite
//   late      : date limite passée, Moodle accepte encore un dépôt en retard
//   closed    : date limite d'acceptation passée, plus rien à faire
//   open      : pas envoyé, aucune date limite
// Un brouillon (status draft) n'est pas envoyé : il compte comme non déposé.
function depositState(dep, now = Date.now()) {
	if (dep.status === 'submitted') return { state: 'submitted', due: dep.due, remaining: 0 };
	const due = dep.extension || dep.due;
	if (!due) return { state: 'open', due: 0, remaining: 0 };
	const remaining = due * 1000 - now;
	if (remaining > 0) return { state: remaining <= URGENT_MS ? 'urgent' : 'todo', due, remaining };
	if (dep.cutoff && dep.cutoff * 1000 <= now) return { state: 'closed', due, remaining };
	return { state: 'late', due, remaining };
}

function formatRemaining(ms) {
	const min = Math.floor(ms / 60000);
	if (min < 1) return 'moins d\'une minute';
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h} h ${String(min % 60).padStart(2, '0')}`;
	return `${Math.floor(h / 24)} j ${h % 24} h`;
}

// Réponses de l'API -> sections -> activités -> fichiers, dans l'ordre de la page du cours.
// assignments : mod_assign_get_assignments ; deposits : cmid -> parseSubmission().
function flattenContents(sections, assignments = [], deposits = new Map()) {
	const byCmid = new Map(assignments.map((a) => [a.cmid, a]));
	const out = [];
	for (const s of sections || []) {
		const activities = [];
		for (const m of s.modules || []) {
			// Invisible pour l'utilisateur, ou simple étiquette de mise en page.
			if (m.uservisible === false || m.modname === 'label') continue;
			const files = [];
			const external = [];
			for (const c of m.contents || []) {
				if (c.type === 'url') {
					if (c.fileurl) external.push(c.fileurl);
					continue;
				}
				if (c.type !== 'file' || !c.fileurl) continue;
				// Le texte d'une page ou d'un livre arrive comme index.html : ce n'est pas un document.
				if ((m.modname === 'page' || m.modname === 'book') && c.filename === 'index.html') continue;
				files.push(toFile(c));
			}
			const assign = byCmid.get(m.id);
			// Le sujet joint au devoir se télécharge comme tout support de cours.
			for (const f of (assign && assign.introattachments) || []) files.push(toFile(f));
			files.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
			const act = { id: m.id, name: decodeEntities(m.name), type: m.modname, files, external };
			// Devoir sans remise en ligne (nosubmissions) : rien à déposer, donc pas d'état.
			if (assign && !assign.nosubmissions) {
				const d = deposits.get(m.id) || parseSubmission(null);
				act.deposit = {
					due: assign.duedate || 0,
					cutoff: assign.cutoffdate || 0,
					status: d.status,
					submittedAt: d.submittedAt,
					files: d.files,
				};
				if (d.extension) act.deposit.extension = d.extension;
			}
			activities.push(act);
		}
		if (activities.length) out.push({ name: decodeEntities(s.name).trim() || 'Sans titre', activities });
	}
	return out;
}

// Même nom final dans deux activités : un seul fichier sur le disque (casse ignorée, comme
// NTFS), on garde le plus récent.
function dedupe(sections) {
	const best = new Map();
	for (const s of sections) for (const a of s.activities) for (const f of a.files) {
		const key = f.name.toLowerCase();
		const cur = best.get(key);
		if (!cur || f.timemodified > cur.timemodified) best.set(key, f);
	}
	for (const s of sections) for (const a of s.activities) a.files = a.files.filter((f) => best.get(f.name.toLowerCase()) === f);
	return sections;
}

function localStatus(file, dir) {
	if (!dir) return 'missing';
	let st;
	try {
		st = fs.statSync(path.join(dir, file.name));
	} catch (e) {
		return 'missing';
	}
	// Plus récent sur Moodle : le prof a remplacé le fichier. Une copie locale plus récente
	// (PDF annoté) reste « présente » : on ne l'écrase pas.
	return file.timemodified * 1000 > st.mtimeMs + MTIME_TOLERANCE ? 'outdated' : 'present';
}

function allFiles(scan) {
	return scan.sections.flatMap((s) => s.activities.flatMap((a) => a.files));
}

const RENAMED_MIN_SIZE = 1024;                 // en dessous, deux fichiers de même taille ne prouvent rien
const SKIP_DIRS = new Set(['node_modules', '__pycache__']);

// Taille -> chemins relatifs des fichiers du dossier du module (sous-dossiers compris, dossiers
// cachés et environnements exclus). Sert à reconnaître un support renommé ou rangé ailleurs
// dans le module, pour ne pas le télécharger une seconde fois sous son nom Moodle.
function sizeIndex(dir) {
	const index = new Map();
	const walk = (rel, depth) => {
		let entries;
		try {
			entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
		} catch (e) {
			return;
		}
		for (const e of entries) {
			if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
			const r = rel ? path.join(rel, e.name) : e.name;
			if (e.isDirectory()) {
				if (depth < 3) walk(r, depth + 1);
			} else if (e.isFile()) {
				const size = fs.statSync(path.join(dir, r)).size;
				if (size < RENAMED_MIN_SIZE) continue;
				if (!index.has(size)) index.set(size, []);
				index.get(size).push(r);
			}
		}
	};
	if (dir) walk('', 0);
	return index;
}

function findRenamed(file, index) {
	if (!file.size || file.size < RENAMED_MIN_SIZE) return null;
	const ext = path.extname(file.name).toLowerCase();
	return (index.get(file.size) || []).find((r) => path.extname(r).toLowerCase() === ext) || null;
}

// Recalcule les statuts d'après le disque, sans toucher aux fichiers en cours ou en échec.
function applyStatus(scan, dir) {
	let index = null;
	for (const f of allFiles(scan)) {
		if (f.status === 'busy' || f.status === 'failed') continue;
		f.status = localStatus(f, dir);
		delete f.localName;
		if (f.status !== 'missing' || !dir) continue;
		index = index || sizeIndex(dir);
		const renamed = findRenamed(f, index);
		if (renamed) {
			f.status = 'present';
			f.localName = renamed;
		}
	}
	return scan;
}

// Devoirs à rendre d'un module, du plus pressé au moins pressé. Ni rendus, ni fermés, ni
// ignorés par l'utilisateur. fresh : dépôt apparu depuis la dernière visite du module.
function pendingDeposits(scan, { now = Date.now(), seen = new Set(), ignored = new Set() } = {}) {
	const out = [];
	for (const s of scan.sections) for (const a of s.activities) {
		if (!a.deposit || ignored.has(a.id)) continue;
		const st = depositState(a.deposit, now);
		if (st.state === 'submitted' || st.state === 'closed') continue;
		out.push({ id: a.id, name: a.name, state: st.state, due: st.due, remaining: st.remaining, fresh: !seen.has(a.id) });
	}
	return out.sort(compareDeposits);
}

// Les retards d'abord, du plus ancien au plus récent, puis ce qu'on peut encore rendre à
// temps, du plus pressé au moins pressé.
function compareDeposits(x, y) {
	const RANK = { late: 0, urgent: 1, todo: 2, open: 3 };
	return RANK[x.state] - RANK[y.state] || (x.due || Infinity) - (y.due || Infinity);
}

const PENDING = new Set(['missing', 'outdated', 'failed']);

function pending(scan) {
	return allFiles(scan).filter((f) => PENDING.has(f.status));
}

function summarize(scan) {
	let missing = 0;
	let outdated = 0;
	for (const f of allFiles(scan)) {
		if (f.status === 'missing' || f.status === 'failed') missing++;
		else if (f.status === 'outdated') outdated++;
	}
	return { missing, outdated };
}

// Deux cohortes peuvent déposer le même nom dans le même dossier : un seul téléchargement
// par chemin (casse ignorée), le plus récent. Évite deux écritures sur le même temporaire.
function uniqueJobs(jobs) {
	const best = new Map();
	for (const j of jobs) {
		const key = path.join(j.dir, j.file.name).toLowerCase();
		const cur = best.get(key);
		if (!cur || j.file.timemodified > cur.file.timemodified) best.set(key, j);
	}
	return [...best.values()];
}

function launchUrl(passport, scheme, confirmed = false) {
	return `${ROOT}/admin/tool/mobile/launch.php?service=moodle_mobile_app&passport=${encodeURIComponent(passport)}`
		+ `&urlscheme=${encodeURIComponent(scheme)}${confirmed ? '&confirmed=1' : ''}`;
}

// Réponse de launch.php : base64(« md5(wwwroot + passport):::jeton[:::jeton privé] »). Le md5
// prouve qu'elle répond à NOTRE demande : un lien obsidian://token= forgé est rejeté.
function verifyLaunchToken(b64, passport) {
	const parts = Buffer.from(String(b64), 'base64').toString('utf8').split(':::');
	const expected = crypto.createHash('md5').update(ROOT + passport).digest('hex');
	if (parts.length < 2 || parts[0] !== expected || !/^[0-9a-f]{32}$/i.test(parts[1])) {
		throw new MoodleError('badlaunch', 'Réponse de connexion invalide : elle ne correspond pas à cette demande.');
	}
	return parts[1];
}

// File d'attente : au plus max tâches en cours, les suivantes démarrent dès qu'une se termine.
function limiter(max) {
	let active = 0;
	const queue = [];
	const next = () => {
		if (active >= max || !queue.length) return;
		active++;
		const { fn, resolve, reject } = queue.shift();
		Promise.resolve().then(fn).then(resolve, reject).finally(() => {
			active--;
			next();
		});
	};
	return (fn) => new Promise((resolve, reject) => {
		queue.push({ fn, resolve, reject });
		next();
	});
}

// -------------------------------------------------------------------- réseau

function toError(json) {
	const code = json.errorcode || 'moodle';
	const message = json.message || code;
	// Jeton expiré : « accessexception » (Invalid token - token expired) au premier appel,
	// puis « invalidtoken » aux suivants, Moodle l'ayant supprimé entre-temps.
	if (code === 'invalidtoken' || (code === 'accessexception' && /token/i.test(message))) return new TokenError(code, message);
	return new MoodleError(code, message);
}

// Client de l'API : connexions réutilisées (keep-alive), 16 appels simultanés au plus.
// root, apiTimeout et idleTimeout ne sont changés que par les tests (serveur http local).
function createClient(token, { root = ROOT, apiTimeout = API_TIMEOUT, idleTimeout = IDLE_TIMEOUT } = {}) {
	const agents = {
		'http:': new http.Agent({ keepAlive: true, maxSockets: API_CONCURRENCY }),
		'https:': new https.Agent({ keepAlive: true, maxSockets: API_CONCURRENCY }),
	};
	const limit = limiter(API_CONCURRENCY);

	function request(url, options, onResponse) {
		const u = new URL(url);
		return (u.protocol === 'http:' ? http : https).request(u, { agent: agents[u.protocol], ...options }, onResponse);
	}

	function call(fn, params = {}) {
		return limit(() => new Promise((resolve, reject) => {
			const body = new URLSearchParams({ wstoken: token, moodlewsrestformat: 'json', wsfunction: fn });
			for (const [k, v] of Object.entries(params)) body.append(k, String(v));
			const data = body.toString();
			const req = request(`${root}/webservice/rest/server.php`, {
				method: 'POST',
				timeout: apiTimeout,
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) },
			}, (res) => {
				const chunks = [];
				res.on('data', (c) => chunks.push(c));
				res.on('error', reject);
				res.on('end', () => {
					let json;
					try {
						json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
					} catch (e) {
						reject(new MoodleError('badjson', `Réponse illisible de Moodle (HTTP ${res.statusCode}).`));
						return;
					}
					if (json && json.exception) reject(toError(json));
					else resolve(json);
				});
			});
			req.on('timeout', () => req.destroy(new MoodleError('timeout', 'Moodle ne répond pas (30 s).')));
			req.on('error', reject);
			req.end(data);
		}));
	}

	function close() {
		agents['http:'].destroy();
		agents['https:'].destroy();
	}

	return { token, idleTimeout, call, request, close };
}

async function siteInfo(client) {
	const r = await client.call('core_webservice_get_site_info');
	return { userid: r.userid, fullname: r.fullname };
}

async function listCourses(client, userid, vaultRoot) {
	const raw = await client.call('core_enrol_get_users_courses', { userid });
	return locate(raw.map(parseCourse), vaultRoot);
}

// Recherche sur TOUT Moodle : un module existe parfois en plusieurs cohortes (PSA, BSA)
// et c'est celle où l'on n'est pas inscrit qui porte les supports.
async function searchCourses(client, term, vaultRoot) {
	const r = await client.call('core_course_search_courses', { criterianame: 'search', criteriavalue: term, perpage: 50 });
	return locate((r.courses || []).map(parseCourse).filter((c) => c.code), vaultRoot);
}

async function courseById(client, id, vaultRoot) {
	const r = await client.call('core_course_get_courses_by_field', { field: 'id', value: id });
	const raw = (r.courses || [])[0];
	if (!raw) throw new MoodleError('nocourse', `Cours ${id} introuvable ou inaccessible.`);
	return locate([parseCourse(raw)], vaultRoot)[0];
}

// Analyse d'un cours : contenu et devoirs en parallèle, puis les rendus de chaque devoir.
async function scanCourse(client, courseId, dir) {
	const [sections, assigns] = await Promise.all([
		client.call('core_course_get_contents', { courseid: courseId }),
		client.call('mod_assign_get_assignments', { 'courseids[0]': courseId }),
	]);
	const assignments = ((assigns.courses || [])[0] || {}).assignments || [];
	const deposits = new Map();
	await Promise.all(assignments.map(async (a) => {
		try {
			const st = await client.call('mod_assign_get_submission_status', { assignid: a.id });
			deposits.set(a.cmid, parseSubmission(st));
		} catch (e) {
			// Un devoir fermé ou inaccessible n'empêche pas le reste ; un jeton mort, si.
			if (e instanceof TokenError) throw e;
		}
	}));
	const tree = dedupe(flattenContents(sections, assignments, deposits));
	const external = [...new Set(tree.flatMap((s) => s.activities.flatMap((a) => a.external)))];
	return applyStatus({ sections: tree, external }, dir);
}

function friendly(e) {
	if (e instanceof MoodleError) return e;
	if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) {
		return new MoodleError('locked', 'Fichier ouvert dans une autre application : ferme-le puis réessaie.');
	}
	return new MoodleError(e.code || 'download', e.message);
}

function fetchToFile(client, url, tmp, redirects = 0) {
	return new Promise((resolve, reject) => {
		const req = client.request(url, { method: 'GET', timeout: client.idleTimeout }, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
				res.resume();
				resolve(fetchToFile(client, new URL(res.headers.location, url).href, tmp, redirects + 1));
				return;
			}
			// Une erreur Moodle (jeton refusé…) arrive en JSON à la place du fichier.
			if (res.statusCode !== 200 || /json/i.test(res.headers['content-type'] || '')) {
				res.resume();
				reject(new MoodleError('refused', `Moodle a refusé le fichier (HTTP ${res.statusCode}).`));
				return;
			}
			pipeline(res, fs.createWriteStream(tmp), (err) => (err ? reject(err) : resolve()));
		});
		req.on('timeout', () => req.destroy(new MoodleError('timeout', 'Téléchargement interrompu : aucune donnée depuis 60 s.')));
		req.on('error', reject);
		req.end();
	});
}

// Écrit d'abord un temporaire caché (invisible pour Obsidian, « *.tmp » exclu par Syncthing),
// puis le renomme : un échec ne touche jamais au fichier existant.
async function downloadOne(client, file, dir) {
	const target = path.join(dir, file.name);
	const tmp = path.join(dir, `.${file.name}.moodle-sync.tmp`);
	const url = new URL(file.url);
	url.searchParams.set('token', client.token);
	try {
		await fetchToFile(client, url.href, tmp);
		const size = fs.statSync(tmp).size;
		if (file.size != null && size !== file.size) {
			throw new MoodleError('incomplete', `Fichier incomplet (${size} octets sur ${file.size}).`);
		}
		// La date Moodle devient celle du fichier : c'est elle que compare localStatus.
		if (file.timemodified) fs.utimesSync(tmp, file.timemodified, file.timemodified);
		fs.renameSync(tmp, target);
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		throw friendly(e);
	}
}

// jobs : [{ file, dir, ... }]. 8 téléchargements simultanés au total, quel que soit le nombre
// de modules ; onDone(job, erreur|null) après chacun.
async function downloadFiles(client, jobs, onDone = () => {}) {
	const limit = limiter(DOWNLOAD_CONCURRENCY);
	return Promise.all(jobs.map((job) => limit(async () => {
		try {
			fs.mkdirSync(job.dir, { recursive: true });
			await downloadOne(client, job.file, job.dir);
			onDone(job, null);
			return { ...job, ok: true };
		} catch (e) {
			const err = friendly(e);
			onDone(job, err);
			return { ...job, ok: false, error: err.message };
		}
	})));
}

module.exports = {
	ROOT, MoodleError, TokenError,
	sanitize, decodeEntities, parseCourse, locate, flattenContents, dedupe,
	parseSubmission, depositState, formatRemaining, pendingDeposits, compareDeposits,
	localStatus, allFiles, applyStatus, pending, summarize, uniqueJobs,
	launchUrl, verifyLaunchToken, limiter,
	createClient, siteInfo, listCourses, searchCourses, courseById, scanCourse, downloadFiles, friendly,
};
