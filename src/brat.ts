export interface BratInstall {
	/** The GitHub repo BRAT installs from, as owner/name. */
	repo: string;
	/** BRAT writes its updates at startup, over a link or a build in the plugin's folder. */
	updatesAtStartup: boolean;
}

interface BratData {
	pluginList?: string[];
	updateAtStartup?: boolean;
}

/**
 * Finds the BRAT entry for a plugin in the text of BRAT's data.json. BRAT stores repos,
 * not plugin ids, so the match is one of `repos`, then a repo named for the id.
 */
export function findBratInstall(bratData: string | null, id: string, repos: string[]): BratInstall | null {
	let data: BratData;
	try {
		data = JSON.parse(bratData ?? "") as BratData;
	} catch {
		return null;
	}
	const list = data.pluginList ?? [];
	const wanted = repos.map((r) => r.toLowerCase());
	const repo =
		list.find((r) => wanted.includes(r.toLowerCase())) ??
		list.find((r) => {
			const name = r.split("/")[1]?.toLowerCase();
			return name === id.toLowerCase() || name === `obsidian-${id.toLowerCase()}`;
		});
	return repo ? { repo, updatesAtStartup: data.updateAtStartup ?? false } : null;
}
