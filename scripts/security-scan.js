import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const self = new URL(import.meta.url).pathname;
const ignoredDirs = new Set([".git", "node_modules", "coverage"]);
const suspicious = [
  /(?:ghp|gho|github_pat)_[A-Za-z0-9_]+/,
  /sk_(?:live|test)_[A-Za-z0-9]+/,
  /FLY_API_TOKEN/,
  /DATABASE_URL/,
  /RUNPOD/i,
  /TIGRIS/i,
  /STRIPE/i,
  /SOLANA/i,
  /VOYAGE/i,
  /IWF/i,
  /BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY/,
  /https?:\/\/(?:api\.)?filmprocessor\.(?:io|dev)/i,
];

async function* files(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    if (entry.isFile()) yield path;
  }
}

let failed = false;
for await (const file of files(root)) {
  if (file === self) continue;
  const text = await readFile(file, "utf8").catch(() => "");
  for (const pattern of suspicious) {
    if (pattern.test(text)) {
      console.error(`Suspicious content matched ${pattern} in ${file}`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("Security scan passed");
