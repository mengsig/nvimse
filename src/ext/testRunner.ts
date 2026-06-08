// Project test-runner + test-file detection — port of plan.lua detection.
import * as fs from "fs";
import * as path from "path";
import { config } from "./runtime";

export function detectTestRunner(root: string, related: string[] = []): string | null {
  const configured = config().testLoop.runner || config().plan.testRunner;
  if (configured) return configured;
  const has = (f: string) => {
    try {
      return fs.existsSync(path.join(root, f));
    } catch {
      return false;
    }
  };
  if (has("scripts/test")) return "./scripts/test";
  if (has("Cargo.toml")) return "cargo test --quiet";
  if (has("build.zig")) return "zig build test";
  if (has("go.mod")) return "go test ./...";
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.py")) return "pytest -q";
  if (has("package.json")) return "npm test --silent";
  if (has("pom.xml")) return "mvn -q test";
  if (has("build.gradle") || has("build.gradle.kts")) return "gradle -q test";
  if (has("CMakeLists.txt")) return "ctest --output-on-failure";
  if (has("Makefile")) return "make test";
  if (related.some((r) => r.endsWith(".py"))) return "python -m unittest -q";
  return null;
}

export function detectTestFile(root: string): string | null {
  if (config().plan.testFile) return config().plan.testFile;
  const candidates = [
    "tests/headless_spec.lua",
    "tests/test.py",
    "tests/test_main.py",
    "tests/index.test.ts",
    "tests/index.test.js",
    "tests/integration_test.rs",
    "src/lib.rs",
    "tests/test.go",
    "test/test.cpp",
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(root, c))) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}
