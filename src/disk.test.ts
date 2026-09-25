import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandHome, isPluginFolder, linkIn, linkOut, readPluginId, suggestFolders } from "./disk";

let root: string;
let source: string;
let target: string;
let stash: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "linker-disk-"));
	source = path.join(root, "source");
	target = path.join(root, "vault", "plugins", "orca");
	stash = path.join(root, "linker", "stash", "orca");
	fs.mkdirSync(source);
	fs.writeFileSync(path.join(source, "main.js"), "linked");
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function installed() {
	fs.mkdirSync(target, { recursive: true });
	fs.writeFileSync(path.join(target, "main.js"), "installed");
}

function read(dir: string): string {
	return fs.readFileSync(path.join(dir, "main.js"), "utf8");
}

describe("expandHome", () => {
	it("expands a bare tilde", () => {
		expect(expandHome("~")).toBe(os.homedir());
	});

	it("expands a leading tilde and separator", () => {
		expect(expandHome("~/git/orca")).toBe(`${os.homedir()}/git/orca`);
	});

	it("leaves ~user and other paths alone", () => {
		expect(expandHome("~other/orca")).toBe("~other/orca");
		expect(expandHome("/tmp/~/orca")).toBe("/tmp/~/orca");
	});
});

describe("readPluginId", () => {
	it("reads the id", () => {
		fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify({ id: "orca" }));
		expect(readPluginId(source)).toBe("orca");
	});

	it("fails without a manifest", () => {
		expect(() => readPluginId(source)).toThrow(`Not a plugin folder: manifest.json not found in ${source}`);
	});

	it.each([{}, { id: "" }, { id: 7 }])("fails when the id is missing or invalid: %j", (manifest) => {
		fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify(manifest));
		expect(() => readPluginId(source)).toThrow("manifest.json is missing an id.");
	});

	it.each(["..", ".", "../outside", "a/b", "a\\b"])("fails when the id is not a folder name: %s", (id) => {
		fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify({ id }));
		expect(() => readPluginId(source)).toThrow(`The id "${id}" in manifest.json is not a folder name.`);
	});

	it("fails when the manifest is not JSON", () => {
		fs.writeFileSync(path.join(source, "manifest.json"), "{");
		expect(() => readPluginId(source)).toThrow(SyntaxError);
	});
});

describe("linkIn", () => {
	it("links into an empty plugins folder", () => {
		linkIn("orca", source, target, stash);
		expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
		expect(read(target)).toBe("linked");
		expect(fs.existsSync(stash)).toBe(false);
	});

	it("moves an installed version to the stash", () => {
		installed();
		linkIn("orca", source, target, stash);
		expect(read(target)).toBe("linked");
		expect(read(stash)).toBe("installed");
	});

	it("replaces an existing symlink without touching what it points to", () => {
		const other = path.join(root, "other");
		fs.mkdirSync(other);
		fs.writeFileSync(path.join(other, "main.js"), "other");
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.symlinkSync(other, target);
		linkIn("orca", source, target, stash);
		expect(read(target)).toBe("linked");
		expect(read(other)).toBe("other");
		expect(fs.existsSync(stash)).toBe(false);
	});

	it("refuses to overwrite a stash and changes nothing", () => {
		installed();
		fs.mkdirSync(stash, { recursive: true });
		fs.writeFileSync(path.join(stash, "main.js"), "stashed");
		expect(() => linkIn("orca", source, target, stash)).toThrow(
			`Cannot turn on the link. A saved version of orca already exists in ${stash}.`,
		);
		expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
		expect(read(target)).toBe("installed");
		expect(read(stash)).toBe("stashed");
	});
});

describe("linkOut", () => {
	it("restores the stashed version", () => {
		installed();
		linkIn("orca", source, target, stash);
		linkOut(target, stash);
		expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
		expect(read(target)).toBe("installed");
		expect(fs.existsSync(stash)).toBe(false);
		expect(read(source)).toBe("linked");
	});

	it("removes the link when nothing was stashed", () => {
		linkIn("orca", source, target, stash);
		linkOut(target, stash);
		expect(fs.existsSync(target)).toBe(false);
		expect(read(source)).toBe("linked");
	});

	it("keeps a real folder and the stash both", () => {
		installed();
		fs.mkdirSync(stash, { recursive: true });
		fs.writeFileSync(path.join(stash, "main.js"), "stashed");
		linkOut(target, stash);
		expect(read(target)).toBe("installed");
		expect(read(stash)).toBe("stashed");
	});

	it("does nothing when neither exists", () => {
		linkOut(target, stash);
		expect(fs.existsSync(target)).toBe(false);
	});
});

describe("suggestFolders", () => {
	beforeEach(() => {
		for (const name of ["Alpha", "alps", "beta", ".hidden"]) fs.mkdirSync(path.join(root, name));
		fs.writeFileSync(path.join(root, "alfile"), "");
		fs.symlinkSync(path.join(root, "beta"), path.join(root, "al-link"));
		fs.symlinkSync(path.join(root, "missing"), path.join(root, "al-broken"));
	});

	it("returns nothing for an empty query", () => {
		expect(suggestFolders("")).toEqual([]);
	});

	it("lists every visible folder under a path ending in a separator", () => {
		expect(suggestFolders(`${root}/`).map((p) => path.basename(p))).toEqual(["Alpha", "al-link", "alps", "beta", "source"]);
	});

	it("matches a name prefix without regard to case, and follows folder symlinks", () => {
		expect(suggestFolders(path.join(root, "AL"))).toEqual(
			["Alpha", "al-link", "alps"].map((n) => path.join(root, n)),
		);
	});

	it("shows hidden folders when the prefix starts with a dot", () => {
		expect(suggestFolders(`${root}/.h`)).toEqual([path.join(root, ".hidden")]);
	});

	it("returns nothing for a folder it cannot read", () => {
		expect(suggestFolders(path.join(root, "missing", "x"))).toEqual([]);
	});

	it("expands a leading tilde but keeps it in the result", () => {
		const home = os.homedir();
		const name = fs.readdirSync(home, { withFileTypes: true }).find((e) => e.isDirectory() && !e.name.startsWith("."))?.name;
		if (!name) return;
		expect(suggestFolders(`~/${name}`)).toContain(path.join("~", name));
	});

	it("returns at most 50 folders", () => {
		const many = path.join(root, "many");
		for (let i = 0; i < 60; i++) fs.mkdirSync(path.join(many, `d${i}`), { recursive: true });
		expect(suggestFolders(`${many}/`)).toHaveLength(50);
	});
});

describe("isPluginFolder", () => {
	it("is true only when a manifest exists", () => {
		expect(isPluginFolder(source)).toBe(false);
		fs.writeFileSync(path.join(source, "manifest.json"), "{}");
		expect(isPluginFolder(source)).toBe(true);
	});
});
