import { describe, expect, it } from "vitest";
import { findBratInstall } from "./brat";

const brat = (data: unknown) => JSON.stringify(data);

describe("findBratInstall", () => {
	it("returns null without BRAT data", () => {
		expect(findBratInstall(null, "orca", [])).toBeNull();
	});

	it("returns null when BRAT data is not JSON", () => {
		expect(findBratInstall("{", "orca", [])).toBeNull();
	});

	it("returns null when no repo matches", () => {
		expect(findBratInstall(brat({ pluginList: ["someone/other"] }), "orca", ["someone/else"])).toBeNull();
	});

	it("returns null when BRAT has no plugin list", () => {
		expect(findBratInstall(brat({}), "orca", [])).toBeNull();
	});

	it("matches a repo named for the id", () => {
		expect(findBratInstall(brat({ pluginList: ["someone/other", "someone/Orca"] }), "orca", [])).toEqual({
			repo: "someone/Orca",
			updatesAtStartup: false,
		});
	});

	it("matches a repo named obsidian-<id>", () => {
		expect(findBratInstall(brat({ pluginList: ["someone/obsidian-orca"] }), "orca", [])?.repo).toBe("someone/obsidian-orca");
	});

	it("matches a given repo without regard to case", () => {
		expect(findBratInstall(brat({ pluginList: ["Someone/Whale-Tools"] }), "orca", ["someone/whale-tools"])?.repo).toBe(
			"Someone/Whale-Tools",
		);
	});

	it("prefers a given repo over a repo named for the id", () => {
		const data = brat({ pluginList: ["someone/orca", "someone/whale-tools"] });
		expect(findBratInstall(data, "orca", ["Someone/Whale-Tools"])?.repo).toBe("someone/whale-tools");
	});

	it("reports updates at startup", () => {
		expect(findBratInstall(brat({ pluginList: ["someone/orca"], updateAtStartup: true }), "orca", [])?.updatesAtStartup).toBe(true);
	});
});
