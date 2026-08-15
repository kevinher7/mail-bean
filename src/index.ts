import { fetchGmailMessages } from "./adapters/gmail.js";
import { parseEmailsTransactions } from "./adapters/parser.js";
import { config } from "./config.js";

export const main = async () => {
  const emails = await fetchGmailMessages(config);

  if (emails.length == 0) {
    console.log("No new emails to parse");
    return;
  }

  console.log(`Fetched ${emails.length} emails`);

  const transactions = await parseEmailsTransactions(emails);

  if (!transactions) {
    throw new Error("Failed to find transactions in emails");
  }

  console.log(`Parsed ${transactions.length} transactions`);
  console.log(transactions[0]);
  console.log(transactions[1]);
  console.log(transactions[2]);
};

await main();
