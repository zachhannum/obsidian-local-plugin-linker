import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { chooseArtifact, Get, GitHub, HttpResponse, parseRepo, readPluginZip, refLabel } from "./github";

const API = "https://api.github.com";

function respond(status: number, body: unknown): HttpResponse {
	return {
		status,
		json: () => body,
		bytes: () => (body instanceof Uint8Array ? body.slice().buffer : new ArrayBuffer(0)),
	};
}

/** Answers each route from `routes`, and records the headers of each request. */
function fakeGet(routes: Record<string, unknown>, status: Record<string, number> = {}) {
	const calls: { url: string; headers: Record<string, string> }[] = [];
	const get: Get = async (url, headers) => {
		calls.push({ url, headers });
		const route = url.slice(API.length);
		if (route in status) return respond(status[route] ?? 500, {});
		if (!(route in routes)) return respond(404, {});
		return respond(200, routes[route]);
	};
	return { get, calls };
}

function zip(files: Record<string, string>): Uint8Array {
	return zipSync(Object.fromEntries(Object.entries(files).map(([p, t]) => [p, strToU8(t)])));
}

const manifest = JSON.stringify({ id: "orca", name: "Orca" });

describe("parseRepo", () => {
	it.each([
		["someone/orca", "someone/orca"],
		["  someone/orca  ", "someone/orca"],
		["https://github.com/someone/orca", "someone/orca"],
		["https://github.com/someone/orca.git", "someone/orca"],
		["github.com/someone/orca/pull/12", "someone/orca"],
		["https://www.github.com/some-one/orca.js/", "some-one/orca.js"],
	])("reads %s", (input, repo) => {
		expect(parseRepo(input)).toBe(repo);
	});

	it.each(["orca", "", "https://github.com/someone", "some one/orca"])("rejects %j", (input) => {
		expect(() => parseRepo(input)).toThrow(`"${input}" is not a GitHub repository. Type it as owner/name.`);
	});
});

describe("refLabel", () => {
	it("names a pull request by number and title, and a branch by name", () => {
		expect(refLabel({ pr: 12, branch: "fix", title: "Fix the thing" })).toBe("#12 Fix the thing");
		expect(refLabel({ branch: "main", title: "main" })).toBe("main");
	});
});

describe("GitHub.refs", () => {
	const routes = {
		"/repos/someone/orca/pulls?state=open&sort=updated&direction=desc&per_page=100": [
			{ number: 12, title: "Fix the thing", head: { ref: "fix", sha: "aaa" } },
		],
		"/repos/someone/orca/branches?per_page=100": [
			{ name: "main", commit: { sha: "bbb" } },
			{ name: "fix", commit: { sha: "aaa" } },
		],
		"/repos/someone/orca/actions/runs?status=success&per_page=100": { workflow_runs: [{ id: 1, head_sha: "aaa" }] },
	};

	it("lists pull requests, then branches, and marks the built ones", async () => {
		const { get } = fakeGet(routes);
		expect(await new GitHub(get, null).refs("someone/orca")).toEqual([
			{ pr: 12, branch: "fix", title: "Fix the thing", sha: "aaa", built: true },
			{ branch: "main", title: "main", sha: "bbb", built: false },
			{ branch: "fix", title: "fix", sha: "aaa", built: true },
		]);
	});

	it("sends the token only when there is one", async () => {
		const anonymous = fakeGet(routes);
		await new GitHub(anonymous.get, null).refs("someone/orca");
		expect(anonymous.calls[0]?.headers.Authorization).toBeUndefined();
		const signed = fakeGet(routes);
		await new GitHub(signed.get, "secret").refs("someone/orca");
		expect(signed.calls.every((c) => c.headers.Authorization === "Bearer secret")).toBe(true);
	});

	it("treats a missing run list as no builds", async () => {
		const { get } = fakeGet({ ...routes, "/repos/someone/orca/actions/runs?status=success&per_page=100": {} });
		expect((await new GitHub(get, null).refs("someone/orca")).some((r) => r.built)).toBe(false);
	});

	it.each([
		[401, "GitHub did not accept the token. Replace the token in Local Linker settings."],
		[403, "GitHub refused the request, probably because of its rate limit. Add a token, or try again later."],
		[429, "GitHub refused the request, probably because of its rate limit. Add a token, or try again later."],
		[404, "GitHub cannot find someone/orca or its build. Check the name, or add a token that can read the repository."],
		[410, "The build expired on GitHub. Run the workflow again, then install again."],
		[502, "GitHub returned status 502. Try again later."],
	])("explains status %i", async (code, message) => {
		const { get } = fakeGet(routes, { "/repos/someone/orca/branches?per_page=100": code });
		await expect(new GitHub(get, null).refs("someone/orca")).rejects.toThrow(message);
	});
});

