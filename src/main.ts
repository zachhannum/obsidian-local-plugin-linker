import {
	App,
	FileSystemAdapter,
	FuzzyMatch,
	FuzzySuggestModal,
	Modal,
	normalizePath,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	requestUrl,
	SecretComponent,
	Setting,
	SettingDefinitionItem,
	setIcon,
} from "obsidian";
import { BratInstall, findBratInstall } from "./brat";
import {
	Artifact,
	chooseArtifact,
	DeviceCode,
	Get,
	GitHub,
	Grant,
	parseRepo,
	Post,
	Ref,
	refLabel,
	refreshGrant,
	requestDeviceCode,
	waitForToken,
} from "./github";
import { buildIn, BuildPaths, buildOut, writeBuild } from "./install";
import { RepoSuggest } from "./repo-suggest";

type Desktop = typeof import("./desktop");

/** The slice of Obsidian's private plugin manager this plugin calls. It is not in the public typings. */
interface PluginManager {
	manifests: Record<string, { id: string; name: string } | undefined>;
	enabledPlugins: Set<string>;
	loadManifests(): Promise<void>;
	enablePlugin(id: string): Promise<boolean>;
	disablePlugin(id: string): Promise<void>;
	disablePluginAndSave(id: string): Promise<void>;
	enablePluginAndSave(id: string): Promise<boolean>;
}

interface FolderLink {
	/** Missing in data saved before builds existed. */
	kind?: "folder";
	id: string;
	source: string;
	/** Off means the installed copy, from BRAT or the store, sits at the plugin's folder instead. */
	enabled: boolean;
}

interface BuildLink {
	kind: "build";
	id: string;
	/** owner/name */
	repo: string;
	pr?: number;
	branch: string;
	title: string;
	/** The commit the installed build comes from. */
	sha: string;
	artifact: string;
	enabled: boolean;
}

type Link = FolderLink | BuildLink;

interface Repo {
	/** owner/name */
	name: string;
	/** The artifact that held the plugin last time. The next install takes it without asking. */
	artifact?: string;
}

interface Settings {
	links: Link[];
	repos: Repo[];
	/** The name of the token in Obsidian's secret storage, never the token itself. */
	tokenSecret: string;
	/** The GitHub login of the signed-in account. Empty when the token is not from a sign-in. */
	githubUser: string;
	/** When the sign-in token expires, in milliseconds since the epoch. 0 when it does not expire. */
	tokenExpires: number;
	/** A personal access token replaces the sign-in, and the settings show only the token. */
	useToken: boolean;
	autoReload: boolean;
	/** Turn BRAT off while any link overrides one of its installs, so no BRAT update writes over a link. */
	pauseBrat: boolean;
	/** The linker turned BRAT off, and it turns BRAT back on only in that case. */
	bratPaused: boolean;
}

const DEFAULTS: Settings = {
	links: [],
	repos: [],
	tokenSecret: "",
	githubUser: "",
	tokenExpires: 0,
	useToken: false,
	autoReload: true,
	pauseBrat: false,
	bratPaused: false,
};

/** The GitHub App that signs in to GitHub, with device flow turned on. A client ID is public. */
const GITHUB_CLIENT_ID = "Iv23lihnNV0HjTTnPR9w";

/** The GitHub App's name in its github.com/apps URL. */
const GITHUB_APP_SLUG = "obsidian-local-linker";

/** A sign-in keeps its tokens in Obsidian's secret storage under these names. */
const SIGN_IN_SECRET = "local-linker-github";
const REFRESH_SECRET = "local-linker-github-refresh";

/** A token this close to its expiry is renewed before use. */
const EXPIRY_MARGIN = 5 * 60 * 1000;

const BRAT_ID = "obsidian42-brat";

const FOLDER_UPDATE_WARNING =
	"BRAT will overwrite this folder the next time Obsidian starts. Turn off the link before you restart.";
const BUILD_UPDATE_WARNING = "BRAT will replace this build the next time Obsidian starts. Turn off the build before you restart.";

/** A change to one of these files in a linked folder reloads that plugin. */
const WATCHED = new Set(["main.js", "styles.css", "manifest.json"]);

