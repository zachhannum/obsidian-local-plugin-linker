# Local Plugin Linker

An Obsidian plugin that links a plugin folder on disk into the vault. Each time the plugin rebuilds, the linker reloads it. Desktop only.

## Install

1. Run `npm install` and `npm run build`.
2. Copy `manifest.json` and `main.js` into `<vault>/.obsidian/plugins/local-plugin-linker/`.
3. In Obsidian, turn on community plugins, then turn on Local Plugin Linker.

## Use

1. Open Settings, then Local Plugin Linker.
2. Under Link plugin folder, type the path of a plugin folder, for example `~/git/obsidian-orca`. The field suggests folders as you type.
3. Click Link.
4. Run the plugin's watch build, for example `npm run dev`.

The linker turns on the plugin and reloads it each time its files change.

If the plugin is already installed, from BRAT or the store, the linked folder overrides that version while the link is on. Turn off the link to go back to the installed version. Remove link turns off the link and removes it from the list. Your folder stays on disk. The linker saves the installed version in its own `stash` folder, so if you uninstall the linker, you lose that version too.

While a link is on, a BRAT update overwrites files in your folder. Turn off the link before BRAT updates the plugin, or turn on "Turn off BRAT while linked". With that setting on, the linker turns off BRAT while a link overrides a plugin that BRAT installed, and turns BRAT back on after. While BRAT is off, none of its plugins update.