describe("GitHub.refresh", () => {
	it("reads the newest commit of a pull request", async () => {
		const { get } = fakeGet({
			"/repos/someone/orca/pulls/12": { number: 12, title: "Fix it", head: { ref: "fix", sha: "ccc" } },
		});
		expect(await new GitHub(get, null).refresh("someone/orca", { pr: 12, branch: "fix" })).toEqual({
			pr: 12,
			branch: "fix",
			title: "Fix it",
			sha: "ccc",
			built: false,
		});
	});

	it("reads the newest commit of a branch, with its name escaped", async () => {
		const { get } = fakeGet({ "/repos/someone/orca/branches/feat%2Fwhale": { name: "feat/whale", commit: { sha: "ddd" } } });
		expect((await new GitHub(get, null).refresh("someone/orca", { branch: "feat/whale" })).sha).toBe("ddd");
	});
});

describe("GitHub.artifacts", () => {
	it("collects the artifacts of every successful run, skips expired ones, and keeps the newest of a name", async () => {
		const { get } = fakeGet({
			"/repos/someone/orca/actions/runs?head_sha=aaa&status=success&per_page=20": { workflow_runs: [{ id: 1 }, { id: 2 }] },
			"/repos/someone/orca/actions/runs/1/artifacts?per_page=100": {
				artifacts: [
					{ id: 10, name: "plugin", expired: false, created_at: "2026-09-01T00:00:00Z" },
					{ id: 11, name: "coverage", expired: true, created_at: "2026-09-01T00:00:00Z" },
				],
			},
			"/repos/someone/orca/actions/runs/2/artifacts?per_page=100": {
				artifacts: [
					{ id: 20, name: "plugin", expired: false, created_at: "2026-09-02T00:00:00Z" },
					{ id: 21, name: "docs", expired: false, created_at: "2026-09-02T00:00:00Z" },
				],
			},
		});
		expect(await new GitHub(get, null).artifacts("someone/orca", "aaa")).toEqual([
			{ id: 20, name: "plugin" },
			{ id: 21, name: "docs" },
		]);
	});

	it("keeps an older artifact of a name when the newer one comes first", async () => {
		const { get } = fakeGet({
			"/repos/someone/orca/actions/runs?head_sha=aaa&status=success&per_page=20": { workflow_runs: [{ id: 1 }] },
			"/repos/someone/orca/actions/runs/1/artifacts?per_page=100": {
				artifacts: [
					{ id: 20, name: "plugin", expired: false, created_at: "2026-09-02T00:00:00Z" },
					{ id: 10, name: "plugin", expired: false, created_at: "2026-09-01T00:00:00Z" },
				],
			},
		});
		expect(await new GitHub(get, null).artifacts("someone/orca", "aaa")).toEqual([{ id: 20, name: "plugin" }]);
	});

	it("returns nothing when no run succeeded", async () => {
		const { get } = fakeGet({
			"/repos/someone/orca/actions/runs?head_sha=aaa&status=success&per_page=20": {},
		});
		expect(await new GitHub(get, null).artifacts("someone/orca", "aaa")).toEqual([]);
	});

	it("treats a run without an artifact list as empty", async () => {
		const { get } = fakeGet({
			"/repos/someone/orca/actions/runs?head_sha=aaa&status=success&per_page=20": { workflow_runs: [{ id: 1 }] },
			"/repos/someone/orca/actions/runs/1/artifacts?per_page=100": {},
		});
		expect(await new GitHub(get, null).artifacts("someone/orca", "aaa")).toEqual([]);
	});
});

