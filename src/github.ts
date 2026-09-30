import { unzipSync } from "fflate";

export interface HttpResponse {
	status: number;
	json(): unknown;
	bytes(): ArrayBuffer;
}

/** A GET request. It resolves for every status, and it follows redirects. */
export type Get = (url: string, headers: Record<string, string>) => Promise<HttpResponse>;

/** A POST of a form. It resolves for every status. */
export type Post = (url: string, form: Record<string, string>) => Promise<HttpResponse>;

/** Waits `ms`. It resolves false if the person cancels the wait. */
export type Wait = (ms: number) => Promise<boolean>;

/** A code that the person types on GitHub to sign in. */
export interface DeviceCode {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	/** Seconds between polls. */
	interval: number;
}

/** An open pull request or a branch, at its newest commit. */
export interface Ref {
	/** A pull request has a number. A branch has none. */
	pr?: number;
	/** The branch name. For a pull request, its head branch. */
	branch: string;
	/** The pull request title, or the branch name. */
	title: string;
	sha: string;
	/** A recent successful workflow run exists for `sha`. Older runs can exist when this is false. */
	built: boolean;
}

export interface Artifact {
	id: number;
	name: string;
}

export interface PluginBuild {
	id: string;
	name: string;
	/** The file names are main.js, manifest.json and, if the build has one, styles.css. */
	files: Record<string, Uint8Array>;
}

/** The plugin files a build can hold. main.js and manifest.json are required. */
export const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];

const API = "https://api.github.com";

/** Reads owner/name from a repo name or a GitHub URL. */
export function parseRepo(input: string): string {
	const path = input.trim().replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "");
	const match = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(path);
	if (!match) throw new Error(`"${input}" is not a GitHub repository. Type it as owner/name.`);
	return `${match[1]}/${match[2]}`;
}

export function refLabel(ref: Pick<Ref, "pr" | "branch" | "title">): string {
	return ref.pr === undefined ? ref.branch : `#${ref.pr} ${ref.title}`;
}

export class GitHub {
	/**
	 * `getZip` downloads an artifact. GitHub redirects it to storage that refuses a request that still
	 * carries the GitHub token, so `getZip` must drop the Authorization header on a redirect to another host.
	 */
	constructor(
		private get: Get,
		private token: string | null,
		private getZip: Get = get,
	) {}

	/** Open pull requests, newest update first, then branches. */
	async refs(repo: string): Promise<Ref[]> {
		const [pulls, branches, runs] = await Promise.all([
			this.api(`/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100`, repo),
			this.api(`/repos/${repo}/branches?per_page=100`, repo),
			this.api(`/repos/${repo}/actions/runs?status=success&per_page=100`, repo),
		]);
		const built = new Set(((runs as RunList).workflow_runs ?? []).map((r) => r.head_sha));
		return [
			...(pulls as Pull[]).map((p) => pullRef(p, built)),
			...(branches as Branch[]).map((b) => branchRef(b, built)),
		];
	}

	/** The newest commit of a pull request or branch that `ref` names. */
	async refresh(repo: string, ref: Pick<Ref, "pr" | "branch">): Promise<Ref> {
		if (ref.pr !== undefined) return pullRef((await this.api(`/repos/${repo}/pulls/${ref.pr}`, repo)) as Pull, new Set());
		return branchRef((await this.api(`/repos/${repo}/branches/${encodeURIComponent(ref.branch)}`, repo)) as Branch, new Set());
	}

	/** The artifacts of the successful runs for a commit that have not expired. For a repeated name, the newest wins. */
	async artifacts(repo: string, sha: string): Promise<Artifact[]> {
		const runs = (await this.api(`/repos/${repo}/actions/runs?head_sha=${sha}&status=success&per_page=20`, repo)) as RunList;
		const byName = new Map<string, Artifact & { created: string }>();
		for (const run of runs.workflow_runs ?? []) {
			const list = (await this.api(`/repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`, repo)) as ArtifactList;
			for (const a of list.artifacts ?? []) {
				if (a.expired) continue;
				const old = byName.get(a.name);
				if (!old || a.created_at > old.created) byName.set(a.name, { id: a.id, name: a.name, created: a.created_at });
			}
		}
		return [...byName.values()].map(({ id, name }) => ({ id, name }));
	}

	/** The login of the token's owner. */
	async user(): Promise<string> {
		const user = (await this.api("/user", "your account")) as { login: string };
		return user.login;
	}

	/** GitHub requires a token to download an artifact, even from a public repo. */
	async download(repo: string, artifact: Artifact): Promise<PluginBuild> {
		if (!this.token) throw new Error("Sign in to GitHub in Local Linker settings to download a build.");
		const response = await this.getZip(`${API}/repos/${repo}/actions/artifacts/${artifact.id}/zip`, this.headers());
		check(response, repo);
		return readPluginZip(response.bytes(), artifact.name);
	}

	private async api(route: string, repo: string): Promise<unknown> {
		const response = await this.get(API + route, this.headers());
		check(response, repo);
		return response.json();
	}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		};
		if (this.token) headers.Authorization = `Bearer ${this.token}`;
		return headers;
	}
}

