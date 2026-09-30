import * as fs from "fs";
import * as path from "path";
import { expandHome } from "./disk";

export { collapseHome, githubRemotes, linkIn, linkOut, readPluginId } from "./disk";
export { FolderSuggest } from "./folder-suggest";

/** The absolute path of a typed folder, with a leading tilde expanded. */
export function resolveFolder(input: string): string {
	return path.resolve(expandHome(input.trim()));
}

export function inVault(vaultBase: string, vaultPath: string): string {
	return path.join(vaultBase, vaultPath);
}

/** Calls `onChange` with the name of each file that changes in `folder`. */
export function watchFolder(folder: string, onChange: (file: string) => void): { close(): void } {
	return fs.watch(folder, (_event, file) => {
		if (file) onChange(file.toString());
	});
}
