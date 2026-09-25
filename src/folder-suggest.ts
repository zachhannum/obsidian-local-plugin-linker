import { AbstractInputSuggest, App } from "obsidian";
import * as path from "path";
import { isPluginFolder, suggestFolders } from "./disk";

/** Suggests folders on disk for a typed path. Picking one descends into it. */
export class FolderSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		private input: HTMLInputElement,
	) {
		super(app, input);
	}

	protected getSuggestions(query: string): string[] {
		return suggestFolders(query);
	}

	renderSuggestion(value: string, el: HTMLElement) {
		el.setText(path.basename(value));
		if (isPluginFolder(value)) {
			el.createSpan({ text: "  plugin", cls: "mod-cta" });
		}
	}

	selectSuggestion(value: string) {
		this.setValue(value + path.sep);
		// The input event reaches the text component's onChange, and it opens the next level.
		this.input.dispatchEvent(new Event("input"));
	}
}
