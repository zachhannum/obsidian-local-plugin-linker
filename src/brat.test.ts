import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findBratInstall } from "./brat";

let root: string;
let pluginsDir: string;
let source: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "linker-brat-"));
	pluginsDir = path.join(root, "plugins");
	source = path.join(root, "source");
	fs.mkdirSync(pluginsDir);
	fs.mkdirSync(source);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function writeBrat(data: unknown) {
	const dir = path.join(pluginsDir, "obsidian42-brat");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "data.json"), typeof data === "string" ? data : JSON.stringify(data));
}

function gitConfig(...urls: string[]): string {
	return urls.map((url, i) => `[remote "r${i}"]\n\turl = ${url}\n`).join("");
}

function writeGit(...urls: string[]) {
	fs.mkdirSync(path.join(source, ".git"));
	fs.writeFileSync(path.join(source, ".git", "config"), gitConfig(...urls));
}

describe("findBratInstall", () => {
	it("returns null without BRAT data", () => {
		expect(findBratInstall(pluginsDir, "orca", source)).toBeNull();
	});

	it("returns null when BRAT data is not JSON", () => {
		writeBrat("{");
		expect(findBratInstall(pluginsDir, "orca", source)).toBeNull();
	});

	it("returns null when no repo matches", () => {
		writeBrat({ pluginList: ["someone/other"] });
		writeGit("https://github.com/someone/else.git");
		expect(findBratInstall(pluginsDir, "orca", source)).toBeNull();
	});

	it("matches a repo named for the id", () => {
		writeBrat({ pluginList: ["someone/other", "someone/Orca"] });
		expect(findBratInstall(pluginsDir, "orca", source)).toEqual({ repo: "someone/Orca", updatesAtStartup: false });
	});

	it("matches a repo named obsidian-<id>", () => {
		writeBrat({ pluginList: ["someone/obsidian-orca"] });
		expect(findBratInstall(pluginsDir, "orca", source)?.repo).toBe("someone/obsidian-orca");
	});

	it("matches an HTTPS remote", () => {
		writeBrat({ pluginList: ["Someone/Whale-Tools"] });
		writeGit("https://github.com/someone/whale-tools.git");
		expect(findBratInstall(pluginsDir, "orca", source)?.repo).toBe("Someone/Whale-Tools");
	});

	it("matches an SSH remote without a .git suffix", () => {
		writeBrat({ pluginList: ["someone/whale-tools"] });
		writeGit("git@github.com:someone/whale-tools");
		expect(findBratInstall(pluginsDir, "orca", source)?.repo).toBe("someone/whale-tools");
	});

	it("matches any of several remotes", () => {
		writeBrat({ pluginList: ["upstream/whale-tools"] });
		writeGit("https://github.com/fork/whale-tools.git", "https://github.com/upstream/whale-tools.git");
		expect(findBratInstall(pluginsDir, "orca", source)?.repo).toBe("upstream/whale-tools");
	});

	it("prefers the remote over a repo named for the id", () => {
		writeBrat({ pluginList: ["someone/orca", "someone/whale-tools"] });
		writeGit("https://github.com/someone/whale-tools.git");
		expect(findBratInstall(pluginsDir, "orca", source)?.repo).toBe("someone/whale-tools");
	});

	it("ignores remotes outside GitHub", () => {
		writeBrat({ pluginList: ["someone/whale-tools"] });
		writeGit("https://gitlab.com/someone/whale-tools.git");
		expect(findBratInstall(pluginsDir, "orca", source)).toBeNull();
	});

	it("reads the remote of a worktree from its main checkout", () => {
		writeBrat({ pluginList: ["someone/whale-tools"] });
		const main = path.join(root, "main");
		const worktreeGit = path.join(main, ".git", "worktrees", "source");
		fs.mkdirSync(worktreeGit, { recursive: true });
		fs.writeFileSync(path.join(main, ".git", "config"), gitConfig("https://github.com/someone/whale-tools.git"));
		fs.writeFileSync(path.join(worktreeGit, "commondir"), "../..\n");
		fs.writeFileSync(path.join(source, ".git"), `gitdir: ${worktreeGit}\n`);
		expect(findBratInstall(pluginsDir, "orca", source)?.repo).toBe("someone/whale-tools");
	});

	it("reports updates at startup", () => {
		writeBrat({ pluginList: ["someone/orca"], updateAtStartup: true });
		expect(findBratInstall(pluginsDir, "orca", source)?.updatesAtStartup).toBe(true);
	});
});