const get: Get = async (url, headers) => {
	const response = await requestUrl({ url, headers, throw: false });
	return { status: response.status, json: () => response.json as unknown, bytes: () => response.arrayBuffer };
};

const post: Post = async (url, form) => {
	const response = await requestUrl({
		url,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		headers: { Accept: "application/json" },
		body: new URLSearchParams(form).toString(),
		throw: false,
	});
	return { status: response.status, json: () => response.json as unknown, bytes: () => response.arrayBuffer };
};

/** fetch drops the Authorization header on a redirect to another host. requestUrl keeps it. */
const getZip: Get = async (url, headers) => {
	const response = await fetch(url, { headers });
	const bytes = await response.arrayBuffer();
	return { status: response.status, json: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown, bytes: () => bytes };
};

export default class LocalPluginLinker extends Plugin {
	settings: Settings = DEFAULTS;
	/** Node's file system. Null on mobile, where folder links do not work. */
	desktop: Desktop | null = null;
	/** The text of BRAT's data.json, read again before each use that can change plugin state. */
	private bratData: string | null = null;
	private watchers = new Map<string, { close(): void }>();
	private timers = new Map<string, number>();

	get plugins(): PluginManager {
		return (this.app as App & { plugins: PluginManager }).plugins;
	}

	async onload() {
		// Mobile has no Node, so the module that needs it loads only on desktop.
		if (Platform.isDesktopApp) this.desktop = await import("./desktop");
		const data = (await this.loadData()) as Partial<Settings> | null;
		this.settings = { ...DEFAULTS, ...data };
		// A token chosen before sign-in existed keeps its place.
		if (data?.useToken === undefined && this.settings.tokenSecret && this.settings.tokenSecret !== SIGN_IN_SECRET) {
			this.settings.useToken = true;
		}
		this.settings.links = this.settings.links.map((l) => ({ ...l, enabled: l.enabled ?? true }));
		await this.readBrat();
		this.addSettingTab(new LinkerSettingTab(this.app, this));
		this.addCommand({
			id: "reload-linked-plugins",
			name: "Reload linked plugins",
			callback: async () => {
				for (const link of this.active()) await this.reload(link.id);
			},
		});
		this.addCommand({
			id: "update-builds",
			name: "Update GitHub builds",
			callback: async () => {
				for (const link of this.settings.links) if (link.kind === "build") await this.update(link).catch(report);
			},
		});
		this.app.workspace.onLayoutReady(() => {
			this.watchAll();
			void this.syncBrat();
		});
	}

	onunload() {
		this.unwatchAll();
	}

	async save() {
		await this.saveData(this.settings);
	}

	/** The links this device can use. A folder link needs the desktop app. */
	usable(): Link[] {
		return this.settings.links.filter((l) => l.kind === "build" || this.desktop);
	}

	active(): Link[] {
		return this.usable().filter((l) => l.enabled);
	}

	private pluginsDir(): string {
		return normalizePath(`${this.app.vault.configDir}/plugins`);
	}

	private buildPaths(id: string): BuildPaths {
		return {
			target: `${this.pluginsDir()}/${id}`,
			stash: this.stash(id),
			parked: normalizePath(`${this.manifest.dir ?? ""}/builds/${id}`),
		};
	}

	/** An installed copy moves here while a link covers its folder. */
	private stash(id: string): string {
		return normalizePath(`${this.manifest.dir ?? ""}/stash/${id}`);
	}

	private requireDesktop(): Desktop {
		if (!this.desktop) throw new Error("Folder links are only available on desktop.");
		return this.desktop;
	}

