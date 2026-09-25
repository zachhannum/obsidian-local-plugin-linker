import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			include: ["src/**/*.ts"],
			// Tests cover only code that never imports obsidian.
			exclude: ["src/**/*.test.ts", "src/main.ts", "src/folder-suggest.ts"],
			thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
		},
	},
});
