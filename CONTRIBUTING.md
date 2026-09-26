# Contributing

## Build

1. Run `npm install`.
2. Run `npm run dev` for a watch build, or `npm run build` for a release build.
3. Run `npm test` to run the tests.

## Test in a vault

1. Make a symlink from this repository to `.obsidian/plugins/local-plugin-linker` in a test vault.
2. After each build, turn Local Linker off and on in Community plugins. Local Linker cannot reload itself.

## Release

1. In the Actions tab, open the "Cut a release" workflow.
2. Select Run workflow, then select patch, minor or major.

The workflow raises the version and pushes a tag. The tag starts the release workflow, which builds the plugin and attaches `main.js`, `manifest.json` and `styles.css` to a GitHub release.
