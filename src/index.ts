import { syncToActual } from "./adapters/actual.js";
import {
  readProcessedEmailIds,
  writeProcessedEmailIds,
} from "./adapters/email-cache.js";
import { fetchGmailMessages } from "./adapters/gmail.js";
import { parseEmailsTransactions } from "./adapters/parser.js";
import { appendRun } from "./adapters/run-log.js";
import { emailCachePath, gmailConfig, runLogPath } from "./config.js";

const run = async () => {
  const cachePath = emailCachePath();
  const processedEmailIds = await readProcessedEmailIds(cachePath);
  const emails = await fetchGmailMessages(gmailConfig(), processedEmailIds);

  if (emails.length === 0) {
    console.log("No new emails to parse");
    return { fetched: 0, created: 0, duplicates: 0 };
  }

  console.log(`Fetched ${emails.length} emails`);

  const parsed = await parseEmailsTransactions(emails);
  const transactions = parsed.filter((transaction) => transaction !== null);

  if (transactions.length === 0) {
    console.log(`No transactions found in ${parsed.length} emails`);
    return { fetched: emails.length, created: 0, duplicates: 0 };
  }

  console.log(
    `Parsed ${transactions.length} transactions, skipped ${parsed.length - transactions.length} emails`,
  );

  const result = await syncToActual(transactions);

  for (const [index, email] of emails.entries()) {
    if (parsed[index]) processedEmailIds.add(email.id);
  }
  await writeProcessedEmailIds(cachePath, processedEmailIds);

  console.log(
    `Synced ${result.sent} transactions to Actual: ${result.created} created, ${result.duplicates} duplicates`,
  );

  return {
    fetched: emails.length,
    created: result.created,
    duplicates: result.duplicates,
  };
};

export const main = async () => {
  const summary = await run();

  const path = runLogPath();
  if (path) await appendRun(path, summary);
};

await main();
