import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTestHost } from "./support/host.ts";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies: Record<string, string>;
  pi?: { extensions?: string[] };
};

test("declares one source extension, no runtime dependencies, and exact development pins", () => {
  assert.deepEqual(packageJson.pi?.extensions, ["./index.ts"]);
  assert.equal(packageJson.dependencies, undefined);
  for (const [name, version] of Object.entries(packageJson.devDependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, name);
  }
});

test("packs only release files and loads the installed tarball through Pi", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-at-package-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    ...process.env,
    npm_config_cache: join(root, "cache"),
    npm_config_dry_run: "false",
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
  };
  const [packed] = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], {
      cwd: new URL("..", import.meta.url),
      env,
      encoding: "utf8",
    }),
  ) as [{ filename: string; files: { path: string }[] }];
  assert.deepEqual(packed.files.map((file) => file.path).sort(), [
    "README.md",
    "index.ts",
    "package.json",
    "src/format.ts",
    "src/parse.ts",
    "src/record.ts",
  ]);

  // Pi supplies the host peer; install only the extension, with no scripts or network.
  execFileSync(
    "npm",
    [
      "install", "--prefix", join(root, "install"), "--ignore-scripts", "--legacy-peer-deps", "--offline",
      "--no-audit", "--no-fund", "--package-lock=false", join(root, packed.filename),
    ],
    { cwd: root, env, encoding: "utf8" },
  );
  const packageRoot = join(root, "install", "node_modules", packageJson.name);
  const host = await createTestHost([], { extensionPaths: [packageRoot] });
  try {
    assert.deepEqual(host.extensionsResult.errors, []);
    assert.equal(host.extensionsResult.extensions.length, 1);
    const [extension] = host.extensionsResult.extensions;
    assert.equal(extension?.resolvedPath, join(packageRoot, "index.ts"));
    assert.ok(extension?.commands.has("at"));
  } finally {
    host.cleanup();
  }
});
