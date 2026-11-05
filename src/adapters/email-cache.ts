import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

export const readProcessedEmailIds = async (path: string) => {
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    return new Set(z.array(z.string().min(1)).parse(data));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return new Set<string>();
    }
    throw error;
  }
};

export const writeProcessedEmailIds = async (
  path: string,
  ids: ReadonlySet<string>,
) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, JSON.stringify([...ids]), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};
