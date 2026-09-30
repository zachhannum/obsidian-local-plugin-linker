import { AbstractInputSuggest, App } from "obsidian";
import { GitHub, matchRepos, typedOwner } from "./github";

/** Suggests the repos the token can read and, once a slash follows an owner, that owner's public repos. */
export class RepoSuggest extends AbstractInputSuggest<string> {
	/** One request per owner. "" holds the token's repos. A failed request suggests nothing. */
	private lists = new Map<string, Promise<string[]>>();

	constructor(
		app: App,
		private input: HTMLInputElement,
		private github: () => Promise<GitHub>,
	) {
		super(app, input);
	}

	protected async getSuggestions(query: string): Promise<string[]> {
		const owner = typedOwner(query);
		const lists = await Promise.all([this.list(""), owner ? this.list(owner) : []]);
		return matchRepos(lists.flat(), query);
	}

	renderSuggestion(value: string, el: HTMLElement) {
		el.setText(value);
	}

	selectSuggestion(value: string) {
		this.setValue(value);
		// The input event reaches the text component's onChange.
		this.input.dispatchEvent(new Event("input"));
		this.close();
	}

	private list(owner: string): Promise<string[]> {
		const key = owner.toLowerCase();
		let list = this.lists.get(key);
		if (!list) {
			list = this.github()
				.then((github) => github.repos(owner || undefined))
				.catch(() => []);
			this.lists.set(key, list);
		}
		return list;
	}
}
