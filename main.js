'use strict';

// --- engine.js inliné pour la distribution (voir src/build.mjs) ---
const __MOODLE_ENGINE__ = (() => {
	const module = { exports: {} };
	const exports = module.exports;
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

	return module.exports;
})();

const { Plugin, PluginSettingTab, Setting, Modal, Notice, setIcon } = require('obsidian');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Jeton et cache vivent dans le localStorage d'Obsidian, propre à chaque appareil : jamais
// dans le vault ni dans data.json (ce dossier est en Receive Only chez les camarades).
const TOKEN_KEY = 'moodle-sync-token';
const COURSES_KEY = 'moodle-sync-courses';
const SEEN_KEY = 'moodle-sync-seen-deposits';        // devoirs déjà vus : les autres sont « nouveaux »
const IGNORED_KEY = 'moodle-sync-ignored-deposits';  // devoirs masqués du bandeau (autre groupe…)
const COURSE_URL = /^https:\/\/moodle\.myefrei\.fr\/course\/view\.php\?(?:[^#]*&)?id=(\d+)/;

// Icône Lucide par type d'activité Moodle : la fenêtre doit se lire comme la page du cours.
const TYPE_ICON = {
	resource: 'file-text',
	folder: 'folder',
	url: 'link',
	page: 'file',
	book: 'book-open',
	assign: 'file-up',
	forum: 'message-square',
	quiz: 'list-checks',
	label: 'tag',
	feedback: 'clipboard-list',
};

const TYPE_LABEL = {
	resource: 'Fichier', folder: 'Dossier', url: 'Lien', page: 'Page', book: 'Livre',
	assign: 'Devoir', forum: 'Forum', quiz: 'Test', label: 'Étiquette', feedback: 'Retour',
};

function humanSize(bytes) {
	if (bytes === null || bytes === undefined) return '';
	if (bytes < 1024) return `${bytes} o`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

function courseIdOf(url) {
	const m = String(url || '').trim().match(COURSE_URL);
	return m ? Number(m[1]) : null;
}

// Presse-papier Electron : synchrone et sans permission (navigator.clipboard exige le focus).
// Il ne sert qu'à préremplir « Adresse manuelle », jamais à détourner l'ouverture.
function clipboardCourseUrl() {
	try {
		const text = (require('electron').clipboard.readText() || '').trim();
		return COURSE_URL.test(text) ? text : '';
	} catch (e) {
		return '';
	}
}

// ---------------------------------------------------------------- connexion

// Navigateur par défaut d'abord : vraie barre d'adresse, gestionnaire de mots de passe,
// session Efrei déjà ouverte. Moodle renvoie alors vers obsidian://token=… ; la fenêtre
// intégrée ne sert que de secours.
// Dossier où déposer un rendu : le sous-dossier « Rendus… » du module s'il existe, sinon le
// dossier du module lui-même. Sert à ouvrir l'explorateur pour un glisser-déposer sur Moodle.
function depositFolder(course) {
	if (!course || !course.dest) return null;
	try {
		const sub = fs.readdirSync(course.dest, { withFileTypes: true })
			.find((e) => e.isDirectory() && /rendus/i.test(e.name));
		return sub ? path.join(course.dest, sub.name) : course.dest;
	} catch (_) {
		return course.dest;
	}
}

// Ouvre la page de dépôt Moodle et, en plus, l'explorateur sur le dossier des rendus du module,
// pour glisser-déposer le fichier directement.
function openDeposit(engine, course, assignId) {
	const { shell } = require('electron');
	shell.openExternal(`${engine.ROOT}/mod/assign/view.php?id=${assignId}`);
	const folder = depositFolder(course);
	if (folder) shell.openPath(folder);
}

class LoginModal extends Modal {
	constructor(plugin, resolve, reject) {
		super(plugin.app);
		this.plugin = plugin;
		this.engine = plugin.engine;
		this.resolve = resolve;
		this.reject = reject;
		this.passport = crypto.randomBytes(16).toString('hex');
		this.settled = false;
		this.seen = new Set();
		this.disarm = null;
		this.webview = null;
	}

	onOpen() {
		this.modalEl.addClass('moodle-sync-modal', 'moodle-sync-login');
		const c = this.contentEl;
		c.addClass('ms-root');

		const head = c.createDiv({ cls: 'ms-head' });
		head.createEl('h2', { text: 'Connexion à Moodle', cls: 'ms-title' });
		this.hint = head.createEl('p', { cls: 'ms-hint' });
		this.status = c.createDiv({ cls: 'ms-status' });
		this.webHost = c.createDiv({ cls: 'ms-webview-host' });

		const foot = c.createDiv({ cls: 'ms-footer ms-footer-split' });
		const tools = foot.createDiv({ cls: 'ms-foot-tools' });
		this.reopenBtn = tools.createEl('button', { cls: 'ms-link', text: 'Rouvrir le navigateur' });
		this.reopenBtn.addEventListener('click', () => this.openBrowser());
		this.inAppBtn = tools.createEl('button', { cls: 'ms-link', text: 'Se connecter dans Obsidian' });
		this.inAppBtn.addEventListener('click', () => this.showWebview());
		const cancel = foot.createEl('button', { cls: 'ms-ghost', text: 'Annuler' });
		cancel.addEventListener('click', () => this.close());

		if (this.arm()) this.openBrowser();
		else this.showWebview();
	}

	openBrowser() {
		this.hint.setText("Ton navigateur s'ouvre sur Moodle. Connecte-toi si besoin, puis accepte « Ouvrir Obsidian ».");
		this.setStatus('En attente de ta connexion dans le navigateur…', true);
		require('electron').shell.openExternal(this.engine.launchUrl(this.passport, 'obsidian'));
	}

	// Obsidian range ses actions obsidian:// dans une Map interne (non documentée) et
	// l'interroge avec « token=… » : on l'intercepte le temps de la connexion seulement.
	arm() {
		const ph = this.app.workspace.protocolHandlers;
		if (!(ph instanceof Map)) return false;
		const own = (k) => Object.prototype.hasOwnProperty.call(ph, k);
		const saved = { has: own('has') ? ph.has : null, get: own('get') ? ph.get : null };
		const has = ph.has;
		const get = ph.get;
		const isToken = (k) => typeof k === 'string' && k.startsWith('token=');
		const self = this;
		ph.has = function (k) {
			if (!isToken(k)) return has.call(this, k);
			self.accept(k.slice('token='.length));
			return true;
		};
		ph.get = function (k) {
			return isToken(k) ? () => {} : get.call(this, k);
		};
		this.disarm = () => {
			if (saved.has) ph.has = saved.has; else delete ph.has;
			if (saved.get) ph.get = saved.get; else delete ph.get;
			this.disarm = null;
		};
		return true;
	}

	// Secours : Moodle affiché dans Obsidian, lien #launchapp lu après chaque chargement.
	showWebview() {
		if (this.webview) return;
		this.hint.setText('Connecte-toi avec tes identifiants Efrei dans la fenêtre ci-dessous.');
		this.setStatus('Chargement de Moodle…', true);
		this.inAppBtn.hide();
		this.reopenBtn.hide();
		const wv = document.createElement('webview');
		wv.setAttribute('partition', 'persist:moodle-sync');
		wv.setAttribute('src', this.engine.launchUrl(this.passport, 'moodlesync', true));
		wv.addClass('ms-webview');
		this.webHost.appendChild(wv);
		this.webview = wv;
		wv.addEventListener('did-finish-load', async () => {
			this.setStatus('', false);
			try {
				const href = await wv.executeJavaScript("(() => { const a = document.querySelector('#launchapp'); return a ? a.getAttribute('href') : ''; })()");
				const m = String(href || '').match(/token=([A-Za-z0-9+/=]+)/);
				if (m) this.accept(m[1]);
			} catch (e) {
				// Page en pleine redirection SSO : le chargement suivant réessaiera.
			}
		});
	}

	async accept(b64) {
		if (this.settled || this.seen.has(b64)) return;
		this.seen.add(b64);
		let token;
		try {
			token = this.engine.verifyLaunchToken(b64, this.passport);
		} catch (e) {
			new Notice(`Moodle Sync : ${e.message}`);
			return;
		}
		this.setStatus('Vérification du jeton…', true);
		const client = this.engine.createClient(token);
		try {
			const info = await this.engine.siteInfo(client);
			this.settled = true;
			this.plugin.saveToken({ token, userid: info.userid, fullname: info.fullname, at: Date.now() });
			this.resolve(info);
			new Notice(`Moodle Sync : connecté (${info.fullname}).`);
			this.close();
		} catch (e) {
			this.setStatus(e.message, false, true);
		} finally {
			client.close();
		}
	}

	setStatus(text, spinning, error) {
		this.status.empty();
		this.status.toggleClass('is-error', !!error);
		if (!text) {
			this.status.hide();
			return;
		}
		this.status.show();
		if (spinning) this.status.createDiv({ cls: 'ms-spinner' });
		this.status.createSpan({ text });
	}

	onClose() {
		if (this.disarm) this.disarm();
		if (this.webview) this.webview.remove();
		this.contentEl.empty();
		if (!this.settled) {
			this.settled = true;
			this.reject(new Error('Connexion annulée.'));
		}
	}
}

// ------------------------------------------------------------------ fenêtre

class MoodleSyncModal extends Modal {
	constructor(plugin, courseId) {
		super(plugin.app);
		this.plugin = plugin;
		this.engine = plugin.engine;
		this.courseId = courseId;       // cours à ouvrir d'emblée (tuile avec url=)
		this.view = null;               // 'connect' | 'picker' | 'course' | 'url' | 'loading'
		this.extra = [];                // cours ajoutés par « Chercher sur tout Moodle » ou par adresse
		this.opened = new Set();        // modules déjà revérifiés depuis l'ouverture
		this.yearFilter = undefined;
		this.searchedAll = false;
		this.refreshed = false;
		this.syncing = false;
		this.rows = new Map();          // id du cours -> { badge, course }
		this.fileEls = new Map();       // fichier -> { row, icon, badge, meta, error }
		this.onScan = (id) => this.handleScan(id);
	}

	onOpen() {
		this.modalEl.addClass('moodle-sync-modal');
		this.contentEl.addClass('ms-root');
		// Fermeture du menu d'année au clic ailleurs dans la fenêtre.
		this.contentEl.addEventListener('click', () => { if (this.menu) this.menu.hide(); });
		this.plugin.listeners.add(this.onScan);
		this.start();
	}

	onClose() {
		this.plugin.listeners.delete(this.onScan);
		this.stopDepositClock();
		this.contentEl.empty();
	}

	start() {
		if (!this.plugin.loadToken()) this.renderConnect();
		else if (this.courseId) this.openCourseById(this.courseId);
		else this.renderPicker();
	}

	setStatus(text, spinning, error) {
		if (!this.status) return;
		this.status.show();
		this.status.empty();
		this.status.toggleClass('is-error', !!error);
		if (spinning) this.status.createDiv({ cls: 'ms-spinner' });
		this.status.createSpan({ text });
	}

	renderHead(c, withBack) {
		const head = c.createDiv({ cls: 'ms-head' });
		if (withBack) {
			const back = head.createEl('button', { cls: 'ms-back' });
			setIcon(back, 'arrow-left');
			back.createSpan({ text: 'Autre module' });
			back.addEventListener('click', () => this.renderPicker());
		}
		return head;
	}

	// --- connexion ------------------------------------------------------------

	renderConnect() {
		this.view = 'connect';
		const c = this.contentEl;
		c.empty();
		const head = this.renderHead(c, false);
		head.createEl('h2', { text: 'Moodle Sync', cls: 'ms-title' });
		head.createEl('p', {
			cls: 'ms-hint',
			text: "Connecte-toi une fois à Moodle : ton navigateur s'ouvre, puis tout se fait ici. La connexion reste valable après un redémarrage.",
		});
		const box = c.createDiv({ cls: 'ms-connect' });
		const btn = box.createEl('button', { cls: 'ms-primary' });
		setIcon(btn.createSpan({ cls: 'ms-btn-icon' }), 'log-in');
		btn.createSpan({ text: 'Se connecter à Moodle' });
		this.status = c.createDiv({ cls: 'ms-status' });
		this.status.hide();
		btn.addEventListener('click', async () => {
			btn.disabled = true;
			try {
				await this.plugin.login();
				this.start();
			} catch (e) {
				btn.disabled = false;
				this.setStatus(e.message, false, true);
			}
		});
	}

	// --- liste des modules -----------------------------------------------------

	renderPicker() {
		this.view = 'picker';
		this.course = null;
		const c = this.contentEl;
		c.empty();

		const head = this.renderHead(c, false);
		head.createEl('h2', { text: 'Moodle Sync', cls: 'ms-title' });
		head.createEl('p', { cls: 'ms-hint', text: "Les modules de l'année sont vérifiés à chaque ouverture." });

		this.deadlines = c.createDiv({ cls: 'ms-deadlines' });
		this.deadlines.hide();

		const bar = c.createDiv({ cls: 'ms-searchbar' });
		setIcon(bar.createDiv({ cls: 'ms-search-icon' }), 'search');
		this.search = bar.createEl('input', {
			type: 'text',
			cls: 'ms-search',
			attr: { placeholder: 'Chercher un module…', spellcheck: 'false' },
		});
		// Menu d'année local : la modale n'a pas de contain, un positionnement absolu suffit.
		this.filterBtn = bar.createEl('button', { cls: 'ms-filter' });
		setIcon(this.filterBtn.createSpan({ cls: 'ms-filter-icon' }), 'list-filter');
		this.filterLabel = this.filterBtn.createSpan({ cls: 'ms-filter-label' });
		this.menu = bar.createDiv({ cls: 'ms-filter-menu' });
		this.menu.hide();
		this.filterBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			if (this.menu.isShown()) this.menu.hide(); else this.menu.show();
		});

		this.results = c.createDiv({ cls: 'ms-results' });

		const foot = c.createDiv({ cls: 'ms-footer ms-footer-split' });
		this.status = foot.createDiv({ cls: 'ms-status' });
		const right = foot.createDiv({ cls: 'ms-foot-right' });
		const tools = right.createDiv({ cls: 'ms-foot-tools' });
		tools.createEl('button', { cls: 'ms-link', text: 'Actualiser' }).addEventListener('click', () => this.refresh(true));
		tools.createEl('button', { cls: 'ms-link', text: 'Adresse manuelle' }).addEventListener('click', () => this.renderUrlStep());
		this.syncBtn = right.createEl('button', { cls: 'ms-primary ms-sync-all' });
		this.syncBtn.addEventListener('click', () => this.syncAll());

		this.search.addEventListener('input', () => {
			this.searchedAll = false;
			this.paint();
		});
		this.search.addEventListener('keydown', (e) => {
			if (e.key !== 'Enter') return;
			e.preventDefault();
			const first = this.results.querySelector('.ms-course');
			if (first) first.click();
		});

		if (this.plugin.courses) {
			this.afterCourses();
		} else {
			this.search.disabled = true;
			this.syncBtn.hide();
			this.setStatus('Chargement des cours…', true);
		}
		if (!this.refreshed) {
			this.refreshed = true;
			this.refresh(false);
		}
		window.setTimeout(() => this.search.focus(), 0);
	}

	// Liste fraîche depuis Moodle (le cache est déjà à l'écran), puis pré-analyse.
	// rescan (bouton Actualiser) : revérifie aussi les modules déjà vérifiés.
	async refresh(rescan) {
		if (rescan) this.setStatus('Actualisation depuis Moodle…', true);
		try {
			await this.plugin.refreshCourses();
		} catch (e) {
			if (this.view !== 'picker') return;
			if (!this.plugin.courses) {
				this.setStatus(e.message, false, true);
				return;
			}
			new Notice(`Moodle Sync : liste des cours non actualisée (${e.message}).`);
		}
		if (this.view !== 'picker') return;
		this.afterCourses();
		if (rescan) this.prescan(true);
	}

	afterCourses() {
		const years = [...new Set(this.allCourses().map((co) => co.yearLabel).filter(Boolean))]
			.sort((a, b) => b.localeCompare(a, 'fr'));
		// Par défaut, l'année la plus récente ; les précédentes restent à un clic.
		if (this.yearFilter === undefined) this.yearFilter = years[0] || null;
		this.menu.empty();
		const addOption = (value, text) => {
			const o = this.menu.createEl('button', { cls: 'ms-filter-option', text });
			o.addEventListener('click', (e) => {
				e.stopPropagation();
				this.applyFilter(value);
			});
		};
		for (const y of years) addOption(y, y);
		addOption(null, 'Toutes les années');
		this.search.disabled = false;
		this.syncBtn.show();
		this.applyFilter(this.yearFilter);
	}

	applyFilter(value) {
		this.yearFilter = value;
		this.filterLabel.setText(value || 'Toutes');
		this.filterBtn.toggleClass('is-active', !!value);
		this.menu.hide();
		this.paint();
		this.prescan(false);
	}

	allCourses() {
		const base = this.plugin.courses || [];
		const known = new Set(base.map((co) => co.id));
		return base.concat(this.extra.filter((co) => !known.has(co.id)));
	}

	// Cours de l'année affichée : la frappe filtre l'écran, pas la pré-analyse.
	visible() {
		return this.allCourses().filter((co) => !this.yearFilter || co.yearLabel === this.yearFilter);
	}

	// Vérifie les modules visibles qui ont un dossier, chacun une fois par ouverture sauf
	// force (Actualiser). L'ancien résultat reste affiché pendant la vérification.
	prescan(force) {
		for (const co of this.visible()) {
			if (!co.dest || (!force && this.opened.has(co.id))) continue;
			this.opened.add(co.id);
			this.plugin.scan(co, true);
		}
	}

	paint() {
		const q = this.search.value.trim().toLowerCase();
		this.results.empty();
		this.rows = new Map();
		const hits = this.visible().filter((co) => !q
			|| (co.code || '').toLowerCase().includes(q) || co.name.toLowerCase().includes(q));

		// Un module peut exister en plusieurs cohortes, dont une seule où l'on est inscrit.
		if (q.length >= 3 && !this.searchedAll) {
			const more = this.results.createEl('button', {
				cls: 'ms-searchall',
				text: `Chercher « ${this.search.value.trim()} » sur tout Moodle`,
			});
			more.addEventListener('click', (e) => {
				e.stopPropagation();
				this.searchAll(more);
			});
		}

		if (!hits.length) {
			this.results.createDiv({ cls: 'ms-empty', text: 'Aucun module ne correspond.' });
			this.paintFooter();
			return;
		}

		// Regroupement par année, la plus récente en premier (comme le Dashboard).
		const groups = new Map();
		for (const co of hits) {
			const key = co.yearLabel || 'Année inconnue';
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(co);
		}
		for (const [year, list] of [...groups.entries()].sort((a, b) => b[0].localeCompare(a[0], 'fr'))) {
			const g = this.results.createDiv({ cls: 'ms-year' });
			const h = g.createDiv({ cls: 'ms-year-name' });
			h.createSpan({ text: year });
			h.createSpan({ cls: 'ms-year-count', text: String(list.length) });
			for (const co of list.sort((a, b) => (a.code || 'zz').localeCompare(b.code || 'zz', 'fr'))) {
				const row = g.createEl('button', { cls: 'ms-course' });
				// data-code branche la couleur et l'icône définies dans dashboard-tiles.css.
				if (co.code) row.setAttr('data-code', co.code);
				row.createSpan({ cls: 'ms-course-icon' });
				const code = row.createSpan({ cls: 'ms-course-code', text: co.code || '—' });
				if (!co.dest) code.addClass('is-orphan');
				row.createSpan({ cls: 'ms-course-name', text: co.name.replace(/^\S+\s*-\s*/, '') });
				// La cohorte (PSA/BSA) distingue deux cours qui portent le même code.
				const twins = list.filter((x) => x.code === co.code).length > 1;
				if (twins && co.cohort) row.createSpan({ cls: 'ms-course-cohort', text: co.cohort });
				const deposit = row.createSpan({ cls: 'ms-course-deposit' });
				const badge = row.createSpan({ cls: 'ms-course-badge' });
				this.rows.set(co.id, { badge, deposit, course: co });
				this.paintBadge(co.id);
				row.addEventListener('click', () => this.onRowClick(co));
			}
		}
		this.paintFooter();
		this.paintDeadlines();
	}

	// Devoirs à rendre d'un module vérifié, d'après la dernière analyse.
	// hidden : les devoirs masqués par l'utilisateur au lieu des autres.
	depositsOf(co, hidden = false) {
		const st = co.dest && this.plugin.scans.get(co.id);
		if (!st || !st.result) return [];
		const init = !this.plugin.hasSeenDeposits();
		const ignored = this.plugin.ignoredDeposits();
		return this.engine.pendingDeposits(st.result, {
			seen: this.plugin.seenDeposits(),
			ignored: hidden ? new Set() : ignored,
		})
			.filter((d) => !hidden || ignored.has(d.id))
			.map((d) => ({ ...d, fresh: d.fresh && !init && !hidden, course: co }));
	}

	paintRowDeposit(id) {
		const r = this.rows.get(id);
		if (!r) return;
		const el = r.deposit;
		el.empty();
		el.className = 'ms-course-deposit';
		const list = this.depositsOf(r.course);
		if (!list.length) return;
		const hot = list.some((d) => d.state === 'urgent' || d.state === 'late');
		const fresh = list.some((d) => d.fresh);
		if (hot) el.addClass('is-urgent');
		if (fresh) el.addClass('is-fresh');
		setIcon(el.createSpan({ cls: 'ms-badge-icon' }), hot ? 'alarm-clock' : 'file-up');
		el.createSpan({ text: `${list.length} à rendre` });
	}

	// Bandeau « À rendre » : tous les devoirs non déposés des modules affichés, du plus
	// pressé au moins pressé. Rouge à 8 h ou moins de la date limite, et en retard.
	paintDeadlines() {
		const box = this.deadlines;
		if (!box || this.view !== 'picker') return;
		// Première utilisation : une fois tous les modules vérifiés, ce qui existe déjà est
		// « vu » ; seuls les dépôts ouverts ensuite seront signalés comme nouveaux.
		if (!this.plugin.hasSeenDeposits()) {
			const busy = this.visible().some((co) => {
				const st = co.dest && this.plugin.scans.get(co.id);
				return !st || st.state === 'busy';
			});
			if (!busy) this.plugin.markSeen(this.visible().flatMap((co) => this.depositsOf(co).map((d) => d.id)));
		}
		const order = this.engine.compareDeposits;
		const all = this.visible().flatMap((co) => this.depositsOf(co)).sort(order);
		const hidden = this.visible().flatMap((co) => this.depositsOf(co, true)).sort(order);
		// Le bandeau est repeint à chaque module vérifié : garder la position de défilement.
		const scrolled = box.querySelector('.ms-dl-list')?.scrollTop || 0;
		box.empty();
		if (!all.length && !hidden.length) {
			box.hide();
			return;
		}
		box.show();
		// Rouge dès qu'une date limite tombe dans les 8 h ; les retards sont comptés à part.
		const urgent = all.filter((d) => d.state === 'urgent').length;
		const late = all.filter((d) => d.state === 'late').length;
		const fresh = all.filter((d) => d.fresh).length;
		box.toggleClass('is-urgent', urgent > 0);
		box.toggleClass('is-clear', !all.length);
		const head = box.createDiv({ cls: 'ms-dl-head' });
		setIcon(head.createSpan({ cls: 'ms-dl-icon' }), urgent ? 'alarm-clock' : all.length ? 'file-up' : 'check');
		head.createSpan({
			cls: 'ms-dl-title',
			text: all.length ? `${all.length} devoir${all.length > 1 ? 's' : ''} à rendre` : 'Aucun devoir à rendre',
		});
		if (late) head.createSpan({ cls: 'ms-dl-late', text: `dont ${late} en retard` });
		if (fresh) head.createSpan({ cls: 'ms-dl-fresh', text: `${fresh} nouveau${fresh > 1 ? 'x' : ''}` });

		// Tous les devoirs dans une zone qui défile : pas de « Voir les autres » à cliquer.
		const list = box.createDiv({ cls: 'ms-dl-list is-scroll' });
		// La hauteur choisie à la poignée (resize vertical) survit aux repeints du bandeau.
		if (this.dlHeight) list.style.height = this.dlHeight;
		list.addEventListener('mouseup', () => { if (list.style.height) this.dlHeight = list.style.height; });
		for (const d of all) this.renderDeadline(list, d, false);
		list.scrollTop = scrolled;

		const tools = box.createDiv({ cls: 'ms-dl-tools' });
		if (hidden.length) {
			const toggle = tools.createEl('button', {
				cls: 'ms-link ms-dl-more',
				text: this.showHiddenDeadlines
					? 'Cacher les devoirs masqués'
					: `${hidden.length} devoir${hidden.length > 1 ? 's' : ''} masqué${hidden.length > 1 ? 's' : ''}`,
			});
			toggle.addEventListener('click', (e) => {
				e.stopPropagation();
				this.showHiddenDeadlines = !this.showHiddenDeadlines;
				this.paintDeadlines();
			});
			if (this.showHiddenDeadlines) {
				const hl = box.createDiv({ cls: 'ms-dl-list is-hidden-list' });
				for (const d of hidden) this.renderDeadline(hl, d, true);
			}
		}
		if (!tools.childElementCount) tools.remove();
	}

	// Une ligne du bandeau. masked : devoir masqué, affiché avec « Réafficher ».
	renderDeadline(list, d, masked) {
		const row = list.createDiv({ cls: `ms-dl-item is-${d.state}${masked ? ' is-masked' : ''}` });
		row.createSpan({ cls: 'ms-dl-code', text: d.course.code || '—' });
		// Nom complet de la matière, comme dans la liste des modules.
		row.createSpan({ cls: 'ms-dl-module', text: d.course.name.replace(/^\S+\s*-\s*/, '') });
		const name = row.createSpan({ cls: 'ms-dl-name', text: d.name });
		if (d.fresh) name.createSpan({ cls: 'ms-dl-new', text: 'Nouveau' });
		const when = d.state === 'late' ? 'en retard'
			: d.state === 'open' ? 'sans date limite'
			: `reste ${this.engine.formatRemaining(d.remaining)}`;
		const send = row.createEl('button', {
			cls: 'ms-dl-send',
			text: 'Déposer',
			attr: { 'aria-label': 'Ouvrir la page de dépôt Moodle et le dossier des rendus' },
		});
		send.addEventListener('click', (e) => {
			e.stopPropagation();
			openDeposit(this.engine, d.course, d.id);
		});
		row.createSpan({ cls: 'ms-dl-when', text: when });
		const btn = row.createEl('button', {
			cls: 'ms-dl-hide',
			attr: { 'aria-label': masked ? 'Réafficher ce devoir' : 'Masquer ce devoir' },
		});
		setIcon(btn, masked ? 'eye-off' : 'eye');
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.plugin.setDepositHidden(d.id, !masked);
			this.paintDeadlines();
			this.paintRowDeposit(d.course.id);
		});
		row.addEventListener('click', () => this.openCourse(d.course));
	}

	paintBadge(id) {
		this.paintRowDeposit(id);
		const r = this.rows.get(id);
		if (!r) return;
		const { badge, course } = r;
		badge.empty();
		badge.className = 'ms-course-badge';
		badge.removeAttribute('title');
		if (!course.dest) {
			badge.addClass('is-warn');
			badge.setText('pas de dossier');
			return;
		}
		const st = this.plugin.scans.get(id);
		if (!st) return;
		if (st.state === 'error') {
			badge.addClass('is-error');
			badge.setText('erreur');
			badge.setAttr('title', `${st.error} (clic pour relancer)`);
			return;
		}
		if (!st.result || this.engine.allFiles(st.result).some((f) => f.status === 'busy')) {
			badge.createDiv({ cls: 'ms-spinner' });
			return;
		}
		const { missing, outdated } = this.engine.summarize(st.result);
		if (!missing && !outdated) {
			badge.addClass('is-ok');
			setIcon(badge.createSpan({ cls: 'ms-badge-icon' }), 'check');
			badge.createSpan({ text: 'à jour' });
			return;
		}
		badge.addClass('is-new');
		const parts = [];
		if (missing) parts.push(`${missing} nouveau${missing > 1 ? 'x' : ''}`);
		if (outdated) parts.push(`${outdated} mis à jour`);
		badge.setText(parts.join(' · '));
	}

	onRowClick(co) {
		const st = this.plugin.scans.get(co.id);
		if (st && st.state === 'error') {
			this.plugin.scan(co, true);   // clic sur une ligne en erreur = relancer
			return;
		}
		this.openCourse(co);
	}

	// Fichiers à récupérer dans tous les modules vérifiés qui ont un dossier, un par chemin.
	pendingJobs() {
		const jobs = [];
		for (const co of this.allCourses()) {
			const st = this.plugin.scans.get(co.id);
			if (!co.dest || !st || !st.result) continue;
			for (const file of this.engine.pending(st.result)) jobs.push({ course: co, file, dir: co.dest });
		}
		return this.engine.uniqueJobs(jobs);
	}

	paintFooter() {
		if (this.view !== 'picker') return;
		const checking = this.visible().filter((co) => {
			const st = co.dest && this.plugin.scans.get(co.id);
			return st && st.state === 'busy';
		}).length;
		if (checking) this.setStatus(`Vérification de ${checking} module${checking > 1 ? 's' : ''}…`, true);
		else this.setStatus(`${this.visible().length} modules`, false);
		if (this.syncing) return;
		const jobs = this.pendingJobs();
		this.syncBtn.empty();
		this.syncBtn.disabled = !jobs.length;
		if (jobs.length) {
			setIcon(this.syncBtn.createSpan({ cls: 'ms-btn-icon' }), 'download');
			this.syncBtn.createSpan({ text: `Tout synchroniser (${jobs.length})` });
		} else {
			setIcon(this.syncBtn.createSpan({ cls: 'ms-btn-icon' }), checking ? 'loader' : 'check');
			this.syncBtn.createSpan({ text: checking ? 'Vérification…' : 'Tout est à jour' });
		}
	}

	async syncAll() {
		const jobs = this.pendingJobs();
		if (!jobs.length || this.syncing) return;
		this.syncing = true;
		let done = 0;
		const progress = () => {
			this.syncBtn.empty();
			this.syncBtn.disabled = true;
			this.syncBtn.createDiv({ cls: 'ms-spinner' });
			this.syncBtn.createSpan({ text: `${done} / ${jobs.length}` });
		};
		progress();
		try {
			const res = await this.plugin.download(jobs, () => {
				done++;
				progress();
			});
			const failed = res.filter((r) => !r.ok).length;
			new Notice(failed
				? `Moodle Sync : ${res.length - failed} fichier(s) enregistré(s), ${failed} échec(s).`
				: `Moodle Sync : ${res.length} fichier(s) enregistré(s).`);
		} catch (e) {
			new Notice(`Moodle Sync : ${e.message}`);
		} finally {
			this.syncing = false;
			this.paintFooter();
		}
	}

	async searchAll(btn) {
		const term = this.search.value.trim();
		btn.disabled = true;
		btn.setText('Recherche…');
		try {
			const found = await this.plugin.withClient((client) => this.engine.searchCourses(client, term, this.plugin.vaultRoot));
			const known = new Set(this.allCourses().map((co) => co.id));
			const extra = found.filter((co) => !known.has(co.id));
			this.extra = this.extra.concat(extra);
			this.searchedAll = true;
			this.paint();
			this.prescan(false);
			if (!extra.length) new Notice('Aucun cours supplémentaire trouvé.');
		} catch (e) {
			new Notice(`Moodle Sync : ${e.message}`);
			btn.remove();
		}
	}

	handleScan(id) {
		if (this.view === 'picker') {
			this.paintBadge(id);
			this.paintFooter();
			this.paintDeadlines();
			return;
		}
		if (this.view !== 'course' || !this.course || this.course.id !== id) return;
		const st = this.plugin.scans.get(id);
		if (!st) return;
		if (!st.result) {
			if (st.state === 'error') this.setStatus(st.error, false, true);
			return;
		}
		if (st.result !== this.shown) {
			// Nouvelle analyse : on redessine en gardant la position de lecture.
			const top = this.list ? this.list.scrollTop : 0;
			this.renderCourse(st.result);
			this.list.scrollTop = top;
			return;
		}
		for (const f of this.engine.allFiles(this.shown)) this.paintFileAction(f);
		this.refreshFooter();
	}

	// --- adresse manuelle -------------------------------------------------------

	renderUrlStep() {
		this.view = 'url';
		const c = this.contentEl;
		c.empty();
		const head = this.renderHead(c, true);
		head.createEl('h2', { text: 'Moodle Sync', cls: 'ms-title' });
		head.createEl('p', {
			cls: 'ms-hint',
			text: "Colle l'adresse de la page du cours. Le dossier du module est déduit de son code.",
		});
		const row = c.createDiv({ cls: 'ms-urlrow' });
		const input = row.createEl('input', {
			type: 'text',
			cls: 'ms-input',
			attr: { placeholder: 'https://moodle.myefrei.fr/course/view.php?id=…', spellcheck: 'false' },
		});
		input.value = clipboardCourseUrl();
		const btn = row.createEl('button', { cls: 'ms-primary', text: 'Ouvrir' });
		this.status = c.createDiv({ cls: 'ms-status' });
		this.status.hide();
		const go = () => {
			const id = courseIdOf(input.value);
			if (!id) {
				this.setStatus('Adresse invalide : il faut une page de cours Moodle (course/view.php?id=…).', false, true);
				return;
			}
			this.openCourseById(id);
		};
		btn.addEventListener('click', go);
		input.addEventListener('keydown', (e) => {
			if (e.key !== 'Enter') return;
			e.preventDefault();
			go();
		});
		window.setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	}

	// --- un module, comme sur Moodle ---------------------------------------------

	async openCourseById(id) {
		const known = this.allCourses().find((co) => co.id === id);
		if (known) {
			this.openCourse(known);
			return;
		}
		this.view = 'loading';
		const c = this.contentEl;
		c.empty();
		const head = this.renderHead(c, true);
		head.createEl('h2', { text: 'Moodle Sync', cls: 'ms-title' });
		this.status = c.createDiv({ cls: 'ms-status' });
		this.setStatus('Recherche du cours…', true);
		try {
			const co = await this.plugin.withClient((client) => this.engine.courseById(client, id, this.plugin.vaultRoot));
			this.extra.push(co);
			if (this.view === 'loading') this.openCourse(co);
		} catch (e) {
			if (this.view === 'loading') this.setStatus(e.message, false, true);
		}
	}

	openCourse(co) {
		this.view = 'course';
		this.course = co;
		this.shown = null;
		this.list = null;
		const st = this.plugin.scans.get(co.id);
		if (st && st.result) {
			this.renderCourse(st.result);
			return;
		}
		const c = this.contentEl;
		c.empty();
		this.renderCourseHead(c, co);
		this.status = c.createDiv({ cls: 'ms-status' });
		this.setStatus('Analyse du module…', true);
		this.plugin.scan(co, !!(st && st.state === 'error'));
	}

	renderCourseHead(c, co) {
		const head = this.renderHead(c, true);
		head.createEl('h2', { text: co.name, cls: 'ms-title' });
		const dest = head.createDiv({ cls: 'ms-dest' });
		setIcon(dest.createSpan({ cls: 'ms-dest-icon' }), 'folder-open');
		dest.createSpan({
			cls: 'ms-dest-path',
			text: co.dest ? co.dest.replace(/^.*Ethical Hacking[\\/]/, '') : 'Aucun dossier trouvé pour ce module',
		});
		if (!co.dest) dest.addClass('is-warn');
	}

	renderCourse(scan) {
		this.shown = scan;
		this.fileEls = new Map();
		this.depositEls = new Map();
		this.startDepositClock();
		const ids = scan.sections.flatMap((s) => s.activities.filter((a) => a.deposit).map((a) => a.id));
		if (ids.length && this.plugin.hasSeenDeposits()) this.plugin.markSeen(ids);
		const c = this.contentEl;
		c.empty();
		this.renderCourseHead(c, this.course);

		this.list = c.createDiv({ cls: 'ms-sections' });
		if (!scan.sections.length) this.list.createDiv({ cls: 'ms-empty', text: 'Aucune activité visible dans ce module.' });
		for (const sec of scan.sections) this.renderSection(this.list, sec);

		if (scan.external.length) {
			const ext = c.createDiv({ cls: 'ms-external' });
			const t = ext.createDiv({ cls: 'ms-external-title' });
			setIcon(t.createSpan({ cls: 'ms-external-icon' }), 'external-link');
			t.createSpan({ text: `${scan.external.length} lien(s) hors Moodle, non téléchargeables` });
			const ul = ext.createEl('ul');
			for (const e of scan.external) {
				const a = ul.createEl('li').createEl('a', { text: e, href: e });
				a.setAttr('target', '_blank');
			}
		}

		this.footer = c.createDiv({ cls: 'ms-footer' });
		this.allBtn = this.footer.createEl('button', { cls: 'ms-primary ms-all' });
		this.allBtn.addEventListener('click', () => this.download(this.engine.pending(this.shown)));
		this.refreshFooter();
	}

	renderSection(parent, sec) {
		const el = parent.createDiv({ cls: 'ms-section' });
		el.createDiv({ cls: 'ms-section-name', text: sec.name });
		for (const act of sec.activities) this.renderActivity(el, act);
	}

	renderActivity(parent, act) {
		const el = parent.createDiv({ cls: 'ms-activity' });
		const head = el.createDiv({ cls: 'ms-act-head' });
		const icon = head.createDiv({ cls: `ms-act-icon is-${act.type}` });
		setIcon(icon, TYPE_ICON[act.type] || 'circle-dot');
		const info = head.createDiv({ cls: 'ms-act-info' });
		info.createDiv({ cls: 'ms-act-name', text: act.name });
		const sub = info.createDiv({ cls: 'ms-act-meta' });
		sub.createSpan({ text: TYPE_LABEL[act.type] || act.type });
		if (!act.files.length && !act.external.length && !act.deposit) sub.createSpan({ cls: 'ms-act-empty', text: ' · aucun fichier' });
		if (act.deposit) this.renderDeposit(el, act);
		for (const f of act.files) this.renderFile(el, f);
	}

	// État du dépôt d'un devoir. Jamais de bouton de téléchargement ici : le rendu est déjà
	// dans le vault (Rendus/), Moodle n'en garde qu'une copie.
	renderDeposit(parent, act) {
		const row = parent.createDiv({ cls: 'ms-deposit' });
		const icon = row.createDiv({ cls: 'ms-deposit-icon' });
		const info = row.createDiv({ cls: 'ms-deposit-info' });
		const title = info.createDiv({ cls: 'ms-deposit-title' });
		const meta = info.createDiv({ cls: 'ms-deposit-meta' });
		const side = row.createDiv({ cls: 'ms-deposit-side' });
		this.depositEls.set(act, { row, icon, title, meta, side });
		this.paintDeposit(act);
	}

	paintDeposit(act) {
		const el = this.depositEls && this.depositEls.get(act);
		if (!el) return;
		const dep = act.deposit;
		const st = this.engine.depositState(dep);
		const when = (sec) => {
			const d = new Date(sec * 1000);
			const day = d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' });
			return `${day} à ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
		};
		const notSent = dep.status === 'draft' ? 'Brouillon non envoyé' : 'Non déposé';
		const urgent = st.state === 'urgent' || st.state === 'late' || st.state === 'closed';
		el.row.className = `ms-deposit is-${st.state}${urgent ? ' is-urgent' : ''}`;
		el.icon.empty();
		el.title.empty();
		el.meta.empty();
		el.side.empty();

		const ICON = { submitted: 'check', todo: 'clock', urgent: 'alarm-clock', late: 'triangle-alert', closed: 'lock', open: 'clock' };
		setIcon(el.icon, ICON[st.state]);

		if (st.state === 'submitted') {
			el.title.setText(dep.submittedAt ? `Déposé le ${when(dep.submittedAt)}` : 'Déposé');
			const names = dep.files.map((f) => f.name);
			if (names.length) el.meta.setText(names.join(' · '));
			el.side.createSpan({ cls: 'ms-badge is-present', text: 'Rendu' });
			return;
		}

		if (st.state === 'todo' || st.state === 'urgent') {
			el.title.setText(`${notSent} · reste ${this.engine.formatRemaining(st.remaining)}`);
			el.meta.setText(`À rendre avant le ${when(st.due)}`);
		} else if (st.state === 'late') {
			el.title.setText(`${notSent} · en retard`);
			el.meta.setText(dep.cutoff
				? `Date limite dépassée le ${when(st.due)}, dépôt encore accepté jusqu'au ${when(dep.cutoff)}`
				: `Date limite dépassée le ${when(st.due)}`);
		} else if (st.state === 'closed') {
			el.title.setText(`${notSent} · dépôt fermé`);
			el.meta.setText(`Plus aucun dépôt accepté depuis le ${when(dep.cutoff)}`);
		} else {
			el.title.setText(notSent);
			el.meta.setText('Pas de date limite');
		}
		if (st.state === 'closed') return;
		const masked = this.plugin.ignoredDeposits().has(act.id);
		el.row.toggleClass('is-masked', masked);
		if (masked) el.title.createSpan({ cls: 'ms-deposit-masked', text: ' · masqué' });
		const hide = el.side.createEl('button', {
			cls: 'ms-dl-hide ms-deposit-hide',
			attr: { 'aria-label': masked ? 'Réafficher ce devoir dans « À rendre »' : 'Masquer ce devoir de « À rendre »' },
		});
		setIcon(hide, masked ? 'eye-off' : 'eye');
		hide.addEventListener('click', () => {
			this.plugin.setDepositHidden(act.id, !masked);
			this.paintDeposit(act);
		});
		const b = el.side.createEl('button', { cls: 'ms-ghost', text: 'Déposer sur Moodle' });
		b.addEventListener('click', () => {
			openDeposit(this.engine, this.course, act.id);
		});
	}

	// Le temps restant défile tant que la fenêtre est ouverte : une carte peut passer au rouge
	// sans rien recharger.
	startDepositClock() {
		this.stopDepositClock();
		this.depositClock = window.setInterval(() => {
			if (this.depositEls) for (const act of this.depositEls.keys()) this.paintDeposit(act);
		}, 30 * 1000);
	}

	stopDepositClock() {
		if (this.depositClock) window.clearInterval(this.depositClock);
		this.depositClock = null;
	}

	renderFile(parent, f) {
		const row = parent.createDiv({ cls: 'ms-file' });
		const icon = row.createDiv({ cls: 'ms-file-icon' });
		const info = row.createDiv({ cls: 'ms-file-info' });
		// Nom complet, jamais tronqué : c'est le nom réel sur le disque.
		info.createDiv({ cls: 'ms-file-name', text: f.name });
		const meta = info.createDiv({ cls: 'ms-file-meta' });
		const bits = [];
		if (f.size) bits.push(humanSize(f.size));
		if (f.timemodified) bits.push(new Date(f.timemodified * 1000).toLocaleDateString('fr-FR'));
		meta.createSpan({ text: bits.join(' · ') });
		const badge = row.createDiv({ cls: 'ms-file-action' });
		this.fileEls.set(f, { row, icon, badge, meta, error: null });
		this.paintFileAction(f);
	}

	paintFileAction(f) {
		const el = this.fileEls.get(f);
		if (!el) return;
		el.row.className = `ms-file is-${f.status}`;
		el.icon.empty();
		el.badge.empty();
		if (el.error) {
			el.error.remove();
			el.error = null;
		}

		if (f.status === 'present') {
			setIcon(el.icon, 'check');
			el.badge.createSpan({ cls: 'ms-badge is-present', text: 'Déjà présent' });
			return;
		}
		if (f.status === 'busy') {
			setIcon(el.icon, 'download');
			el.badge.createDiv({ cls: 'ms-spinner' });
			return;
		}
		const failed = f.status === 'failed';
		setIcon(el.icon, failed ? 'triangle-alert' : 'download');
		if (failed && f.error) el.error = el.meta.createDiv({ cls: 'ms-file-error', text: f.error });
		const b = el.badge.createEl('button', {
			cls: 'ms-ghost',
			text: failed ? 'Réessayer' : f.status === 'outdated' ? 'Mettre à jour' : 'Télécharger',
		});
		b.addEventListener('click', () => this.download([f]));
	}

	refreshFooter() {
		if (!this.allBtn || !this.shown) return;
		const todo = this.engine.pending(this.shown);
		const busy = this.engine.allFiles(this.shown).some((f) => f.status === 'busy');
		this.allBtn.empty();
		this.allBtn.disabled = !todo.length || busy || !this.course.dest;
		if (busy) {
			this.allBtn.createDiv({ cls: 'ms-spinner' });
			this.allBtn.createSpan({ text: 'Téléchargement…' });
		} else if (!todo.length) {
			setIcon(this.allBtn.createSpan({ cls: 'ms-btn-icon' }), 'check');
			this.allBtn.createSpan({ text: 'Tout est à jour' });
		} else {
			setIcon(this.allBtn.createSpan({ cls: 'ms-btn-icon' }), 'download');
			this.allBtn.createSpan({ text: `Tout télécharger (${todo.length})` });
		}
	}

	async download(files) {
		const co = this.course;
		if (!co.dest) {
			new Notice("Aucun dossier de destination : le code du module n'a pas été reconnu.");
			return;
		}
		if (!files.length) return;
		try {
			const res = await this.plugin.download(files.map((file) => ({ course: co, file, dir: co.dest })));
			const failed = res.filter((r) => !r.ok).length;
			new Notice(failed
				? `Moodle Sync : ${res.length - failed} téléchargé(s), ${failed} échec(s).`
				: `Moodle Sync : ${res.length} fichier(s) enregistré(s).`);
		} catch (e) {
			new Notice(`Moodle Sync : ${e.message}`);
		}
	}
}

