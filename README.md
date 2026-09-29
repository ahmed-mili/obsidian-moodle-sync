# Moodle Sync

Plugin Obsidian (desktop) pour le Moodle de l'**Efrei** (`moodle.myefrei.fr`).

- Télécharge les fichiers de tes cours via l'**API mobile** de Moodle et les range dans le dossier de chaque module.
- Suit les **devoirs à rendre**, leurs **dates limites** et l'état de dépôt, dans un panneau dédié.
- Bouton **« Déposer »** : ouvre la page de dépôt Moodle **et** l'explorateur sur le dossier des rendus du module, pour un glisser-déposer direct.

Le jeton de connexion vit dans le `localStorage` local d'Obsidian (jamais dans le vault ni dans le dépôt).

## Installation ultra-simple (2 liens, via BRAT)

> Nécessite Obsidian **≥ 1.7.2** sur ordinateur (desktop).

1. **[Installer BRAT](obsidian://show-plugin?id=obsidian42-brat)** — clique directement sur **Installer BRAT**, puis sur *Installer* et *Activer* dans Obsidian.

2. **[Ajouter Moodle Sync](obsidian://brat?plugin=ahmed-mili/obsidian-moodle-sync)** — clique directement sur **Ajouter Moodle Sync** : BRAT installe et active automatiquement le plugin.

C'est fini. BRAT gardera le plugin à jour automatiquement à chaque nouvelle version.

<details>
<summary>Installation manuelle (sans BRAT)</summary>

Télécharge `main.js`, `manifest.json` et `styles.css` depuis la [dernière release](https://github.com/ahmed-mili/obsidian-moodle-sync/releases/latest), place-les dans `<vault>/.obsidian/plugins/moodle-sync/`, puis active le plugin dans les réglages.
</details>

## Développement

Les sources vivent dans [`src/`](src/) : `src/main.js` (interface) charge `src/engine.js` (API Moodle) comme fichier voisin. La distribution fusionne les deux :

```bash
node src/build.mjs   # régénère main.js (engine.js inliné) à la racine
```

Le `main.js` à la racine est l'artefact construit — ne pas l'éditer à la main, éditer `src/` puis relancer le build.

## Licence

[MIT](LICENSE) © Ahmed MILI
