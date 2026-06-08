const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const targets = [
  {
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    external: ["vscode"],
  },
  {
    entryPoints: ["src/mcp/server.ts"],
    outfile: "dist/mcp/server.js",
    external: ["vscode"],
  },
  {
    entryPoints: ["src/bench/harness.ts"],
    outfile: "dist/bench/harness.js",
    external: ["vscode"],
  },
  {
    entryPoints: ["src/test/runUnit.ts"],
    outfile: "dist/test/runUnit.js",
    external: ["vscode"],
  },
];

async function main() {
  const contexts = [];
  for (const t of targets) {
    const opts = {
      ...t,
      bundle: true,
      format: "cjs",
      platform: "node",
      target: "node18",
      sourcemap: !production,
      minify: production,
      logLevel: "info",
    };
    if (watch) {
      const ctx = await esbuild.context(opts);
      contexts.push(ctx);
    } else {
      await esbuild.build(opts);
    }
  }
  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    console.log("watching...");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
