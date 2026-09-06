import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as actualApi from "@actual-app/api";
import { afterAll, beforeAll, expect, onTestFinished, test } from "vitest";
import { z } from "zod";

import { syncToActual } from "../../src/adapters/actual.js";
import { actualConfig } from "../../src/config.js";
import type { Transaction } from "../../src/contracts.js";

const goldensPath = new URL("../goldens/", import.meta.url);
const transferPayeesByTarget = { "ic card": ["Suica Googlepay"] };
const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);

const goldenSchema = z.array(
  z.object({
    date: z.string(),
    time: z.string(),
    amount: z.number(),
    currency: z.string(),
    sourceAccount: z.string(),
    payee: z.string(),
    dedupId: z.string(),
  }),
) satisfies z.ZodType<Transaction[]>;

const loadGoldens = async () => {
  const files = (await readdir(goldensPath)).filter((file) =>
    file.endsWith(".json"),
  );

  return Promise.all(
    files.map(async (file) => {
      const raw = await readFile(new URL(file, goldensPath), "utf8");
      return { file, transactions: goldenSchema.parse(JSON.parse(raw)) };
    }),
  );
};

const withActualSession = async <T>(run: () => Promise<T>) => {
  const config = actualConfig();

  await actualApi.init({
    dataDir: config.dataDir,
    serverURL: config.serverURL,
    password: config.password,
  });

  try {
    await actualApi.downloadBudget(
      config.syncId,
      config.e2ePassword ? { password: config.e2ePassword } : undefined,
    );

    return await run();
  } finally {
    await actualApi.shutdown();
  }
};

const createTesterAccounts = async (names: string[]) => {
  const ids: string[] = [];
  for (const name of names) {
    // eslint-disable-next-line no-await-in-loop
    ids.push(await actualApi.createAccount({ name }));
  }

  return ids;
};

const deleteTesterData = async (
  accountIds: string[],
  payeeIdsBefore: Set<string>,
) => {
  for (const id of accountIds) {
    // eslint-disable-next-line no-await-in-loop
    await actualApi.deleteAccount(id);
  }

  const leftoverPayees = (await actualApi.getPayees()).filter(
    (payee) => !payeeIdsBefore.has(payee.id),
  );

  for (const payee of leftoverPayees) {
    // eslint-disable-next-line no-await-in-loop
    await actualApi.deletePayee(payee.id);
  }
};

const readStoredTransactions = async (accountIds: string[]) => {
  const payeeNameById = new Map(
    (await actualApi.getPayees()).map(({ id, name }) => [id, name]),
  );

  const stored = [];
  for (const accountId of accountIds) {
    // eslint-disable-next-line no-await-in-loop
    const transactions = await actualApi.getTransactions(
      accountId,
      "1970-01-01",
      "2999-12-31",
    );
    stored.push(
      ...transactions.map((transaction) => ({
        date: transaction.date,
        amount: transaction.amount,
        payee: payeeNameById.get(transaction.payee ?? "")?.toLowerCase(),
        dedupId: transaction.imported_id ?? "",
        notes: transaction.notes,
      })),
    );
  }

  return stored.toSorted((a, b) => a.dedupId.localeCompare(b.dedupId));
};

const expectedStoredTransactions = (
  transactions: Transaction[],
  accountMap: Record<string, string>,
  transferMap: Record<string, string[]>,
) =>
  transactions
    .flatMap(({ date, amount, payee, dedupId, sourceAccount }) => {
      const transferTarget = Object.keys(transferMap).find((target) =>
        transferMap[target]!.some(
          (transferPayee) =>
            transferPayee.toLowerCase() === payee.toLowerCase(),
        ),
      );

      const stored = {
        date,
        amount: amount * 100,
        payee: (transferTarget ?? payee).toLowerCase(),
        dedupId,
        notes: "#mail-bean",
      };

      if (!transferTarget) return [stored];

      return [
        stored,
        {
          ...stored,
          amount: -stored.amount,
          payee: accountMap[sourceAccount]!.toLowerCase(),
          dedupId: "",
        },
      ];
    })
    .toSorted((a, b) => a.dedupId.localeCompare(b.dedupId));

beforeAll(async () => {
  const { hostname } = new URL(actualConfig().serverURL);
  if (!localHostnames.has(hostname)) {
    throw new Error(
      `Refusing to run against non-local Actual server: ${hostname}`,
    );
  }

  process.env.MAIL_BEAN_ACTUAL_DATA_DIR = await mkdtemp(
    join(tmpdir(), "mail-bean-"),
  );
});

afterAll(async () => {
  await rm(process.env.MAIL_BEAN_ACTUAL_DATA_DIR!, {
    recursive: true,
    force: true,
  });
});

test.for(await loadGoldens())("$file", async ({ transactions }) => {
  const runId = randomUUID().slice(0, 8);
  const sourceAccounts = [
    ...new Set(transactions.map(({ sourceAccount }) => sourceAccount)),
  ];
  const accountMap = Object.fromEntries(
    sourceAccounts.map((source) => [
      source,
      `mail-bean tester ${source} ${runId}`,
    ]),
  );
  const transferMap = Object.fromEntries(
    Object.entries(transferPayeesByTarget).map(([target, payees]) => [
      `mail-bean tester ${target} ${runId}`,
      payees,
    ]),
  );
  process.env.MAIL_BEAN_ACCOUNT_MAP = JSON.stringify(accountMap);
  process.env.MAIL_BEAN_ACTUAL_TRANSFER_MAP = JSON.stringify(transferMap);

  const { accountIds, payeeIdsBefore } = await withActualSession(async () => {
    const existingPayeeIds = new Set(
      (await actualApi.getPayees()).map(({ id }) => id),
    );
    const createdAccountIds = await createTesterAccounts([
      ...Object.values(accountMap),
      ...Object.keys(transferMap),
    ]);
    return {
      accountIds: createdAccountIds,
      payeeIdsBefore: existingPayeeIds,
    };
  });

  onTestFinished(() =>
    withActualSession(() => deleteTesterData(accountIds, payeeIdsBefore)),
  );

  const firstRun = await syncToActual(transactions);
  expect(firstRun).toEqual({
    sent: transactions.length,
    created: transactions.length,
    duplicates: 0,
  });

  const secondRun = await syncToActual(transactions);
  expect(secondRun).toEqual({
    sent: transactions.length,
    created: 0,
    duplicates: transactions.length,
  });

  const stored = await withActualSession(() =>
    readStoredTransactions(accountIds),
  );
  expect(stored).toEqual(
    expectedStoredTransactions(transactions, accountMap, transferMap),
  );
});
