import { readdir } from "node:fs/promises";
import path from "node:path";

const TEST_FILE_PATTERN = /\.test\.ts$/;

export async function discoverTestEntries(rootDir) {
  const entries = [];

  async function visit(directory) {
    const directoryEntries = await readdir(directory, { withFileTypes: true });

    for (const entry of directoryEntries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
        entries.push(path.relative(rootDir, absolutePath));
      }
    }
  }

  await visit(rootDir);
  return entries.sort();
}