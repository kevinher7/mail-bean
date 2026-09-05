import { syncToActual } from "./adapters/actual.js";
import { fetchGmailMessages } from "./adapters/gmail.js";
import { parseEmailsTransactions } from "./adapters/parser.js";
import { gmailConfig } from "./config.js";

export const main = async () => {
  const emails = await fetchGmailMessages(gmailConfig());

  if (emails.length == 0) {
    console.log("No new emails to parse");
    return;
  }

  console.log(`Fetched ${emails.length} emails`);

  const parsed = await parseEmailsTransactions(emails);
  const transactions = parsed.filter((transaction) => transaction !== null);

  if (transactions.length === 0) {
    throw new Error("Failed to find transactions in emails");
  }

  console.log(
    `Parsed ${transactions.length} transactions, skipped ${parsed.length - transactions.length} emails`,
  );

  const result = await syncToActual(transactions);

  console.log(
    `Synced ${result.sent} transactions to Actual: ${result.created} created, ${result.duplicates} duplicates`,
  );
};

await main();
