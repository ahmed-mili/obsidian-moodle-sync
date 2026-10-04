'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Simule l'installation BRAT : seul le bundle est exécuté, sans engine.js voisin.
async function installedPlugin() {
	class Plugin {
		addCommand() {}
		registerObsidianProtocolHandler() {}
		addRibbonIcon() {}
		addSettingTab(tab) { this.settings = tab; }
	}
	class PluginSettingTab {
		constructor(app) {
			this.app = app;
			this.containerEl = { rows: [], empty() { this.rows = []; } };
		}
	}
	class Setting {
		constructor(container) { this.buttons = []; container.rows.push(this); }
		setName(name) { this.name = name; return this; }
		setDesc(desc) { this.desc = desc; return this; }
		setHeading() { return this; }
		addButton(callback) {
			const button = {
				setButtonText(text) { this.text = text; return this; },
				setCta() { return this; },
				setWarning() { return this; },
				onClick(click) { this.click = click; return this; },
			};
			callback(button);
			this.buttons.push(button);
			return this;
		}
	}
	const context = {
		module: { exports: {} },
		require(id) {
			if (id === 'obsidian') return { Plugin, PluginSettingTab, Setting, Modal: class {}, Notice: class {} };
			assert.ok(!id.endsWith('engine.js'), 'BRAT installation must not load an adjacent engine');
			return require(id);
		},
	};
	vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8'), context);
	const plugin = new context.module.exports();
	const storage = new Map();
	plugin.app = {
		vault: { adapter: { basePath: __dirname }, configDir: '.obsidian' },
		loadLocalStorage: (key) => storage.get(key),
		saveLocalStorage: (key, value) => storage.set(key, value),
	};
	await plugin.onload();
	return plugin;
}

test('bundle BRAT : chargement autonome et moteur disponible', async () => {
	const plugin = await installedPlugin();
	assert.equal(plugin.engine.ROOT, 'https://moodle.myefrei.fr');
	assert.equal(plugin.engine.prettyName('XTI302-CYB-Seance2_TP_Socle_Etudiant.pdf'), 'Séance 2 - TP Socle.pdf');
});

test('réglages : restaurer un devoir nommé ou inconnu, puis tous les devoirs', async () => {
	const plugin = await installedPlugin();
	plugin.courses = [{ id: 1, code: 'XTI305', name: 'XTI305 - Initiation' }];
	plugin.scans.set(1, { result: { sections: [{ activities: [{ id: 10, name: 'Compte-rendu', deposit: {} }] }] } });
	plugin.setDepositHidden(10, true);
	plugin.setDepositHidden(20, true);
	plugin.settings.display();
	let rows = plugin.settings.containerEl.rows;
	const named = rows.find((row) => row.name === 'Compte-rendu');
	assert.ok(named.desc.includes('XTI305'));
	assert.ok(rows.some((row) => row.name === 'Devoir non résolu'));
	named.buttons.find((button) => button.text === 'Réafficher').click();
	assert.equal(plugin.ignoredDeposits().has(10), false);
	assert.equal(plugin.ignoredDeposits().has(20), true);
	plugin.setDepositHidden(30, true);
	plugin.settings.display();
	rows = plugin.settings.containerEl.rows;
	rows.flatMap((row) => row.buttons).find((button) => button.text === 'Tout réafficher').click();
	assert.equal(plugin.ignoredDeposits().size, 0);
	assert.ok(plugin.settings.containerEl.rows.some((row) => row.desc?.startsWith('Aucun devoir masqué.')));
});
