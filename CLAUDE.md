# CLAUDE.md

Working agreements for the linker. These are policies, not suggestions.
If something here conflicts with a quick fix, the policy wins and the
quick fix waits for its own PR.

## Project shape

- One Obsidian plugin, desktop only. esbuild bundles `src/main.ts` into
  a single `main.js` beside `manifest.json` and `styles.css`. `npm run
  dev` watches.
- `src/main.ts` holds the plugin, the link lifecycle and the settings
  tab. `src/brat.ts` finds a BRAT install for a link and never touches
  Obsidian. `src/folder-suggest.ts` suggests folders on disk.
- Obsidian's private plugin manager is reached through the one
  `PluginManager` interface in `main.ts`. A new private call is added
  there, so the whole private surface stays in one place.
- Node's `fs` and `path` are the only way to disk. The vault adapter
  cannot reach folders outside the vault, and links live outside it.

## Invariants

- The linker never deletes a real folder. It removes only a symlink it
  made, and it moves an installed version into `stash/` rather than
  over it.
- Turning a link off puts the stashed version back before any plugin is
  turned on again.
- If the linker turned BRAT off, the linker turns it back on. Otherwise
  it leaves BRAT alone.
- A change to plugin state that must survive a restart is saved.
  BRAT updates as it loads, before the linker can stop it.

## UI text

- Strings follow Obsidian's settings style: sentence case and a short
  label as the name. If the name is not enough, add a description.
- Standard UI verbs: turn on, turn off, remove, reload, switch. No
  coined terms. Write "overrides", not "shadows".
- A notice names the plugin by its display name and says what happened
  ("Switched Orca to the linked folder.").
- A warning shows a danger that is real now. If a setting only makes
  the danger possible, no warning appears.
- An error says what failed, then what to do.

## Testing

- `npm test` runs Vitest. A test sits beside its code as
  `<name>.test.ts` and covers only code that never imports `obsidian`,
  like `brat.ts`. CI runs the build and the tests on each PR and on
  each push to `main`.
- A change is tested by hand in a vault that symlinks this repo into
  `.obsidian/plugins/local-plugin-linker`. The linker cannot reload
  itself: turn it off and on in Community plugins after a build.

## Releases

- A release starts from the "Cut a release" workflow in the Actions
  tab. It runs `npm version`, which bumps `package.json`,
  `manifest.json` and `versions.json` together and tags without a `v`
  prefix. It pushes the commit to `main` and then the tag as the
  release app, because main's ruleset lets only that app push. The app
  token comes from the `RELEASE_APP_ID` variable and the
  `RELEASE_APP_PRIVATE_KEY` secret.
- The tag runs `release.yml`. It refuses a tag that does not match
  `manifest.json` and `package.json`, then builds, tests and attaches
  `main.js`, `manifest.json` and `styles.css` to a GitHub release.
- The plugin id and name never contain "obsidian", and the manifest
  description never says "Obsidian" or "This plugin". Obsidian's review
  rejects both.
- If the code uses an API newer than `minAppVersion`, raise
  `minAppVersion`.
- The README's disclosures stay true: it reads folders outside the vault
  and uses Obsidian's internal plugin API.

## PRs and commits

- One change per branch: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`.
- `npm run build` (type check, then bundle) and `npm test` are green
  before a push.
- PR and issue bodies are unwrapped: one line per paragraph and per
  list item.
- **Claude does not merge.** A human reviews and merges every PR.
- Never force-push `main`.
- No Co-Authored-By trailers on commits.

## Documentation rules

Applies to code comments, the README and this file.

**DO**

- Keep them short.
- If the WHY is obvious, write no documentation.
- Write docs as statements of how things are.
- Run the `simple-english` skill over prose before it lands.

**DO NOT**

- Document what the code or doc already says.
- Document deletions or changes over time. History lives in git.
- Include links (code references, PRs, issues, error URLs).
- Explain why you did not choose a rejected alternative.

## Conventions

- TypeScript strict, and the flags in `tsconfig.json` are the floor.
  `noUncheckedIndexedAccess` stays on. No `any`, and no
  `@ts-expect-error` without the line that explains it.
- No inline styles. A style is a class in `styles.css`, prefixed
  `local-plugin-linker-`.
- Obsidian's own API before hand-built DOM: `Setting`, `Notice`,
  `AbstractInputSuggest`.
- A doc comment (`/** */`) on an exported item states an invariant, a
  constraint, or a consequence that a reader otherwise derives from
  the implementation. An export with none of those gets no comment.