/** Picks the artifact to install without asking: the one remembered for the repo, else the only one. */
export function chooseArtifact(artifacts: Artifact[], remembered: string | undefined): Artifact | null {
	return artifacts.find((a) => a.name === remembered) ?? (artifacts.length === 1 ? (artifacts[0] ?? null) : null);
}

/** Finds the plugin in an artifact zip. The shallowest manifest.json marks the plugin folder, at any depth. */
export function readPluginZip(zip: ArrayBuffer, artifactName: string): PluginBuild {
	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(new Uint8Array(zip));
	} catch {
		throw new Error(`The artifact ${artifactName} is not a zip file. Try the download again.`);
	}
	const manifestPath = Object.keys(entries)
		.filter((p) => p === "manifest.json" || p.endsWith("/manifest.json"))
		.sort((a, b) => a.split("/").length - b.split("/").length)[0];
	if (manifestPath === undefined) {
		throw new Error(`The artifact ${artifactName} has no manifest.json. Choose the artifact that holds the plugin build.`);
	}
	const dir = manifestPath.slice(0, -"manifest.json".length);
	const files: Record<string, Uint8Array> = {};
	for (const name of PLUGIN_FILES) {
		const data = entries[dir + name];
		if (data) files[name] = data;
	}
	if (!files["main.js"]) throw new Error(`The artifact ${artifactName} has no main.js beside its manifest.json.`);
	let manifest: { id?: unknown; name?: unknown };
	try {
		manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"])) as typeof manifest;
	} catch {
		throw new Error(`The manifest.json in the artifact ${artifactName} is not valid JSON.`);
	}
	const { id } = manifest;
	if (typeof id !== "string" || id === "" || /[\\/]/.test(id) || id === "." || id === "..") {
		throw new Error(`The manifest.json in the artifact ${artifactName} has no valid id.`);
	}
	return { id, name: typeof manifest.name === "string" ? manifest.name : id, files };
}

/** Starts GitHub's device flow. An empty scope reads public repositories only. */
export async function requestDeviceCode(post: Post, clientId: string, scope: string): Promise<DeviceCode> {
	const body = (await post("https://github.com/login/device/code", { client_id: clientId, scope })).json() as {
		device_code?: string;
		user_code?: string;
		verification_uri?: string;
		interval?: number;
		error_description?: string;
	};
	if (!body.device_code || !body.user_code || !body.verification_uri) {
		throw new Error(`GitHub did not start the sign-in: ${body.error_description ?? "no code"}. Try again later.`);
	}
	return {
		deviceCode: body.device_code,
		userCode: body.user_code,
		verificationUri: body.verification_uri,
		interval: body.interval ?? 5,
	};
}

/** Polls until the person enters the code on GitHub. It resolves null if the wait is canceled. */
export async function waitForToken(post: Post, clientId: string, code: DeviceCode, wait: Wait): Promise<string | null> {
	let interval = code.interval;
	for (;;) {
		if (!(await wait(interval * 1000))) return null;
		const body = (
			await post("https://github.com/login/oauth/access_token", {
				client_id: clientId,
				device_code: code.deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			})
		).json() as { access_token?: string; error?: string; error_description?: string; interval?: number };
		if (body.access_token) return body.access_token;
		if (body.error === "authorization_pending") continue;
		if (body.error === "slow_down") {
			interval = body.interval ?? interval + 5;
			continue;
		}
		if (body.error === "expired_token") throw new Error("The sign-in code expired. Select Sign in again.");
		if (body.error === "access_denied") throw new Error("You canceled the sign-in on GitHub.");
		throw new Error(`GitHub sign-in failed: ${body.error_description ?? body.error ?? "no token"}. Try again later.`);
	}
}

function check(response: HttpResponse, repo: string) {
	const { status } = response;
	if (status < 400) return;
	if (status === 401) throw new Error("GitHub did not accept the sign-in. Sign in again in Local Linker settings.");
	if (status === 403 || status === 429) {
		throw new Error("GitHub refused the request, probably because of its rate limit. Sign in to GitHub, or try again later.");
	}
	if (status === 404) throw new Error(`GitHub cannot find ${repo} or its build. Check the name. For a private repository, sign in with private repositories turned on.`);
	if (status === 410) throw new Error("The build expired on GitHub. Run the workflow again, then install again.");
	throw new Error(`GitHub returned status ${status}. Try again later.`);
}

interface Pull {
	number: number;
	title: string;
	head: { ref: string; sha: string };
}

interface Branch {
	name: string;
	commit: { sha: string };
}

interface RunList {
	workflow_runs?: { id: number; head_sha: string }[];
}

interface ArtifactList {
	artifacts?: { id: number; name: string; expired: boolean; created_at: string }[];
}

function pullRef(p: Pull, built: Set<string>): Ref {
	return { pr: p.number, branch: p.head.ref, title: p.title, sha: p.head.sha, built: built.has(p.head.sha) };
}

function branchRef(b: Branch, built: Set<string>): Ref {
	return { branch: b.name, title: b.name, sha: b.commit.sha, built: built.has(b.commit.sha) };
}
