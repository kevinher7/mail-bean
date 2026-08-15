import { fetchGmailMessages } from "./adapters/gmail.js";
import { config } from "./config.js";

export const main = async () => {
  const emails = await fetchGmailMessages(config);

  if (emails.length == 0) {
    console.log("No new emails to parse");
    return;
  }

  console.log(`Fetched ${emails.length} emails`);
};

await main();
