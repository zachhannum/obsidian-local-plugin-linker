import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { BratInstall, findBratInstall } from "./brat";
import { FolderSuggest, expandHome } from "./folder-suggest";

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

interface Link {
	id: string;
	source: string;
	/** Off means the installed copy, from BRAT or the store, sits at the plugin's folder instead. */
	enabled: boolean;
}

interface Settings {
	links: Link[];
	autoReload: boolean;
	/** Turn BRAT off while any link shadows one of its installs, so no BRAT update writes into a linked folder. */
	pauseBrat: boolean;
	/** The linker turned BRAT off, and it turns BRAT back on only in that case. */
	bratPaused: boolean;
}

const DEFAULTS: Settings = { links: [], autoReload: true, pauseBrat: false, bratPaused: false };

const BRAT_ID = "obsidian42-brat";

const UPDATE_WARNING = "BRAT updates at startup and will overwrite files in this folder. Turn off the link before you restart Obsidian.";

/** A change to one of these files in a linked folder reloads that plugin. */
const WATCHED = new Set(["main.js", "styles.css", "manifest.json"]);

export default class LocalPluginLinker extends Plugin {
	settings: Settings = DEFAULTS;
	private watchers = new Map<string, fs.FSWatcher>();
	private timers = new Map<string, number>();

	get plugins(): PluginManager {
		return (this.app as App & { plugins: PluginManager }).plugins;
	}