describe("GitHub.download", () => {
	it("needs a token", async () => {
		const { get, calls } = fakeGet({});
		await expect(new GitHub(get, null).download("someone/orca", { id: 1, name: "plugin" })).rejects.toThrow(
			"A GitHub token is required to download a build. Add one in Local Linker settings.",
		);
		expect(calls).toEqual([]);
	});

	it("downloads and reads the plugin", async () => {
		const { get } = fakeGet({
			"/repos/someone/orca/actions/artifacts/1/zip": zip({ "manifest.json": manifest, "main.js": "code" }),
		});
		const build = await new GitHub(get, "secret").download("someone/orca", { id: 1, name: "plugin" });
		expect(build.id).toBe("orca");
	});

	it("reports a failed download", async () => {
		const { get } = fakeGet({}, { "/repos/someone/orca/actions/artifacts/1/zip": 410 });
		await expect(new GitHub(get, "secret").download("someone/orca", { id: 1, name: "plugin" })).rejects.toThrow(
			"The build expired on GitHub.",
		);
	});
});

describe("chooseArtifact", () => {
	const plugin = { id: 1, name: "plugin" };
	const docs = { id: 2, name: "docs" };

	it("takes the remembered name", () => {
		expect(chooseArtifact([docs, plugin], "plugin")).toBe(plugin);
	});

	it("takes the only artifact", () => {
		expect(chooseArtifact([docs], "plugin")).toBe(docs);
		expect(chooseArtifact([docs], undefined)).toBe(docs);
	});

	it("asks when several artifacts exist and none is remembered", () => {
		expect(chooseArtifact([docs, plugin], undefined)).toBeNull();
		expect(chooseArtifact([docs, plugin], "other")).toBeNull();
	});

	it("returns null with no artifacts", () => {
		expect(chooseArtifact([], "plugin")).toBeNull();
	});
});

describe("readPluginZip", () => {
	const read = (files: Record<string, string>) => readPluginZip(zip(files).slice().buffer, "plugin");
	const text = (data: Uint8Array | undefined) => new TextDecoder().decode(data);

	it("reads the plugin files at the top of the zip", () => {
		const build = read({ "manifest.json": manifest, "main.js": "code", "styles.css": "css", "README.md": "readme" });
		expect(build.id).toBe("orca");
		expect(build.name).toBe("Orca");
		expect(Object.keys(build.files).sort()).toEqual(["main.js", "manifest.json", "styles.css"]);
		expect(text(build.files["main.js"])).toBe("code");
	});

	it("uses the shallowest manifest.json and the files beside it", () => {
		const build = read({
			"dist/manifest.json": manifest,
			"dist/main.js": "code",
			"dist/node_modules/x/manifest.json": "{}",
			"main.js": "wrong",
		});
		expect(text(build.files["main.js"])).toBe("code");
		expect(build.files["styles.css"]).toBeUndefined();
	});

	it("names the plugin by its id when the manifest has no name", () => {
		expect(read({ "manifest.json": JSON.stringify({ id: "orca" }), "main.js": "" }).name).toBe("orca");
	});

	it("fails on a file that is not a zip", () => {
		expect(() => readPluginZip(strToU8("nope").slice().buffer, "plugin")).toThrow(
			"The artifact plugin is not a zip file. Try the download again.",
		);
	});

	it("fails without a manifest", () => {
		expect(() => read({ "main.js": "code" })).toThrow(
			"The artifact plugin has no manifest.json. Choose the artifact that holds the plugin build.",
		);
	});

	it("fails without main.js", () => {
		expect(() => read({ "manifest.json": manifest })).toThrow("The artifact plugin has no main.js beside its manifest.json.");
	});

	it("fails when the manifest is not JSON", () => {
		expect(() => read({ "manifest.json": "{", "main.js": "" })).toThrow("The manifest.json in the artifact plugin is not valid JSON.");
	});

	it.each([{}, { id: "" }, { id: 7 }, { id: ".." }, { id: "a/b" }])("fails when the id is not a folder name: %j", (m) => {
		expect(() => read({ "manifest.json": JSON.stringify(m), "main.js": "" })).toThrow(
			"The manifest.json in the artifact plugin has no valid id.",
		);
	});
});
