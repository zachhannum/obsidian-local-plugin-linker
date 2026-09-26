import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function expandHome(p: string): string {
	return p.replace(/^~(?=$|[\\/])/, os.homedir());
}

/**
 * Reads the plugin id from a folder's manifest. The error message is shown to the user as is.
 * The id is one folder name, so a link never reaches outside the plugins folder.
 */
export function readPluginId(folder: string): string {
	const manifestPath = path.join(folder, "manifest.json");
	if (!fs.existsSync(manifestPath)) throw new Error(`Not a plugin folder: manifest.json not found in ${folder}`);
	const { id } = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { id?: unknown };
	if (typeof id !== "string" || id === "") throw new Error("manifest.json is missing an id.");
	if (/[\\/]/.test(id) || id === "." || id === "..") {
		throw new Error(`The id "${id}" in manifest.json is not a folder name. Change the id, then link the folder again.`);
	}
	return id;
}

/**
 * Puts a symlink to `source` at `target`. A real folder at `target` moves to `stash` and is never deleted.
 * It throws, with nothing changed, if `stash` is already taken.
 */
export function linkIn(id: string, source: string, target: string, stash: string) {
	const existing = lstatOrNull(target);
	if (existing?.isSymbolicLink()) fs.unlinkSync(target);
	else if (existing) {
		if (fs.existsSync(stash)) throw new Error(`Cannot turn on the link. A saved version of ${id} already exists in ${stash}.`);
		fs.mkdirSync(path.dirname(stash), { recursive: true });
		fs.renameSync(target, stash);
	}
	fs.mkdirSync(path.dirname(target), { recursive: true });
	// A junction needs no admin rights on Windows. Other systems ignore the type.
	fs.symlinkSync(source, target, "junction");
}

/** Removes a symlink at `target` and moves `stash` back. A real folder at `target` stays, and so does `stash`. */
export function linkOut(target: string, stash: string) {
	if (lstatOrNull(target)?.isSymbolicLink()) fs.unlinkSync(target);
	if (fs.existsSync(stash) && !fs.existsSync(target)) fs.renameSync(stash, target);
}

function lstatOrNull(p: string): fs.Stats | null {
	try {
		return fs.lstatSync(p);
	} catch {
		return null;
	}
}

/** Folders on disk that complete a typed path. Hidden folders appear only when the typed name starts with a dot. */
export function suggestFolders(query: string): string[] {
	if (query === "") return [];
	const endsInSep = /[\\/]$/.test(query);
	const dir = endsInSep ? query : path.dirname(query);
	const prefix = endsInSep ? "" : path.basename(query).toLowerCase();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(expandHome(dir), { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => isDir(expandHome(dir), e))
		.filter((e) => e.name.toLowerCase().startsWith(prefix))
		.filter((e) => prefix.startsWith(".") || !e.name.startsWith("."))
		.map((e) => path.join(dir, e.name))
		.sort()
		.slice(0, 50);
}

export function isPluginFolder(folder: string): boolean {
	return fs.existsSync(path.join(expandHome(folder), "manifest.json"));
}

function isDir(parent: string, e: fs.Dirent): boolean {
	if (e.isDirectory()) return true;
	if (!e.isSymbolicLink()) return false;
	try {
		return fs.statSync(path.join(parent, e.name)).isDirectory();
	} catch {
		return false;
	}
}