	/** The absolute path of a vault path. Only a folder link needs one. */
	private onDisk(vaultPath: string): string {
		const desktop = this.requireDesktop();
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) throw new Error("This vault is not stored on this computer.");
		return desktop.inVault(adapter.getBasePath(), vaultPath);
	}

	brat(link: Link): BratInstall | null {
		const repos = link.kind === "build" ? [link.repo] : (this.desktop?.githubRemotes(link.source) ?? []);
		return findBratInstall(this.bratData, link.id, repos);
	}

	private async readBrat() {
		this.bratData = await this.app.vault.adapter.read(`${this.pluginsDir()}/${BRAT_ID}/data.json`).catch(() => null);
	}

	/**
	 * Turns BRAT off while the setting is on and a link overrides a BRAT install, and back on after.
	 * The change is saved, because BRAT updates as it loads, before the linker could stop it.
	 */
	async syncBrat() {
		await this.readBrat();
		const pause = this.settings.pauseBrat && this.active().some((l) => this.brat(l));
		const on = this.plugins.enabledPlugins.has(BRAT_ID);
		if (pause && on) {
			await this.plugins.disablePluginAndSave(BRAT_ID);
			this.settings.bratPaused = true;
			await this.save();
			new Notice("Turned off BRAT so it cannot overwrite linked plugins.");
		} else if (!pause && this.settings.bratPaused) {
			this.settings.bratPaused = false;
			await this.save();
			if (!on && this.plugins.manifests[BRAT_ID]) {
				await this.plugins.enablePluginAndSave(BRAT_ID);
				new Notice("Turned on BRAT.");
			}
		}
	}

	async add(input: string) {
		const desktop = this.requireDesktop();
		const source = desktop.resolveFolder(input);
		const id = desktop.readPluginId(source);
		if (id === this.manifest.id) throw new Error("Local Linker cannot link itself.");
		const link: FolderLink = { id, source, enabled: false };
		if (await this.mayReplace(link)) await this.replace(link);
	}

	/**
	 * Asks before a folder link replaces a build, or a build replaces a folder link, because the old one
	 * leaves the list. A build that replaces a build is the normal switch between pull requests, so it does not ask.
	 */
	private async mayReplace(link: Link): Promise<boolean> {
		const old = this.settings.links.find((l) => l.id === link.id);
		if (!old || (old.kind === "build") === (link.kind === "build")) return true;
		const name = this.displayName(link.id);
		if (link.kind === "build" && old.kind !== "build") {
			if (!this.desktop) {
				throw new Error(`${name} is linked to a folder on desktop. Remove that link on desktop, then try again.`);
			}
			return confirm(
				this.app,
				`${name} is linked to ${old.source}. Replace the link with the build from ${refLabel(link)}? Your folder will not be changed.`,
			);
		}
		if (old.kind !== "build") return true;
		return confirm(
			this.app,
			`${name} uses the build from ${refLabel(old)}. Replace it with the linked folder? The build will be deleted.`,
		);
	}

	/** Puts `link` in the list in place of any link for the same plugin, then turns it on. */
	private async replace(link: Link) {
		const old = this.settings.links.find((l) => l.id === link.id);
		// A new build was already written over the parked one, so only a folder link removes an old build.
		if (old?.kind === "build" && link.kind !== "build") await this.remove(old);
		else if (old?.enabled) await this.setEnabled(old, false);
		this.settings.links = this.settings.links.filter((l) => l.id !== link.id);
		this.settings.links.push(link);
		await this.setEnabled(link, true);
	}

	/** Swaps the link in or out. The plugin stays on or off as it was, except a link turned on is always on. */
	async setEnabled(link: Link, on: boolean) {
		await this.readBrat();
		const wasOn = this.plugins.enabledPlugins.has(link.id);
		if (on && this.settings.pauseBrat && this.brat(link) && this.plugins.enabledPlugins.has(BRAT_ID)) {
			await this.plugins.disablePluginAndSave(BRAT_ID);
			this.settings.bratPaused = true;
			new Notice("Turned off BRAT so it cannot overwrite linked plugins.");
		}
		this.unwatch(link.id);
		if (wasOn) await this.plugins.disablePlugin(link.id);
		try {
			await this.swap(link, on);
			link.enabled = on;
			await this.save();
		} finally {
			await this.plugins.loadManifests();
			if (on && link.enabled) await this.plugins.enablePluginAndSave(link.id);
			else if (wasOn && this.plugins.manifests[link.id]) await this.plugins.enablePlugin(link.id);
			if (link.enabled) this.watch(link);
		}
		await this.syncBrat();
		const name = this.displayName(link.id);
		if (!on) {
			new Notice(`Switched ${name} to the installed version.`);
			return;
		}
		const switched = link.kind === "build" ? `Switched ${name} to the build from ${refLabel(link)}.` : `Switched ${name} to the linked folder.`;
		if (this.brat(link)?.updatesAtStartup && this.plugins.enabledPlugins.has(BRAT_ID)) {
			new Notice(`${switched} ${link.kind === "build" ? BUILD_UPDATE_WARNING : FOLDER_UPDATE_WARNING}`, 10000);
		} else new Notice(switched);
	}

	private async swap(link: Link, on: boolean) {
		if (link.kind === "build") {
			const files = this.app.vault.adapter;
			if (on) await buildIn(files, link.id, this.buildPaths(link.id));
			else await buildOut(files, link.id, this.buildPaths(link.id));
			return;
		}
		const desktop = this.requireDesktop();
		const target = this.onDisk(`${this.pluginsDir()}/${link.id}`);
		const stash = this.onDisk(this.stash(link.id));
		if (on) desktop.linkIn(link.id, link.source, target, stash);
		else desktop.linkOut(target, stash);
	}

	displayName(id: string): string {
		return this.plugins.manifests[id]?.name ?? id;
	}

	async remove(link: Link) {
		if (link.enabled) await this.setEnabled(link, false);
		if (link.kind === "build") {
			const { parked } = this.buildPaths(link.id);
			if (await this.app.vault.adapter.exists(parked)) await this.app.vault.adapter.rmdir(parked, true);
		}
		this.settings.links = this.settings.links.filter((l) => l !== link);
		await this.save();
	}

	async reload(id: string) {
		if (!this.plugins.enabledPlugins.has(id)) return;
		await this.plugins.disablePlugin(id);
		await this.plugins.loadManifests();
		await this.plugins.enablePlugin(id);
		new Notice(`Reloaded ${this.displayName(id)}.`);
	}

	async github(): Promise<GitHub> {
		const { tokenSecret, tokenExpires } = this.settings;
		if (tokenSecret === SIGN_IN_SECRET && tokenExpires && Date.now() > tokenExpires - EXPIRY_MARGIN) {
			const refreshToken = this.app.secretStorage.getSecret(REFRESH_SECRET);
			if (!refreshToken) throw new Error("Your GitHub sign-in expired. Sign in again in Local Linker settings.");
			await this.keepGrant(await refreshGrant(post, GITHUB_CLIENT_ID, refreshToken));
		}
		const token = this.settings.tokenSecret ? this.app.secretStorage.getSecret(this.settings.tokenSecret) : null;
		return new GitHub(get, token, getZip);
	}

	/** Signs in with GitHub's device flow. The person types a code on GitHub, so no token is copied by hand. */
	async signIn() {
		if (!GITHUB_CLIENT_ID) throw new Error("GitHub sign-in is not available in this build. Use a personal access token instead.");
		const code = await requestDeviceCode(post, GITHUB_CLIENT_ID);
		const modal = new SignInModal(this.app, code);
		modal.open();
		const grant = await waitForToken(post, GITHUB_CLIENT_ID, code, (ms) => modal.wait(ms)).finally(() => modal.close());
		if (!grant) return;
		this.settings.useToken = false;
		this.settings.githubUser = await new GitHub(get, grant.token).user();
		await this.keepGrant(grant);
		new Notice(`Signed in to GitHub as ${this.settings.githubUser}.`);
	}

	async signOut() {
		this.forgetSignIn();
		await this.save();
		new Notice("Signed out of GitHub.");
	}

	/** Switches between a sign-in and a personal access token. Either way starts with no access. */
	async setUseToken(useToken: boolean) {
		this.forgetSignIn();
		this.settings.useToken = useToken;
		await this.save();
	}

	private async keepGrant(grant: Grant) {
		this.app.secretStorage.setSecret(SIGN_IN_SECRET, grant.token);
		this.app.secretStorage.setSecret(REFRESH_SECRET, grant.refreshToken);
		this.settings.tokenSecret = SIGN_IN_SECRET;
		this.settings.tokenExpires = grant.expiresAt;
		await this.save();
	}

	private forgetSignIn() {
		if (this.settings.tokenSecret === SIGN_IN_SECRET) {
			this.app.secretStorage.setSecret(SIGN_IN_SECRET, "");
			this.app.secretStorage.setSecret(REFRESH_SECRET, "");
		}
		this.settings.tokenSecret = "";
		this.settings.tokenExpires = 0;
		this.settings.githubUser = "";
	}

	/** Adds a repo only after GitHub finds it with a workflow, under the name GitHub spells. */
	async addRepo(input: string) {
		const name = await (await this.github()).repo(parseRepo(input));
		if (this.settings.repos.some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new Error(`${name} is already in the list.`);
		this.settings.repos.push({ name });
		await this.save();
	}

	/** Asks for a pull request or branch, and for an artifact if the choice is not clear, then installs the build. */
	async chooseBuild(repo: Repo) {
		const github = await this.github();
		const refs = await github.refs(repo.name);
		if (refs.length === 0) throw new Error(`${repo.name} has no open pull requests or branches.`);
		const ref = await choose(this.app, refs, refLabel, "Choose a pull request or branch", (r) =>
			[r.pr === undefined ? "" : r.branch, r.built ? "" : "no recent build"].filter(Boolean).join(" · "),
		);
		if (!ref) return;
		const artifacts = await github.artifacts(repo.name, ref.sha);
		if (artifacts.length === 0) {
			throw new Error(`No build found for the latest commit on ${refLabel(ref)}. Wait for the workflow to finish, then try again.`);
		}
		const artifact =
			chooseArtifact(artifacts, repo.artifact) ??
			(await choose(this.app, artifacts, (a) => a.name, "Choose the artifact that contains the plugin"));
		if (!artifact) return;
		await this.install(repo, ref, artifact);
	}

	private async install(repo: Repo, ref: Ref, artifact: Artifact) {
		const downloading = new Notice(`Downloading ${artifact.name} from ${repo.name}...`, 0);
		const build = await (await this.github())
			.download(repo.name, artifact)
			.finally(() => downloading.hide());
		if (build.id === this.manifest.id) throw new Error("Local Linker cannot install a build of itself.");
		repo.artifact = artifact.name;
		const link: BuildLink = {
			kind: "build",
			id: build.id,
			repo: repo.name,
			pr: ref.pr,
			branch: ref.branch,
			title: ref.title,
			sha: ref.sha,
			artifact: artifact.name,
			enabled: false,
		};
		const old = this.settings.links.find((l) => l.id === build.id);
		if (old?.kind === "build" && old.enabled) {
			await writeBuild(this.app.vault.adapter, this.buildPaths(build.id).target, build.files);
			Object.assign(old, { ...link, enabled: true });
			await this.save();
			await this.reload(build.id);
			new Notice(`Switched ${this.displayName(build.id)} to the build from ${refLabel(link)}.`);
			return;
		}
		if (!(await this.mayReplace(link))) return;
		await writeBuild(this.app.vault.adapter, this.buildPaths(build.id).parked, build.files);
		await this.replace(link);
	}

	/** Installs the newest build of the pull request or branch that `link` follows. */
	async update(link: BuildLink) {
		const github = await this.github();
		const name = this.displayName(link.id);
		const ref = await github.refresh(link.repo, link);
		if (ref.sha === link.sha) {
			new Notice(`${name} is already up to date with ${refLabel(ref)}.`);
			return;
		}
		const artifact = (await github.artifacts(link.repo, ref.sha)).find((a) => a.name === link.artifact);
		if (!artifact) {
			throw new Error(`No ${link.artifact} artifact found for the latest commit on ${refLabel(ref)}. Wait for the workflow to finish, then try again.`);
		}
		const build = await github.download(link.repo, artifact);
		if (build.id !== link.id) {
			throw new Error(`The latest build from ${refLabel(ref)} contains ${build.id}, not ${link.id}. Install it from the repository list.`);
		}
		const { target, parked } = this.buildPaths(link.id);
		await writeBuild(this.app.vault.adapter, link.enabled ? target : parked, build.files);
		Object.assign(link, { title: ref.title, sha: ref.sha });
		await this.save();
		if (link.enabled) await this.reload(link.id);
		new Notice(`Updated ${name} to the latest build from ${refLabel(ref)}.`);
	}

	watchAll() {
		this.unwatchAll();
		if (this.settings.autoReload) for (const link of this.active()) this.watch(link);
	}

	private watch(link: Link) {
		if (!this.settings.autoReload || link.kind === "build" || !this.desktop) return;
		this.unwatch(link.id);
		try {
			const watcher = this.desktop.watchFolder(link.source, (file) => {
				if (WATCHED.has(file)) this.schedule(link.id);
			});
			this.watchers.set(link.id, watcher);
		} catch (e) {
			new Notice(`Cannot watch ${link.source} for changes: ${(e as Error).message}`);
		}
	}

	/** A bundler writes main.js in several steps, so a reload waits for the writes to stop. */
	private schedule(id: string) {
		window.clearTimeout(this.timers.get(id));
		this.timers.set(
			id,
			window.setTimeout(() => {
				this.timers.delete(id);
				void this.reload(id);
			}, 500),
		);
	}

	private unwatch(id: string) {
		this.watchers.get(id)?.close();
		this.watchers.delete(id);
		window.clearTimeout(this.timers.get(id));
		this.timers.delete(id);
	}

	unwatchAll() {
		for (const id of [...this.watchers.keys()]) this.unwatch(id);
	}
}