// ------------------------------------------------------------------ réglages

// Onglet « Moodle Sync » des modules complémentaires : état de la connexion de cet
// appareil, et accès à la page Moodle où l'on révoque le jeton.
class MoodleSyncSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const t = this.plugin.loadToken();
		// Jeton posé avant que le nom ne soit mémorisé : on le récupère une fois.
		if (t && !t.fullname) {
			this.plugin.withClient((client) => this.plugin.engine.siteInfo(client)).then((info) => {
				if (!info.fullname) return;
				this.plugin.saveToken({ ...t, fullname: info.fullname });
				this.display();
			}).catch(() => {});
		}

		new Setting(containerEl)
			.setName('Compte Moodle')
			.setDesc(t
				? `Connecté${t.fullname ? ` : ${t.fullname}` : ''}, depuis le ${new Date(t.at).toLocaleDateString('fr-FR')}. La connexion est propre à cet appareil.`
				: 'Non connecté sur cet appareil.')
			.addButton((b) => b
				.setButtonText(t ? 'Se reconnecter' : 'Se connecter')
				.setCta()
				.onClick(async () => {
					// L'ancien jeton reste en place tant que le nouveau n'est pas arrivé.
					try {
						await this.plugin.login();
					} catch (e) {
						new Notice(`Moodle Sync : ${e.message}`);
					}
					this.display();
				}));

		if (t) {
			new Setting(containerEl)
				.setName('Se déconnecter de cet appareil')
				.setDesc('Efface le jeton de cet appareil. Pour le révoquer aussi côté Moodle, passe par « Clés de sécurité » ci-dessous.')
				.addButton((b) => b
					.setButtonText('Se déconnecter')
					.setWarning()
					.onClick(() => {
						this.plugin.saveToken(null);
						this.plugin.scans.clear();
						new Notice('Moodle Sync : déconnecté de cet appareil.');
						this.display();
					}));
		}

		new Setting(containerEl)
			.setName('Clés de sécurité Moodle')
			.setDesc('Page Moodle où réinitialiser la clé « Moodle mobile web service » : le jeton est alors révoqué sur tous tes appareils, et Moodle Sync redemande la connexion.')
			.addButton((b) => b
				.setButtonText('Ouvrir dans le navigateur')
				.onClick(() => require('electron').shell.openExternal(`${this.plugin.engine.ROOT}/user/managetoken.php`)));

		new Setting(containerEl)
			.setName('Fenêtre Moodle Sync')
			.setDesc('Aussi accessible par la tuile MOODLE SYNC du Dashboard et par l\'icône du ruban.')
			.addButton((b) => b
				.setButtonText('Ouvrir')
				.onClick(() => this.plugin.openModal()));
	}
}