	async onload() {
		const data = (await this.loadData()) as Partial<Settings> | null;
		this.settings = { ...DEFAULTS, ...data };
		this.settings.links = this.settings.links.map((l) => ({ ...l, enabled: l.enabled ?? true }));
		this.addSettingTab(new LinkerSettingTab(this.app, this));
		this.addCommand({
			id: "reload-linked-plugins",
			name: "Reload linked plugins",
			callback: async () => {
				for (const link of this.active()) await this.reload(link.id);
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

	active(): Link[] {
		return this.settings.links.filter((l) => l.enabled);
	}

	private vaultBase(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) throw new Error("This vault is not stored on this computer.");
		return adapter.getBasePath();
	}

	private pluginsDir(): string {
		return path.join(this.vaultBase(), this.app.vault.configDir, "plugins");
	}

	private target(id: string): string {
		return path.join(this.pluginsDir(), id);
	}

	brat(link: Link): BratInstall | null {
		return findBratInstall(this.pluginsDir(), link.id, link.source);
	}

	/**
	 * Turns BRAT off while the setting is on and a link shadows a BRAT install, and back on after.
	 * The change is saved, because BRAT updates as it loads, before the linker could stop it.
	 */
	async syncBrat() {
		const pause = this.settings.pauseBrat && this.active().some((l) => this.brat(l));
		const on = this.plugins.enabledPlugins.has(BRAT_ID);
		if (pause && on) {
			await this.plugins.disablePluginAndSave(BRAT_ID);
			this.settings.bratPaused = true;
			await this.save();
			new Notice("BRAT turned off, so its updates cannot overwrite a linked folder.");
		} else if (!pause && this.settings.bratPaused) {
			this.settings.bratPaused = false;
			await this.save();
			if (!on && this.plugins.manifests[BRAT_ID]) {
				await this.plugins.enablePluginAndSave(BRAT_ID);
				new Notice("BRAT turned on.");
			}
		}
	}

	/** An installed copy moves here while a link covers its folder. */
	private stash(id: string): string {
		return path.join(this.vaultBase(), this.manifest.dir ?? "", "stash", id);
	}

	async add(input: string) {
		const source = path.resolve(expandHome(input.trim()));
		const manifestPath = path.join(source, "manifest.json");
		if (!fs.existsSync(manifestPath)) throw new Error(`Not a plugin folder: manifest.json not found in ${source}`);
		const id: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8")).id;
		if (typeof id !== "string" || id === "") throw new Error("manifest.json is missing an id.");
		if (id === this.manifest.id) throw new Error("Local Plugin Linker cannot link itself.");

		const old = this.settings.links.find((l) => l.id === id);
		if (old?.enabled) await this.setEnabled(old, false);
		this.settings.links = this.settings.links.filter((l) => l.id !== id);
		const link: Link = { id, source, enabled: false };
		this.settings.links.push(link);
		await this.setEnabled(link, true);
	}

	/** Swaps the link in or out. The plugin stays on or off as it was, except a link turned on is always on. */
	async setEnabled(link: Link, on: boolean) {
		const target = this.target(link.id);
		const stash = this.stash(link.id);
		const wasOn = this.plugins.enabledPlugins.has(link.id);
		if (on && this.settings.pauseBrat && this.brat(link) && this.plugins.enabledPlugins.has(BRAT_ID)) {
			await this.plugins.disablePluginAndSave(BRAT_ID);
			this.settings.bratPaused = true;
			new Notice("BRAT turned off, so its updates cannot overwrite a linked folder.");
		}
		this.unwatch(link.id);
		if (wasOn) await this.plugins.disablePlugin(link.id);
		try {
			if (on) {
				const existing = lstatOrNull(target);
				if (existing?.isSymbolicLink()) fs.unlinkSync(target);
				else if (existing) {
					if (fs.existsSync(stash)) throw new Error(`Cannot turn on the link. A saved version of ${link.id} already exists in ${stash}.`);
					fs.mkdirSync(path.dirname(stash), { recursive: true });
					fs.renameSync(target, stash);
				}
				fs.mkdirSync(path.dirname(target), { recursive: true });
				// A junction needs no admin rights on Windows. Other systems ignore the type.
				fs.symlinkSync(link.source, target, "junction");
			} else {
				if (lstatOrNull(target)?.isSymbolicLink()) fs.unlinkSync(target);
				if (fs.existsSync(stash) && !fs.existsSync(target)) fs.renameSync(stash, target);
			}
			link.enabled = on;
			await this.save();
		} finally {
			await this.plugins.loadManifests();
			if (on && link.enabled) await this.plugins.enablePluginAndSave(link.id);
			else if (wasOn && this.plugins.manifests[link.id]) await this.plugins.enablePlugin(link.id);
			if (link.enabled) this.watch(link);
		}
		await this.syncBrat();
		const brat = this.brat(link);
		const name = this.displayName(link.id);
		if (!on) new Notice(`Switched ${name} to the installed version.`);
		else if (brat?.updatesAtStartup && this.plugins.enabledPlugins.has(BRAT_ID)) {
			new Notice(`Switched ${name} to the linked folder. ${UPDATE_WARNING}`, 10000);
		} else new Notice(`Switched ${name} to the linked folder.`);
	}

	displayName(id: string): string {
		return this.plugins.manifests[id]?.name ?? id;
	}

	async remove(link: Link) {
		if (link.enabled) await this.setEnabled(link, false);
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

	watchAll() {
		this.unwatchAll();
		if (this.settings.autoReload) for (const link of this.active()) this.watch(link);
	}

	private watch(link: Link) {
		if (!this.settings.autoReload) return;
		this.unwatch(link.id);
		try {
			const watcher = fs.watch(link.source, (_event, file) => {
				if (file && WATCHED.has(file.toString())) this.schedule(link.id);
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

function lstatOrNull(p: string): fs.Stats | null {
	try {
		return fs.lstatSync(p);
	} catch {
		return null;
	}
}

function describe(link: Link, brat: BratInstall | null, paused: boolean, bratOn: boolean): DocumentFragment {
	const frag = createFragment();
	frag.createDiv({ text: link.source });
	if (!brat) return frag;
	if (!link.enabled) {
		frag.createDiv({ text: "Using the version installed by BRAT." });
		return frag;
	}
	frag.createDiv({ text: "Overrides the version installed by BRAT." });
	if (paused) {
		frag.createDiv({ text: "BRAT is turned off while this link is on." });
	} else if (bratOn && brat.updatesAtStartup) {
		frag.createDiv({ text: UPDATE_WARNING, cls: "mod-warning" });
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

	display() {
		const { containerEl } = this;
		containerEl.empty();

		let input = "";
		new Setting(containerEl)
			.setName("Link plugin folder")
			.setDesc("Replaces the installed version until you turn off the link.")
			.addText((text) => {
				text.setPlaceholder("~/git/my-plugin").onChange((v) => (input = v));
				text.inputEl.style.width = "22em";
				new FolderSuggest(this.app, text.inputEl);
			})
			.addButton((button) =>
				button
					.setButtonText("Link")
					.setCta()
					.onClick(() => this.plugin.add(input).then(() => this.display(), report)),
			);

		new Setting(containerEl)
			.setName("Reload on change")
			.setDesc("Reload a linked plugin when its files change.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoReload).onChange(async (on) => {
					this.plugin.settings.autoReload = on;
					await this.plugin.save();
					this.plugin.watchAll();
				}),
			);

		new Setting(containerEl)
			.setName("Turn off BRAT while linked")
			.setDesc(
				"Turn off BRAT while a link overrides a plugin it installed, so its updates cannot overwrite your folder. While BRAT is off, none of its plugins update.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.pauseBrat).onChange(async (on) => {
					this.plugin.settings.pauseBrat = on;
					await this.plugin.save();
					await this.plugin.syncBrat().catch(report);
					this.display();
				}),
			);

		if (this.plugin.settings.links.length > 0) new Setting(containerEl).setName("Linked plugins").setHeading();
		for (const link of this.plugin.settings.links) {
			const row = new Setting(containerEl)
				.setName(this.plugin.plugins.manifests[link.id]?.name ?? link.id)
				.setDesc(describe(
						link,
						this.plugin.brat(link),
						this.plugin.settings.bratPaused,
						this.plugin.plugins.enabledPlugins.has(BRAT_ID),
					),
				)
				.addToggle((t) =>
					t
						.setTooltip("Use linked folder")
						.setValue(link.enabled)
						.onChange((on) => this.plugin.setEnabled(link, on).then(() => this.display(), report)),
				);
			if (link.enabled) {
				row.addExtraButton((b) =>
					b
						.setIcon("refresh-cw")
						.setTooltip("Reload")
						.onClick(() => this.plugin.reload(link.id)),
				);
			}
			row.addExtraButton((b) =>
				b
					.setIcon("trash")
					.setTooltip("Remove link")
					.onClick(() => this.plugin.remove(link).then(() => this.display(), report)),
			);
		}
	}
}
