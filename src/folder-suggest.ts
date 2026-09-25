import { AbstractInputSuggest, App } from "obsidian";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export function expandHome(p: string): string {
	return p.replace(/^~(?=$|[\\/])/, os.homedir());
}

/** Suggests folders on disk for a typed path. Picking one descends into it. */
export class FolderSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		private input: HTMLInputElement,
	) {
		super(app, input);
	}

	protected getSuggestions(query: string): string[] {
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

	renderSuggestion(value: string, el: HTMLElement) {
		el.setText(path.basename(value));
		if (fs.existsSync(path.join(expandHome(value), "manifest.json"))) {
			el.createSpan({ text: "  plugin", cls: "mod-cta" });
		}
	}

	selectSuggestion(value: string) {
		this.setValue(value + path.sep);
		// The input event reaches the text component's onChange, and it opens the next level.
		this.input.dispatchEvent(new Event("input"));
	}
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
