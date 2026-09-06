import { mkdir } from "node:fs/promises";

import * as actualApi from "@actual-app/api";

import { actualConfig } from "../config.js";
import type { Sink, Transaction } from "../contracts.js";

const writeTransactionsByAccount = async (
  transactions: Transaction[],
  accountMap: Record<string, string>,
  categoryMap: Record<string, string>,
  transferMap: Record<string, string>,
) => {
  const actualAccounts = await actualApi.getAccounts();
  const accountIdByName = new Map(
    actualAccounts.map(({ name, id }) => [name, id]),
  );

  const actualCategories = await actualApi.getCategories();
  const categoryIdByName = new Map(
    actualCategories.map(({ name, id }) => [name, id]),
  );

  const categoryIdByPayee = new Map(
    Object.entries(categoryMap).map(([payee, categoryName]) => {
      const categoryId = categoryIdByName.get(categoryName);
      if (!categoryId) {
        throw new Error(`No category named "${categoryName}" in Actual`);
      }

      return [payee, categoryId];
    }),
  );

  const transferPayeeIdByAccountId = new Map(
    (await actualApi.getPayees())
      .filter((payee) => payee.transfer_acct)
      .map((payee) => [payee.transfer_acct, payee.id]),
  );

  const transferPayeeIdByPayee = new Map(
    Object.entries(transferMap).map(([payee, accountName]) => {
      const accountId = accountIdByName.get(accountName);
      const transferPayeeId =
        accountId && transferPayeeIdByAccountId.get(accountId);
      if (!transferPayeeId) {
        throw new Error(`No account named "${accountName}" in Actual`);
      }

      return [payee, transferPayeeId];
    }),
  );

  let created = 0;

  for (const [sourceAccount, accountTransactions] of Map.groupBy(
    transactions,
    (transaction) => transaction.sourceAccount,
  )) {
    const accountName = accountMap[sourceAccount];
    if (!accountName) {
      throw new Error(`No MAIL_BEAN_ACCOUNT_MAP entry for "${sourceAccount}"`);
    }

    const accountId = accountIdByName.get(accountName);
    if (!accountId) {
      throw new Error(`No account named "${accountName}" in Actual`);
    }

    // Intentional: using Promise.all here would nuke the database
    // eslint-disable-next-line no-await-in-loop
    const result = await actualApi.importTransactions(
      accountId,
      accountTransactions.map((transaction) => {
        const normalizedPayee = transaction.payee.trim().toLowerCase();
        const transferPayeeId = transferPayeeIdByPayee.get(normalizedPayee);
        const category = categoryIdByPayee.get(normalizedPayee);

        return {
          account: accountId,
          amount: transaction.amount * 100,
          imported_id: transaction.dedupId,
          date: transaction.date,
          notes: "#mail-bean",
          cleared: true,
          ...(transferPayeeId
            ? { payee: transferPayeeId, imported_payee: transaction.payee }
            : {
                payee_name: transaction.payee,
                ...(category && { category }),
              }),
        };
      }),
    );

    if (result.errors.length > 0) {
      const errorMessages = result.errors
        .map((error) => error.message)
        .join("; ");

      throw new Error(`Import failed for ${accountName}: ${errorMessages}`);
    }

    created += result.added.length;
  }

  return {
    sent: transactions.length,
    created,
    duplicates: transactions.length - created,
  };
};

export const syncToActual: Sink = async (transactions) => {
  const config = actualConfig();

  await mkdir(config.dataDir, { recursive: true });

  try {
    await actualApi.init({
      dataDir: config.dataDir,
      serverURL: config.serverURL,
      password: config.password,
    });

    await actualApi.downloadBudget(
      config.syncId,
      config.e2ePassword ? { password: config.e2ePassword } : undefined,
    );

    return await writeTransactionsByAccount(
      transactions,
      config.accountMap,
      config.categoryMap,
      config.transferMap,
    );
  } finally {
    await actualApi.shutdown();
  }
};
