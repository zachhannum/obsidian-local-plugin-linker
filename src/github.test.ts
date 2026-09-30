import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
	chooseArtifact,
	DeviceCode,
	Get,
	GitHub,
	HttpResponse,
	parseRepo,
	Post,
	readPluginZip,
	refLabel,
	refreshGrant,
	requestDeviceCode,
	waitForToken,
} from "./github";

const API = "https://api.github.com";

function respond(status: number, body: unknown): HttpResponse {
	return {
		status,
		json: () => body,
		bytes: () => (body instanceof Uint8Array ? body.slice().buffer : new ArrayBuffer(0)),
	};
}

/** Answers each route from `routes`, and records the headers of each request. */
/** A `status` entry answers its route with that status, and with a body if one is given. */
function fakeGet(routes: Record<string, unknown>, status: Record<string, number | [number, unknown]> = {}) {
	const calls: { url: string; headers: Record<string, string> }[] = [];
	const get: Get = async (url, headers) => {
		calls.push({ url, headers });
		const route = url.slice(API.length);
		const failure = status[route];
		if (failure !== undefined) return Array.isArray(failure) ? respond(failure[0], failure[1]) : respond(failure, {});
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
		expect(() => parseRepo(input)).toThrow(`"${input}" is not a valid repository. Use the format owner/name.`);
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
		[401, "GitHub rejected the token. Sign in again in Local Linker settings."],
		[403, "GitHub refused to list the branches of someone/orca. Sign in again, or use a token that can read someone/orca."],
		[429, "GitHub rate limit reached. Sign in, or try again later."],
		[404, "GitHub cannot find someone/orca or its build. Check the name. For a private repository, install the Local Linker GitHub App on it, or use a token that can read it."],
		[410, "This build has expired on GitHub. Rerun the workflow, then install again."],
		[502, "GitHub returned status 502 when it tried to list the branches. Try again later."],
	])("explains status %i", async (code, message) => {
		const { get } = fakeGet(routes, { "/repos/someone/orca/branches?per_page=100": code });
		await expect(new GitHub(get, null).refs("someone/orca")).rejects.toThrow(message);
	});

	it.each([
		[403, { message: "API rate limit exceeded for 1.2.3.4." }, "GitHub rate limit reached."],
		[403, { message: "Resource not accessible by integration" }, "of someone/orca. GitHub says: Resource not accessible by integration. Sign in"],
		[401, { message: "Bad credentials" }, "GitHub rejected the token. GitHub says: Bad credentials. Sign in again"],
		[500, { message: 7 }, "GitHub returned status 500 when it tried to list the branches. Try again later."],
	])("uses GitHub's message for status %i: %j", async (code, body, message) => {
		const { get } = fakeGet(routes, { "/repos/someone/orca/branches?per_page=100": [code, body] });
		await expect(new GitHub(get, null).refs("someone/orca")).rejects.toThrow(message);
	});

	it("ignores an error body that is not JSON", async () => {
		const get: Get = async () => ({
			status: 403,
			json: () => {
				throw new SyntaxError("not JSON");
			},
			bytes: () => new ArrayBuffer(0),
		});
		await expect(new GitHub(get, null).refs("someone/orca")).rejects.toThrow(
			"GitHub refused to list the pull requests of someone/orca. Sign in again",
		);
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
			"Sign in to GitHub in Local Linker settings to download a build.",
		);
		expect(calls).toEqual([]);
	});

	it("downloads with the zip getter when one is given", async () => {
		const api = fakeGet({});
		const zips = fakeGet({
			"/repos/someone/orca/actions/artifacts/1/zip": zip({ "manifest.json": manifest, "main.js": "code" }),
		});
		const build = await new GitHub(api.get, "secret", zips.get).download("someone/orca", { id: 1, name: "plugin" });
		expect(build.id).toBe("orca");
		expect(api.calls).toEqual([]);
		expect(zips.calls[0]?.headers.Authorization).toBe("Bearer secret");
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
			"This build has expired on GitHub.",
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
			"The artifact plugin is not a zip file. Try downloading it again.",
		);
	});

	it("fails without a manifest", () => {
		expect(() => read({ "main.js": "code" })).toThrow(
			"The artifact plugin does not contain a manifest.json. Choose the artifact that contains the plugin.",
		);
	});

	it("fails without main.js", () => {
		expect(() => read({ "manifest.json": manifest })).toThrow("The artifact plugin has no main.js next to its manifest.json.");
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

describe("GitHub.user", () => {
	it("reads the login of the token owner", async () => {
		const { get } = fakeGet({ "/user": { login: "someone" } });
		expect(await new GitHub(get, "secret").user()).toBe("someone");
	});
});

/** Answers each POST with the next body in `bodies`, and records each form. */
function fakePost(...bodies: unknown[]) {
	const forms: { url: string; form: Record<string, string> }[] = [];
	const post: Post = async (url, form) => {
		forms.push({ url, form });
		return respond(200, bodies.shift());
	};
	return { post, forms };
}

describe("requestDeviceCode", () => {
	it("starts the device flow", async () => {
		const { post, forms } = fakePost({ device_code: "dev", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 7 });
		expect(await requestDeviceCode(post, "client")).toEqual({
			deviceCode: "dev",
			userCode: "ABCD-1234",
			verificationUri: "https://github.com/login/device",
			interval: 7,
		});
		expect(forms).toEqual([{ url: "https://github.com/login/device/code", form: { client_id: "client" } }]);
	});

	it("polls every five seconds when GitHub gives no interval", async () => {
		const { post } = fakePost({ device_code: "dev", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device" });
		expect((await requestDeviceCode(post, "client")).interval).toBe(5);
	});

	it("explains a refusal", async () => {
		const { post } = fakePost({ error: "device_flow_disabled", error_description: "Device Flow must be explicitly enabled" });
		await expect(requestDeviceCode(post, "client")).rejects.toThrow(
			"GitHub did not start the sign-in: Device Flow must be explicitly enabled. Try again later.",
		);
	});

	it("explains a refusal without a description", async () => {
		const { post } = fakePost({});
		await expect(requestDeviceCode(post, "client")).rejects.toThrow("GitHub did not start the sign-in: no code. Try again later.");
	});
});

describe("waitForToken", () => {
	const code: DeviceCode = { deviceCode: "dev", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", interval: 5 };

	function recordWaits(cancelAfter = Infinity) {
		const waits: number[] = [];
		const wait = async (ms: number) => {
			waits.push(ms);
			return waits.length <= cancelAfter;
		};
		return { wait, waits };
	}

	it("polls until the person enters the code", async () => {
		const { post, forms } = fakePost({ error: "authorization_pending" }, { access_token: "token", refresh_token: "renew", expires_in: 28800 });
		const { wait, waits } = recordWaits();
		expect(await waitForToken(post, "client", code, wait, () => 1000)).toEqual({ token: "token", refreshToken: "renew", expiresAt: 28801000 });
		expect(waits).toEqual([5000, 5000]);
		expect(forms[0]).toEqual({
			url: "https://github.com/login/oauth/access_token",
			form: { client_id: "client", device_code: "dev", grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
		});
	});

	it("slows down when GitHub asks", async () => {
		const { post } = fakePost({ error: "slow_down", interval: 10 }, { error: "slow_down" }, { access_token: "token" });
		const { wait, waits } = recordWaits();
		await waitForToken(post, "client", code, wait);
		expect(waits).toEqual([5000, 10000, 15000]);
	});

	it("stops when the wait is canceled", async () => {
		const { post, forms } = fakePost({ error: "authorization_pending" });
		const { wait } = recordWaits(1);
		expect(await waitForToken(post, "client", code, wait)).toBeNull();
		expect(forms).toHaveLength(1);
	});

	it("keeps a token that does not expire", async () => {
		const { post } = fakePost({ access_token: "token" });
		expect(await waitForToken(post, "client", code, recordWaits().wait)).toEqual({ token: "token", refreshToken: "", expiresAt: 0 });
	});

	it.each([
		[{ error: "expired_token" }, "The sign-in code expired. Sign in again."],
		[{ error: "access_denied" }, "You canceled the sign-in on GitHub."],
		[{ error: "incorrect_client_credentials", error_description: "bad client" }, "GitHub sign-in failed: bad client. Try again later."],
		[{ error: "unsupported_grant_type" }, "GitHub sign-in failed: unsupported_grant_type. Try again later."],
		[{}, "GitHub sign-in failed: no token. Try again later."],
	])("explains %j", async (body, message) => {
		const { post } = fakePost(body);
		await expect(waitForToken(post, "client", code, recordWaits().wait)).rejects.toThrow(message);
	});
});

describe("refreshGrant", () => {
	it("trades the refresh token for a new grant", async () => {
		const { post, forms } = fakePost({ access_token: "new", refresh_token: "renew2", expires_in: 60 });
		expect(await refreshGrant(post, "client", "renew", () => 1000)).toEqual({ token: "new", refreshToken: "renew2", expiresAt: 61000 });
		expect(forms).toEqual([
			{ url: "https://github.com/login/oauth/access_token", form: { client_id: "client", grant_type: "refresh_token", refresh_token: "renew" } },
		]);
	});

	it.each([
		[{ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." }, "The refresh token passed is incorrect or expired."],
		[{ error: "bad_refresh_token" }, "bad_refresh_token"],
		[{}, "no token"],
	])("explains %j", async (body, reason) => {
		const { post } = fakePost(body);
		await expect(refreshGrant(post, "client", "renew")).rejects.toThrow(`GitHub did not renew the sign-in: ${reason}. Sign in again in Local Linker settings.`);
	});
});
