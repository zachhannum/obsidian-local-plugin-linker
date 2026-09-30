# Local Linker

Local Linker lets you develop an Obsidian plugin in its own folder, anywhere on your computer, and run it in a real vault. You link the folder one time. Each time your build writes new files, Local Linker reloads the plugin, so you see your change without a restart.

A link is a symlink (a pointer to your folder) in the plugins folder of your vault. Local Linker makes and removes it for you from the settings.

Local Linker can also install a build of a pull request or a branch from GitHub. A build is the plugin files that a GitHub Actions workflow makes for one commit. Use this to test a change on your phone, or to try a pull request before it is merged.

You can link a folder or install a build over a plugin that you installed from the store or from BRAT. While the link is on, your folder or build replaces the installed version. When you turn off the link, the installed version comes back.

Folder links work only on desktop. GitHub builds work on desktop and on mobile.

## Link a plugin folder

1. Open Settings, then Local Linker.
2. In Link plugin folder, type the path of your plugin folder, for example `~/git/my-plugin`. The field suggests folders as you type.
3. Select Link.
4. In your plugin folder, run the watch build, for example `npm run dev`.

Local Linker turns on the plugin. When `main.js`, `styles.css` or `manifest.json` changes in the folder, Local Linker reloads the plugin.

## Install a build from GitHub

The repository must have a workflow that uploads the plugin as an artifact. An artifact is a zip file that a workflow run keeps on GitHub. See [Set up the workflow](#set-up-the-workflow).

1. In Local Linker settings, in GitHub account, select Sign in.
2. Select Copy code and open GitHub. On GitHub, paste the code and approve Local Linker.
3. In Add GitHub repository, type the repository, for example `someone/my-plugin`. Then select Add.
4. In GitHub repositories, select Install a build.
5. Choose a pull request or a branch. The list shows open pull requests first, then branches.
6. If the build has more than one artifact, choose the one that holds the plugin.

Local Linker downloads the build and turns on the plugin. It remembers the artifact for each repository, and it uses the same artifact the next time.

To get a newer build of the same pull request or branch, select the download button in Linked plugins. The command Update GitHub builds does this for each build.

### Set up the workflow

The artifact must hold `main.js` and `manifest.json`. If the plugin has a `styles.css`, the artifact must hold it too. The files can be in a folder in the artifact. This workflow builds each pull request and each push, and uploads the files:

```yaml
name: Build

on:
  pull_request:
  push:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - uses: actions/upload-artifact@v4
        with:
          name: plugin
          path: |
            main.js
            manifest.json
            styles.css
```

### Limits

- GitHub keeps an artifact for 90 days by default. After that, run the workflow again.
- If a first-time contributor opens a pull request from a fork, the workflow runs only after a maintainer approves it.
- The list shows at most 100 pull requests and 100 branches.
- The list marks a pull request or a branch that has no recent successful run with "no recent build".

## Settings

### Reload on change

If this setting is on, Local Linker reloads a linked plugin each time its files change. It is on by default. If you turn it off, reload the plugin with the reload button or the command. This setting is only on desktop.

### Turn off BRAT while linked

If this setting is on, Local Linker turns off BRAT while a link or a build overrides a plugin that BRAT installed. When no such link is on, Local Linker turns BRAT back on. It is off by default. See [Plugins installed by BRAT](#plugins-installed-by-brat) for more information.

### Linked plugins

The list shows each linked folder and each build. For a folder, it shows the path. For a build, it shows the repository, the pull request or branch, and the commit.

- The toggle turns the link on or off.
- The download button installs the newest build. Only a build has this button.
- The reload button reloads the plugin now.
- The remove button turns off the link, then removes it from the list. Your folder stays on disk. The downloaded build is deleted.

### GitHub account

Sign in to GitHub here. GitHub requires a sign-in to download an artifact, even from a public repository. Local Linker keeps the sign-in in Obsidian's secret storage, not in its settings file. To remove the access completely, sign out, then revoke Local Linker in your GitHub settings under Applications.

### Include private repositories

If this setting is on, the sign-in asks for access to your private repositories. GitHub has no read-only access for private repositories, so GitHub gives Local Linker read and write access to all your repositories. Local Linker only reads. It is off by default. If you change it while you are signed in, sign out and sign in again.

### GitHub token

If you do not want to sign in, use a personal access token instead. While you are signed in, this setting is hidden. For a public repository, a fine-grained token with read-only access to public repositories is enough. For a private repository, give the token read access to Actions on that repository.

### GitHub repositories

The list shows each repository that you added.

- Install a build asks for a pull request or a branch, then installs its build.
- If Local Linker remembers an artifact for the repository, a reset button appears. Select it to choose the artifact again the next time.
- The remove button removes the repository from the list. Builds that you installed from it stay.

## Commands

- Reload linked plugins reloads each plugin that has its link on.
- Update GitHub builds installs the newest build of each build in the list.

## The installed version

You can link a folder or install a build for a plugin that is already in your vault. In that case, Local Linker moves the installed plugin folder to `.obsidian/plugins/local-plugin-linker/stash/`. Then it puts the symlink or the build where the plugin was. When you turn off or remove the link, Local Linker moves the installed version back.

A build that you turned off waits in `.obsidian/plugins/local-plugin-linker/builds/`. If you install a build over an installed version, Local Linker copies its `data.json` into the build. The plugin then keeps its settings. The installed version keeps its own copy.

Local Linker deletes only a symlink that it made and a build that it downloaded. It never deletes your folder or an installed version.

Before you uninstall Local Linker, turn off each link. If you uninstall it while a link is on, you lose the installed version that it saved.

## Plugins installed by BRAT

Each time Obsidian starts, BRAT updates its plugins. If BRAT updates a plugin while its link is on, BRAT writes the release files into your folder, over your build. For a GitHub build, BRAT replaces the build. If this can occur, the list of linked plugins shows a warning.

To prevent this, do one of these:

- Turn off the link before you restart Obsidian.
- Turn on "Turn off BRAT while linked". While BRAT is off, none of its plugins update.

For a folder, Local Linker finds the BRAT install from the GitHub remote in the `.git/config` file. For a build, it uses the repository of the build.

## Beta versions

To get pre-release versions of Local Linker, add `zachhannum/obsidian-local-plugin-linker` in BRAT.

## Disclosures

On desktop, this plugin uses Node's file system module, because the folders that you link are outside your vault.

It reads only these files and folders:

- The folders that you type in Link plugin folder, to suggest folders.
- The folders that you link, and their `.git/config` file.
- The BRAT plugin list in your vault.

It writes only in your vault's plugins folder. It makes and removes a symlink for each link, and it writes the files of each build that you install. It moves an installed plugin into its own `stash` folder and back. It never changes a file in a folder that you link.

To install a build, it connects to the GitHub API at `api.github.com` and downloads the artifact from GitHub. To sign in, it connects to `github.com`. It sends your GitHub token with each request to GitHub. It connects to GitHub only to sign in, and to install or update a build. You need a GitHub account.

It also uses Obsidian's internal plugin API to turn plugins on, turn them off and reload them. A future Obsidian version can change that API.

## Develop

Build and release steps are in `CONTRIBUTING.md`.

## License

MIT
