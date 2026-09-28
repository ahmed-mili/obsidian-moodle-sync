'use strict';

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
		const dir = this.manifest.dir || path.join(this.app.vault.configDir, 'plugins', this.manifest.id);
		const enginePath = path.join(this.vaultRoot, dir, 'engine.js');
		delete window.require.cache[window.require.resolve(enginePath)];
		this.engine = window.require(enginePath);

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
