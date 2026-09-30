/** The slice of Obsidian's vault adapter that a build install uses. Paths are relative to the vault. */
export interface Files {
	exists(path: string): Promise<boolean>;
	mkdir(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
	rmdir(path: string, recursive: boolean): Promise<void>;
	readBinary(path: string): Promise<ArrayBuffer>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
}

export interface BuildPaths {
	/** The plugin's folder in the plugins folder. */
	target: string;
	/** An installed version moves here while the build is on. */
	stash: string;
	/** The build waits here while it is off. */
	parked: string;
}

/**
 * Writes the plugin files into `dir`. A styles.css that the new build lacks is removed.
 * Other files, like the plugin's data.json, stay.
 */
export async function writeBuild(files: Files, dir: string, build: Record<string, Uint8Array>) {
	await mkdirs(files, dir);
	for (const name of ["main.js", "manifest.json", "styles.css"]) {
		const data = build[name];
		const path = `${dir}/${name}`;
		if (data) await files.writeBinary(path, toArrayBuffer(data));
		else if (await files.exists(path)) await files.remove(path);
	}
}

/**
 * Moves the parked build to `target`. A folder at `target` moves to `stash` and is never deleted,
 * and its data.json is copied into a build that has none. It throws, with nothing changed, if `stash` is already taken.
 */
export async function buildIn(files: Files, id: string, paths: BuildPaths) {
	const { target, stash, parked } = paths;
	if (!(await files.exists(parked))) throw new Error(`The build for ${id} is missing. Install it again.`);
	if (await files.exists(target)) {
		if (await files.exists(stash)) throw new Error(`Cannot turn on the build. A backup of ${id} already exists in ${stash}.`);
		await mkdirs(files, parent(stash));
		await files.rename(target, stash);
		const data = `${stash}/data.json`;
		if ((await files.exists(data)) && !(await files.exists(`${parked}/data.json`))) {
			await files.writeBinary(`${parked}/data.json`, await files.readBinary(data));
		}
	}
	await mkdirs(files, parent(target));
	await files.rename(parked, target);
}

/** Parks the build that sits at `target`, then moves `stash` back. It throws, with nothing changed, if a parked build is in the way. */
export async function buildOut(files: Files, id: string, paths: BuildPaths) {
	const { target, stash, parked } = paths;
	if (await files.exists(target)) {
		if (await files.exists(parked)) throw new Error(`Cannot turn off the build. Another build of ${id} is in ${parked}.`);
		await mkdirs(files, parent(parked));
		await files.rename(target, parked);
	}
	if ((await files.exists(stash)) && !(await files.exists(target))) await files.rename(stash, target);
}

function parent(path: string): string {
	return path.slice(0, Math.max(path.lastIndexOf("/"), 0));
}

async function mkdirs(files: Files, dir: string) {
	if (dir === "" || (await files.exists(dir))) return;
	await mkdirs(files, parent(dir));
	await files.mkdir(dir);
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	return data.slice().buffer;
}
