import * as fs from "fs";
import * as path from "path";

export interface BratInstall {
	/** The GitHub repo BRAT installs from, as owner/name. */
	repo: string;
	/** BRAT writes its updates through an active link, into the linked folder. */
	updatesAtStartup: boolean;
}

interface BratData {
	pluginList?: string[];
	updateAtStartup?: boolean;
}

/**
 * Finds the BRAT entry for a plugin. BRAT stores repos, not plugin ids, so the
 * match is the linked folder's GitHub remote, then a repo named for the id.
 */
export function findBratInstall(pluginsDir: string, id: string, source: string): BratInstall | null {
	let data: BratData;
	try {
		data = JSON.parse(fs.readFileSync(path.join(pluginsDir, "obsidian42-brat", "data.json"), "utf8")) as BratData;
	} catch {
		return null;
	}
	const repos = data.pluginList ?? [];
	const remotes = githubRemotes(source);
	const repo =
		repos.find((r) => remotes.includes(r.toLowerCase())) ??
		repos.find((r) => {
			const name = r.split("/")[1]?.toLowerCase();
			return name === id.toLowerCase() || name === `obsidian-${id.toLowerCase()}`;
		});
	return repo ? { repo, updatesAtStartup: data.updateAtStartup ?? false } : null;
}

/** The owner/name of every GitHub remote of a git checkout, lower case. A worktree reads its main checkout's config. */
function githubRemotes(source: string): string[] {
	let gitDir = path.join(source, ".git");
	try {
		if (fs.statSync(gitDir).isFile()) {
			const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, "utf8"))?.[1]?.trim();
			if (!pointer) return [];
			gitDir = path.resolve(source, pointer);
			const common = path.join(gitDir, "commondir");
			if (fs.existsSync(common)) gitDir = path.resolve(gitDir, fs.readFileSync(common, "utf8").trim());
		}
		const config = fs.readFileSync(path.join(gitDir, "config"), "utf8");
		return [...config.matchAll(/url\s*=\s*\S*github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/gm)].map((m) =>
			(m[1] ?? "").toLowerCase(),
		);
	} catch {
		return [];
	}
}
