import { readdir, readFile } from "node:fs/promises";

import { expect, test } from "vitest";

import { parseEmailsTransactions } from "../src/adapters/parser.js";

const fixturesPath = new URL("./fixtures/", import.meta.url);

const loadFixturesPaths = async () => {
  // Get .eml files inside the fixtures directory
  return (await readdir(fixturesPath)).filter((file) => file.endsWith(".eml"));
};

test.for(await loadFixturesPaths())("%s", async (fixture) => {
  const raw = await readFile(new URL(fixture, fixturesPath));
  const transactions = await parseEmailsTransactions([{ id: fixture, raw }]);

  await expect(
    `${JSON.stringify(transactions, null, 2)}\n`,
  ).toMatchFileSnapshot(`./goldens/${fixture}.json`);
});
