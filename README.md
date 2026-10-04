# Moodle Sync

Plugin Obsidian (desktop) pour le Moodle de l'**Efrei** (`moodle.myefrei.fr`).

- Télécharge les fichiers de tes cours via l'**API mobile** de Moodle et les range dans le dossier de chaque module.
- Suit les **devoirs à rendre**, leurs **dates limites** et l'état de dépôt, dans un panneau dédié.
- Bouton **« Déposer »** : ouvre la page de dépôt Moodle **et** l'explorateur sur le dossier des rendus du module, pour un glisser-déposer direct.

Le jeton de connexion vit dans le `localStorage` local d'Obsidian (jamais dans le vault ni dans le dépôt).

## Installation ultra-simple (2 liens, via BRAT)

> Nécessite Obsidian **≥ 1.7.2** sur ordinateur (desktop).

1. [Installer BRAT](obsidian://show-plugin?id=obsidian42-brat), puis choisir **Installer** et **Activer** dans Obsidian.
2. [Ajouter Moodle Sync](obsidian://brat?plugin=ahmed-mili/obsidian-moodle-sync). Dans les paramètres de BRAT, on peut aussi choisir **Add beta plugin** et saisir `ahmed-mili/obsidian-moodle-sync`.

BRAT garde le plugin à jour à chaque nouvelle version. Si le plugin est déjà installé, utiliser **Check for updates** dans BRAT ; sa désinstallation n'est pas nécessaire.

Sur chaque ordinateur, ouvrir Moodle Sync puis **Se connecter** avec son compte Efrei. La connexion, les favoris et les devoirs masqués restent propres à chaque appareil.

Les devoirs se masquent avec l'icône œil. Pour les réafficher, aller dans **Paramètres → Moodle Sync → Devoirs masqués**.

### Installation manuelle

Télécharger `main.js`, `manifest.json` et `styles.css` depuis la [dernière version](https://github.com/ahmed-mili/obsidian-moodle-sync/releases/latest), les placer dans `<vault>/.obsidian/plugins/moodle-sync/`, puis activer le plugin. Aucun fichier `engine.js` supplémentaire n'est nécessaire.

## Développement

Les sources vivent dans [`src/`](src/) : `src/main.js` (interface) charge `src/engine.js` (API Moodle) comme fichier voisin. La distribution fusionne les deux :

```bash
node src/build.mjs   # régénère main.js (engine.js inliné) à la racine
node --test src/test/*.test.js
```

Le `main.js` à la racine est l'artefact construit — ne pas l'éditer à la main, éditer `src/` puis relancer le build.

## Licence

[MIT](LICENSE) © Ahmed MILI
