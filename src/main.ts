import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { BratInstall, findBratInstall } from "./brat";
import { expandHome, linkIn, linkOut, readPluginId } from "./disk";
import { FolderSuggest } from "./folder-suggest";

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
		const id = readPluginId(source);
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
			if (on) linkIn(link.id, link.source, target, stash);
			else linkOut(target, stash);
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

	getSettingDefinitions(): SettingDefinitionItem[] {
		const { plugin } = this;
		const refresh = () => this.update();
		return [
			{
				name: "Link plugin folder",
				desc: "Replaces the installed version until you turn off the link.",
				render: (setting) => {
					let input = "";
					setting
						.addText((text) => {
							text.setPlaceholder("~/git/my-plugin").onChange((v) => (input = v));
							text.inputEl.addClass("local-plugin-linker-path");
							new FolderSuggest(this.app, text.inputEl);
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
				desc: "Reload a linked plugin when its files change.",
				control: { type: "toggle", key: "autoReload" },
			},
			{
				name: "Turn off BRAT while linked",
				desc: "Turn off BRAT while a link overrides a plugin it installed, so its updates cannot overwrite your folder. While BRAT is off, none of its plugins update.",
				control: { type: "toggle", key: "pauseBrat" },
			},
			{
				type: "list",
				heading: "Linked plugins",
				emptyState: "No linked plugins.",
				onDelete: (index) => {
					const link = plugin.settings.links[index];
					if (link) plugin.remove(link).then(refresh, report);
				},
				items: plugin.settings.links.map((link) => ({
					name: plugin.displayName(link.id),
					desc: describe(
						link,
						plugin.brat(link),
						plugin.settings.bratPaused,
						plugin.plugins.enabledPlugins.has(BRAT_ID),
					),
					aliases: [link.id],
					render: (setting: Setting) => {
						setting.addToggle((t) =>
							t
								.setTooltip("Use linked folder")
								.setValue(link.enabled)
								.onChange((on) => plugin.setEnabled(link, on).then(refresh, report)),
						);
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