/** Shows the code to type on GitHub while the sign-in waits. Closing it cancels the sign-in. */
class SignInModal extends Modal {
	private closed = false;
	private cancel: (() => void) | null = null;

	constructor(
		app: App,
		private code: DeviceCode,
	) {
		super(app);
	}

	onOpen() {
		const { code } = this;
		this.setTitle("Sign in to GitHub");
		this.contentEl.createEl("p", { text: "Enter this code on GitHub to finish signing in." });
		this.contentEl.createEl("p", { text: code.userCode, cls: "local-plugin-linker-code" });
		new Setting(this.contentEl).addButton((b) =>
			b
				.setButtonText("Copy code and open GitHub")
				.setCta()
				.onClick(async () => {
					await navigator.clipboard.writeText(code.userCode);
					window.open(code.verificationUri);
				}),
		);
	}

	onClose() {
		this.closed = true;
		this.cancel?.();
	}

	/** Resolves true after `ms`, or false as soon as the modal closes. */
	wait(ms: number): Promise<boolean> {
		if (this.closed) return Promise.resolve(false);
		return new Promise((resolve) => {
			const timer = window.setTimeout(() => {
				this.cancel = null;
				resolve(true);
			}, ms);
			this.cancel = () => {
				window.clearTimeout(timer);
				resolve(false);
			};
		});
	}
}

