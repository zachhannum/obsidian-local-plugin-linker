import { beforeEach, describe, expect, it } from "vitest";
import { buildIn, BuildPaths, buildOut, Files, writeBuild } from "./install";

/** An in-memory vault. A folder exists when it was made or when a file sits under it. */
class MemoryFiles implements Files {
	files = new Map<string, string>();
	dirs = new Set<string>();

	put(path: string, text: string) {
		this.files.set(path, text);
	}

	text(path: string): string | undefined {
		return this.files.get(path);
	}

	async exists(path: string) {
		return this.files.has(path) || this.dirs.has(path) || [...this.files.keys(), ...this.dirs].some((p) => p.startsWith(`${path}/`));
	}

	async mkdir(path: string) {
		this.dirs.add(path);
	}

	async rename(from: string, to: string) {
		if (await this.exists(to)) throw new Error(`${to} exists`);
		const move = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
		this.files = new Map([...this.files].map(([p, t]) => [move(p), t]));
		this.dirs = new Set([...this.dirs].map(move));
	}

	async remove(path: string) {
		this.files.delete(path);
	}

	async rmdir(path: string) {
		for (const p of [...this.files.keys()]) if (p.startsWith(`${path}/`)) this.files.delete(p);
		for (const p of [...this.dirs]) if (p === path || p.startsWith(`${path}/`)) this.dirs.delete(p);
	}

	async readBinary(path: string) {
		return new TextEncoder().encode(this.files.get(path)).buffer;
	}

	async writeBinary(path: string, data: ArrayBuffer) {
		this.files.set(path, new TextDecoder().decode(data));
	}
}

const bytes = (text: string) => new TextEncoder().encode(text);

const paths: BuildPaths = {
	target: ".obsidian/plugins/orca",
	stash: ".obsidian/plugins/local-plugin-linker/stash/orca",
	parked: ".obsidian/plugins/local-plugin-linker/builds/orca",
};

let files: MemoryFiles;

beforeEach(() => {
	files = new MemoryFiles();
});

function installed() {
	files.put(`${paths.target}/main.js`, "installed");
	files.put(`${paths.target}/data.json`, "settings");
}

describe("writeBuild", () => {
	it("writes the plugin files and makes the folders", async () => {
		await writeBuild(files, paths.parked, { "main.js": bytes("build"), "manifest.json": bytes("{}") });
		expect(files.text(`${paths.parked}/main.js`)).toBe("build");
		expect(files.text(`${paths.parked}/manifest.json`)).toBe("{}");
		expect(files.dirs.has(".obsidian")).toBe(true);
	});

	it("removes a styles.css the build lacks and keeps data.json", async () => {
		files.put(`${paths.parked}/styles.css`, "old");
		files.put(`${paths.parked}/data.json`, "settings");
		await writeBuild(files, paths.parked, { "main.js": bytes("new"), "manifest.json": bytes("{}") });
		expect(files.text(`${paths.parked}/styles.css`)).toBeUndefined();
		expect(files.text(`${paths.parked}/data.json`)).toBe("settings");
	});

	it("writes a styles.css the build has", async () => {
		await writeBuild(files, paths.parked, { "main.js": bytes("new"), "styles.css": bytes("css") });
		expect(files.text(`${paths.parked}/styles.css`)).toBe("css");
	});
});

describe("buildIn", () => {
	it("moves the build into an empty plugins folder", async () => {
		files.put(`${paths.parked}/main.js`, "build");
		await buildIn(files, "orca", paths);
		expect(files.text(`${paths.target}/main.js`)).toBe("build");
		expect(await files.exists(paths.parked)).toBe(false);
		expect(await files.exists(paths.stash)).toBe(false);
	});

	it("moves an installed version to the stash and copies its data.json", async () => {
		installed();
		files.put(`${paths.parked}/main.js`, "build");
		await buildIn(files, "orca", paths);
		expect(files.text(`${paths.target}/main.js`)).toBe("build");
		expect(files.text(`${paths.target}/data.json`)).toBe("settings");
		expect(files.text(`${paths.stash}/main.js`)).toBe("installed");
		expect(files.text(`${paths.stash}/data.json`)).toBe("settings");
	});

	it("keeps the data.json of the build", async () => {
		installed();
		files.put(`${paths.parked}/main.js`, "build");
		files.put(`${paths.parked}/data.json`, "build settings");
		await buildIn(files, "orca", paths);
		expect(files.text(`${paths.target}/data.json`)).toBe("build settings");
	});

	it("does not need a data.json in the installed version", async () => {
		files.put(`${paths.target}/main.js`, "installed");
		files.put(`${paths.parked}/main.js`, "build");
		await buildIn(files, "orca", paths);
		expect(files.text(`${paths.target}/data.json`)).toBeUndefined();
	});

	it("refuses to overwrite a stash and changes nothing", async () => {
		installed();
		files.put(`${paths.stash}/main.js`, "stashed");
		files.put(`${paths.parked}/main.js`, "build");
		await expect(buildIn(files, "orca", paths)).rejects.toThrow(
			`Cannot turn on the build. A saved version of orca already exists in ${paths.stash}.`,
		);
		expect(files.text(`${paths.target}/main.js`)).toBe("installed");
		expect(files.text(`${paths.stash}/main.js`)).toBe("stashed");
		expect(files.text(`${paths.parked}/main.js`)).toBe("build");
	});

	it("fails without a parked build and changes nothing", async () => {
		installed();
		await expect(buildIn(files, "orca", paths)).rejects.toThrow("The build of orca is missing. Install it again.");
		expect(files.text(`${paths.target}/main.js`)).toBe("installed");
	});
});

describe("buildOut", () => {
	it("parks the build and restores the stashed version", async () => {
		installed();
		files.put(`${paths.parked}/main.js`, "build");
		await buildIn(files, "orca", paths);
		await buildOut(files, "orca", paths);
		expect(files.text(`${paths.target}/main.js`)).toBe("installed");
		expect(files.text(`${paths.parked}/main.js`)).toBe("build");
		expect(await files.exists(paths.stash)).toBe(false);
	});

	it("parks the build when nothing was stashed", async () => {
		files.put(`${paths.parked}/main.js`, "build");
		await buildIn(files, "orca", paths);
		await buildOut(files, "orca", paths);
		expect(await files.exists(paths.target)).toBe(false);
		expect(files.text(`${paths.parked}/main.js`)).toBe("build");
	});

	it("restores the stash when the build is gone", async () => {
		files.put(`${paths.stash}/main.js`, "stashed");
		await buildOut(files, "orca", paths);
		expect(files.text(`${paths.target}/main.js`)).toBe("stashed");
	});

	it("refuses to overwrite a parked build and changes nothing", async () => {
		installed();
		files.put(`${paths.parked}/main.js`, "other build");
		await expect(buildOut(files, "orca", paths)).rejects.toThrow(
			`Cannot turn off the build. Another build of orca is in ${paths.parked}.`,
		);
		expect(files.text(`${paths.target}/main.js`)).toBe("installed");
		expect(files.text(`${paths.parked}/main.js`)).toBe("other build");
	});
});
