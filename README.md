# Local Plugin Linker

An Obsidian plugin that links a plugin folder on disk into the vault. Each time the plugin rebuilds, the linker reloads it. Desktop only.

## Install

With BRAT, add `zachhannum/obsidian-local-plugin-linker`.

To install by hand:

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Put them in `<vault>/.obsidian/plugins/local-plugin-linker/`.
3. In Obsidian, turn on community plugins, then turn on Local Plugin Linker.

## Use

1. Open Settings, then Local Plugin Linker.
2. Under Link plugin folder, type the path of a plugin folder, for example `~/git/obsidian-orca`. The field suggests folders as you type.
3. Click Link.
4. Run the plugin's watch build, for example `npm run dev`.

The linker turns on the plugin and reloads it each time its files change.

If the plugin is already installed, from BRAT or the store, the linked folder overrides that version while the link is on. Turn off the link to go back to the installed version. Removing a link from the list turns it off first. Your folder stays on disk. The linker saves the installed version in its own `stash` folder, so if you uninstall the linker, you lose that version too.

While a link is on, a BRAT update overwrites files in your folder. Turn off the link before BRAT updates the plugin, or turn on "Turn off BRAT while linked". With that setting on, the linker turns off BRAT while a link overrides a plugin that BRAT installed, and turns BRAT back on after. While BRAT is off, none of its plugins update.

## Disclosures

This plugin uses Node's file system module, because the folders that you link are outside your vault.

It reads only these files and folders:

- The folders that you type in the settings, to suggest folders.
- The folders that you link, and their git configuration.
- The BRAT configuration in your vault.

It writes only in your vault's plugins folder. It makes and removes a symlink for each link, and it moves an installed plugin into its own `stash` folder and back. It never changes a file in a folder that you link.

It also uses Obsidian's internal plugin API to turn plugins on, turn them off and reload them. A future Obsidian version can change that API.

## Develop

1. Run `npm install`.
2. Run `npm run dev` for a watch build, or `npm run build` for a release build.

To release, run `npm version patch`, `npm version minor` or `npm version major`, then `git push --follow-tags`. The release workflow builds the plugin and attaches `main.js`, `manifest.json` and `styles.css` to a GitHub release.

## License

MIT