/** Resolves true if the person selects Replace. Closing the modal is the same as Cancel. */
function confirm(app: App, message: string): Promise<boolean> {
	return new Promise((resolve) => new ConfirmModal(app, message, resolve).open());
}

class ConfirmModal extends Modal {
	private replaced = false;

	constructor(
		app: App,
		private message: string,
		private done: (replace: boolean) => void,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle("Replace link?");
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Replace")
					.setWarning()
					.onClick(() => {
						this.replaced = true;
						this.close();
					}),
			);
	}

	onClose() {
		this.done(this.replaced);
	}
}

/** Resolves with the chosen item, or with null if the person closes the list. */
function choose<T>(app: App, items: T[], label: (item: T) => string, placeholder: string, note?: (item: T) => string): Promise<T | null> {
	return new Promise((resolve) => new ChoiceModal(app, items, label, placeholder, resolve, note).open());
}

class ChoiceModal<T> extends FuzzySuggestModal<T> {
	constructor(
		app: App,
		private items: T[],
		private label: (item: T) => string,
		placeholder: string,
		private done: (item: T | null) => void,
		private note?: (item: T) => string,
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getItems(): T[] {
		return this.items;
	}

	getItemText(item: T): string {
		return this.label(item);
	}

	renderSuggestion(match: FuzzyMatch<T>, el: HTMLElement) {
		super.renderSuggestion(match, el);
		const note = this.note?.(match.item);
		if (note) el.createDiv({ text: note, cls: "local-plugin-linker-note" });
	}

	onChooseItem(item: T) {
		this.done(item);
	}

	onClose() {
		// The modal closes before it reports the choice, so a close waits one turn to report no choice.
		window.setTimeout(() => this.done(null), 0);
	}
}

function describe(link: Link, source: string, brat: BratInstall | null, paused: boolean, bratOn: boolean): DocumentFragment {
	const frag = createFragment();
	const row = (icon: string, text: string, mono = false) => {
		const el = frag.createDiv({ cls: "local-plugin-linker-row" });
		setIcon(el.createSpan({ cls: "local-plugin-linker-icon" }), icon);
		el.createSpan({ text, cls: mono ? "local-plugin-linker-mono" : "" });
	};
	if (link.kind === "build") {
		const title = frag.createDiv({ cls: "local-plugin-linker-title" });
		if (link.pr !== undefined) {
			title.createSpan({ text: `#${link.pr}`, cls: "local-plugin-linker-number" });
			title.appendText(link.title);
		} else title.appendText(link.branch);
		row("book-marked", link.repo);
		if (link.pr !== undefined) row("git-branch", link.branch);
		row("git-commit-horizontal", link.sha.slice(0, 7), true);
	} else row("folder", source, true);
	if (!brat) return frag;
	const badge = (text: string, tone: string) => frag.createDiv().createSpan({ text, cls: `local-plugin-linker-badge mod-${tone}` });
	if (!link.enabled) badge("Using BRAT's version", "neutral");
	else if (paused) badge("BRAT turned off while linked", "paused");
	else badge("Overrides BRAT", "active");
	if (link.enabled && !paused && bratOn && brat.updatesAtStartup) {
		frag.createDiv({ text: link.kind === "build" ? BUILD_UPDATE_WARNING : FOLDER_UPDATE_WARNING, cls: "local-plugin-linker-warning mod-warning" });
	}
	return frag;
}

function report(e: unknown) {
	new Notice((e as Error).message);
}

class LinkerSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: LocalPluginLinker,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const { plugin } = this;
		const refresh = () => this.update();
		const links = plugin.usable();
		return [
			{
				name: "Link plugin folder",
				desc: "Use a plugin folder on disk in place of the installed version.",
				visible: plugin.desktop !== null,
				render: (setting) => {
					const desktop = plugin.desktop;
					if (!desktop) return;
					let input = "";
					setting
						.addText((text) => {
							text.setPlaceholder("~/git/my-plugin").onChange((v) => (input = v));
							text.inputEl.addClass("local-plugin-linker-path");
							new desktop.FolderSuggest(this.app, text.inputEl);
						})
						.addButton((button) =>
							button
								.setButtonText("Link")
								.setCta()
								.onClick(() => plugin.add(input).then(refresh, report)),
						);
				},
			},
			{
				name: "Reload on change",
				desc: "Reload linked plugins when their files change.",
				visible: plugin.desktop !== null,
				control: { type: "toggle", key: "autoReload" },
			},
			{
				name: "Turn off BRAT while linked",
				desc: "Prevents BRAT from overwriting a linked plugin. While BRAT is off, it updates none of its plugins.",
				control: { type: "toggle", key: "pauseBrat" },
			},
			{
				type: "list",
				heading: "Linked plugins",
				emptyState: "No linked plugins.",
				onDelete: (index) => {
					const link = links[index];
					if (link) plugin.remove(link).then(refresh, report);
				},
				items: links.map((link) => ({
					name: plugin.displayName(link.id),
					desc: describe(
						link,
						link.kind === "build" ? "" : (plugin.desktop?.collapseHome(link.source) ?? link.source),
						plugin.brat(link),
						plugin.settings.bratPaused,
						plugin.plugins.enabledPlugins.has(BRAT_ID),
					),
					aliases: [link.id],
					render: (setting: Setting) => {
						setting.addToggle((t) =>
							t
								.setTooltip(link.kind === "build" ? "Use this build" : "Use this folder")
								.setValue(link.enabled)
								.onChange((on) => plugin.setEnabled(link, on).then(refresh, report)),
						);
						if (link.kind === "build") {
							setting.addExtraButton((b) =>
								b
									.setIcon("download")
									.setTooltip("Update to latest build")
									.onClick(() => plugin.update(link).then(refresh, report)),
							);
						}
						if (link.enabled) {
							setting.addExtraButton((b) =>
								b
									.setIcon("refresh-cw")
									.setTooltip("Reload")
									.onClick(() => plugin.reload(link.id)),
							);
						}
					},
				})),
			},
			{
				name: "GitHub account",
				desc: plugin.settings.githubUser
					? `Signed in as ${plugin.settings.githubUser}.`
					: "Sign in to download builds from GitHub Actions. Local Linker gets read-only access.",
				visible: () => !plugin.settings.useToken,
				render: (setting) => {
					if (plugin.settings.githubUser) {
						setting.addButton((b) => b.setButtonText("Sign out").onClick(() => plugin.signOut().then(refresh, report)));
						return;
					}
					setting
						.addButton((b) => b.setButtonText("Use a token").onClick(() => plugin.setUseToken(true).then(refresh, report)))
						.addButton((b) =>
							b
								.setButtonText("Sign in")
								.setCta()
								.onClick(() => plugin.signIn().then(refresh, report)),
						);
				},
			},
			{
				name: "Private repositories",
				desc: "To install builds from a private repository, install the Local Linker GitHub App on it.",
				visible: () => !plugin.settings.useToken,
				render: (setting) => {
					setting.addButton((b) =>
						b.setButtonText("Install on GitHub").onClick(() => window.open(`https://github.com/apps/${GITHUB_APP_SLUG}/installations/new`)),
					);
				},
			},
			{
				name: "GitHub token",
				desc: "A personal access token, stored in Obsidian's secret storage.",
				visible: () => plugin.settings.useToken,
				render: (setting) => {
					setting
						.addComponent((el) =>
							new SecretComponent(this.app, el).setValue(plugin.settings.tokenSecret).onChange(async (value) => {
								plugin.settings.tokenSecret = value;
								await plugin.save();
							}),
						)
						.addButton((b) => b.setButtonText("Sign in instead").onClick(() => plugin.setUseToken(false).then(refresh, report)));
				},
			},
			{
				name: "Add GitHub repository",
				desc: "Its workflow must upload the plugin's main.js and manifest.json as an artifact.",
				render: (setting) => {
					let input = "";
					setting
						.addText((text) => {
							text.setPlaceholder("owner/name").onChange((v) => (input = v));
							text.inputEl.addClass("local-plugin-linker-path");
							new RepoSuggest(this.app, text.inputEl, () => plugin.github());
						})
						.addButton((button) =>
							button
								.setButtonText("Add")
								.setCta()
								.onClick(() => plugin.addRepo(input).then(refresh, report)),
						);
				},
			},
			{
				type: "list",
				heading: "GitHub repositories",
				emptyState: "No repositories.",
				onDelete: (index) => {
					plugin.settings.repos.splice(index, 1);
					plugin.save().then(refresh, report);
				},
				items: plugin.settings.repos.map((repo) => ({
					name: repo.name,
					desc: repo.artifact ? `Artifact: ${repo.artifact}` : "",
					render: (setting: Setting) => {
						setting.addButton((b) =>
							b.setButtonText("Install build").onClick(() => plugin.chooseBuild(repo).then(refresh, report)),
						);
						if (repo.artifact) {
							setting.addExtraButton((b) =>
								b
									.setIcon("rotate-ccw")
									.setTooltip("Ask for the artifact next time")
									.onClick(() => {
										delete repo.artifact;
										plugin.save().then(refresh, report);
									}),
							);
						}
					},
				})),
			},
		];
	}

	/** A control saves its own value. These keys also change what the linker does now. */
	async setControlValue(key: string, value: unknown) {
		await super.setControlValue(key, value);
		if (key === "autoReload") this.plugin.watchAll();
		if (key === "pauseBrat") {
			await this.plugin.syncBrat().catch(report);
			this.update();
		}
	}
}