// ------------------------------------------------------------------- plugin

module.exports = class MoodleSyncPlugin extends Plugin {
	async onload() {
		this.vaultRoot = this.app.vault.adapter.basePath;
		// Le moteur est un fichier voisin, chargé par son chemin réel ; cache purgé pour qu'un
		// rechargement du plugin prenne aussi ses modifications.
		this.engine = __MOODLE_ENGINE__;

		this.client = null;
		this.loginPromise = null;
		this.coursesPromise = null;
		this.scans = new Map();       // id du cours -> { state, result, error, promise }
		this.listeners = new Set();   // fenêtres ouvertes, prévenues à chaque changement
		const cached = this.app.loadLocalStorage(COURSES_KEY);
		this.courses = Array.isArray(cached) && cached.length ? this.engine.locate(cached, this.vaultRoot) : null;

		this.addCommand({
			id: 'open',
			name: "Télécharger les fichiers d'un cours Moodle",
			callback: () => this.openModal(),
		});
		// Cible de la tuile MOODLE SYNC du Dashboard : obsidian://moodle-sync
		this.registerObsidianProtocolHandler('moodle-sync', (params) => this.openModal(params.url));
		this.addRibbonIcon('cloud-download', 'Moodle Sync', () => this.openModal());
		this.addSettingTab(new MoodleSyncSettingTab(this.app, this));
	}

	onunload() {
		if (this.client) this.client.close();
	}

	openModal(url) {
		new MoodleSyncModal(this, courseIdOf(url)).open();
	}

	// --- jeton ---------------------------------------------------------------

	hasSeenDeposits() {
		return Array.isArray(this.app.loadLocalStorage(SEEN_KEY));
	}

	seenDeposits() {
		return new Set(this.app.loadLocalStorage(SEEN_KEY) || []);
	}

	markSeen(ids) {
		const seen = this.seenDeposits();
		const before = seen.size;
		for (const id of ids) seen.add(id);
		if (seen.size !== before || !this.hasSeenDeposits()) this.app.saveLocalStorage(SEEN_KEY, [...seen]);
	}

	ignoredDeposits() {
		return new Set(this.app.loadLocalStorage(IGNORED_KEY) || []);
	}

	// Masquer un devoir d'un autre groupe (ou le réafficher après une erreur).
	setDepositHidden(id, hidden) {
		const set = this.ignoredDeposits();
		if (hidden) set.add(id); else set.delete(id);
		this.app.saveLocalStorage(IGNORED_KEY, [...set]);
	}

	loadToken() {
		return this.app.loadLocalStorage(TOKEN_KEY);
	}

	saveToken(value) {
		this.app.saveLocalStorage(TOKEN_KEY, value);
		// Pas de close() : des requêtes de l'ancien client peuvent encore être en vol.
		this.client = null;
	}

	getClient() {
		const t = this.loadToken();
		if (!t || !t.token) return null;
		if (!this.client || this.client.token !== t.token) this.client = this.engine.createClient(t.token);
		return this.client;
	}

	// Une seule fenêtre de connexion, même si 27 analyses la réclament en même temps.
	login() {
		if (!this.loginPromise) {
			this.loginPromise = new Promise((resolve, reject) => new LoginModal(this, resolve, reject).open())
				.finally(() => { this.loginPromise = null; });
		}
		return this.loginPromise;
	}

	// Exécute fn(client) ; jeton absent ou refusé : une connexion, puis un seul nouvel essai.
	async withClient(fn) {
		let client = this.getClient();
		if (!client) {
			await this.login();
			client = this.getClient();
		}
		try {
			return await fn(client);
		} catch (e) {
			if (!(e instanceof this.engine.TokenError)) throw e;
			// Une analyse partie avec l'ancien jeton ne doit pas effacer un jeton tout neuf.
			if ((this.loadToken() || {}).token === client.token) this.saveToken(null);
			if (!this.getClient()) await this.login();
			return fn(this.getClient());
		}
	}

	// --- cours et analyses ---------------------------------------------------

	refreshCourses() {
		if (!this.coursesPromise) {
			this.coursesPromise = this.withClient(async (client) => {
				const list = await this.engine.listCourses(client, this.loadToken().userid, this.vaultRoot);
				this.courses = list;
				this.app.saveLocalStorage(COURSES_KEY, list);
				return list;
			}).finally(() => { this.coursesPromise = null; });
		}
		return this.coursesPromise;
	}

	// Analyse partagée entre la liste et la vue module. force : réanalyser même si un
	// résultat existe (l'ancien reste affiché pendant ce temps).
	scan(course, force = false) {
		const cur = this.scans.get(course.id);
		if (cur && (cur.state === 'busy' || (cur.state === 'done' && !force))) return cur.promise;
		const entry = { state: 'busy', result: cur ? cur.result : null, error: null, promise: null };
		entry.promise = this.withClient((client) => this.engine.scanCourse(client, course.id, course.dest))
			.then((r) => {
				entry.state = 'done';
				entry.result = r;
				entry.error = null;
				return r;
			}, (e) => {
				entry.state = 'error';
				entry.error = e.message;
				throw e;
			})
			.finally(() => this.notify(course.id));
		entry.promise.catch(() => {});
		this.scans.set(course.id, entry);
		this.notify(course.id);
		return entry.promise;
	}

	notify(id) {
		for (const fn of this.listeners) fn(id);
	}

	// jobs : [{ course, file, dir }]. Statuts tenus à jour, fenêtres prévenues à chaque fichier.
	download(jobs, onDone) {
		const unique = this.engine.uniqueJobs(jobs);
		const courses = new Map(jobs.map((j) => [j.course.id, j.course]));
		for (const j of unique) j.file.status = 'busy';
		courses.forEach((co, id) => this.notify(id));
		return this.withClient((client) => this.engine.downloadFiles(client, unique, (job, err) => {
			job.file.status = err ? 'failed' : 'present';
			job.file.error = err ? err.message : null;
			if (onDone) onDone(job, err);
			this.notify(job.course.id);
		})).catch((e) => {
			for (const j of unique) {
				if (j.file.status !== 'busy') continue;
				j.file.status = 'failed';
				j.file.error = e.message;
			}
			throw e;
		}).finally(() => {
			// Un doublon écarté (même nom, autre cohorte) redevient « présent » grâce au fichier écrit.
			courses.forEach((co, id) => {
				const st = this.scans.get(id);
				if (st && st.result) this.engine.applyStatus(st.result, co.dest);
				this.notify(id);
			});
		});
	}
};
