# Local Linker

Local Linker lets you develop an Obsidian plugin in its own folder, anywhere on your computer, and run it in a real vault. You link the folder one time. Each time your build writes new files, Local Linker reloads the plugin, so you see your change without a restart.

Without Local Linker, you keep your source code inside the vault or copy each build into it, and you reload the plugin by hand.

You can also link a folder over a plugin that you installed from the store or from BRAT. While the link is on, your folder replaces the installed version. When you turn off the link, the installed version comes back.

Local Linker works only on desktop.

## Link a plugin folder

1. Open Settings, then Local Linker.
2. In Link plugin folder, type the path of your plugin folder, for example `~/git/my-plugin`. The field suggests folders as you type.
3. Select Link.
4. In your plugin folder, run the watch build, for example `npm run dev`.

Local Linker turns on the plugin. When `main.js`, `styles.css` or `manifest.json` changes in the folder, Local Linker reloads the plugin.

Link the folder that contains `manifest.json`. Your build must write `main.js` and `styles.css` into that same folder.

## Settings

### Reload on change

If this setting is on, Local Linker reloads a linked plugin each time its files change. It is on by default. If you turn it off, reload the plugin with the reload button or the command.

### Turn off BRAT while linked

If this setting is on, Local Linker turns off BRAT while a link overrides a plugin that BRAT installed. When no such link is on, Local Linker turns BRAT back on. It is off by default. For the reason, read "Plugins installed by BRAT".

### Linked plugins

The list shows each linked plugin and the path of its folder.

- The toggle turns the link on or off.
- The reload button reloads the plugin now.
- The remove button turns off the link, then removes it from the list. Your folder stays on disk.

## Commands

Reload linked plugins reloads each plugin that has its link on.

## The installed version

You can link a folder for a plugin that is already in your vault. In that case, Local Linker moves the installed plugin folder to `.obsidian/plugins/local-plugin-linker/stash/`. Then it puts a symlink (a pointer to your folder) where the plugin was. When you turn off or remove the link, Local Linker removes the symlink and moves the installed version back. It never deletes a folder.

Before you uninstall Local Linker, turn off each link. If you uninstall it while a link is on, you lose the installed version that it saved.

## Plugins installed by BRAT

Each time Obsidian starts, BRAT updates its plugins. If BRAT updates a plugin while its link is on, BRAT writes the release files into your folder, over your build. If this can occur, the list of linked plugins shows a warning.

To prevent this, do one of these:

- Turn off the link before you restart Obsidian.
- Turn on "Turn off BRAT while linked". While BRAT is off, none of its plugins update.

Local Linker finds a plugin that BRAT installed from the GitHub remote in the `.git/config` file of your folder.

## Beta versions

To get pre-release versions of Local Linker, add `zachhannum/obsidian-local-plugin-linker` in BRAT.

## Disclosures

This plugin uses Node's file system module, because the folders that you link are outside your vault.

It reads only these files and folders:

- The folders that you type in Link plugin folder, to suggest folders.
- The folders that you link, and their `.git/config` file.
- The BRAT plugin list in your vault.

It writes only in your vault's plugins folder. It makes and removes a symlink for each link, and it moves an installed plugin into its own `stash` folder and back. It never changes a file in a folder that you link.

It also uses Obsidian's internal plugin API to turn plugins on, turn them off and reload them. A future Obsidian version can change that API.

## Develop

Build and release steps are in `CONTRIBUTING.md`.

## License

MIT
