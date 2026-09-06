import { readFile, writeFile } from "node:fs/promises";

import { z } from "zod";

const runSchema = z.object({
  at: z.string(),
  fetched: z.number(),
  created: z.number(),
  duplicates: z.number(),
});

type Run = z.infer<typeof runSchema>;

const MAX_RUNS = 30;

const readRuns = async (path: string): Promise<Run[]> => {
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    return z.array(runSchema).parse(data);
  } catch {
    return [];
  }
};

export const appendRun = async (path: string, run: Omit<Run, "at">) => {
  const runs = [
    { at: new Date().toISOString(), ...run },
    ...(await readRuns(path)),
  ];
  await writeFile(path, JSON.stringify(runs.slice(0, MAX_RUNS), null, 2));
};
