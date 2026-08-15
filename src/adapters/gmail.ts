import { auth as googleAuth, gmail as gmailClient } from "@googleapis/gmail";

type GmailConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

const BANK_SENDERS = {
  yucho: "yuchodebit@jp-bank.japanpost.jp",
  smbc: "smbc-debit@smbc-card.com",
};

const EMAIL_SUBJECTS = ["ご利用のお知らせ"];

const query = [
  `from:{${Object.values(BANK_SENDERS).join(" ")}}`,
  `subject:{${Object.values(EMAIL_SUBJECTS).join(" ")}}`,
  "newer_than:1m",
].join(" ");

export type RawEmail = {
  id: string;
  raw: Buffer;
};

export const fetchGmailMessages = async (
  config: GmailConfig,
): Promise<RawEmail[]> => {
  const auth = new googleAuth.OAuth2({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
  });

  auth.setCredentials({ refresh_token: config.refreshToken });

  const gmail = gmailClient({ version: "v1", auth });

  const { data } = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 500,
  });

  if (data.nextPageToken)
    throw new Error(
      "Requested emails exceeded one page. Consider implementing pagination",
    );

  const messages = data.messages ?? [];

  // No new messages found for query
  if (!messages.length) {
    return [];
  }

  const emailIds = messages.flatMap((m) => (m.id ? [m.id] : []));

  const emails = await Promise.all(
    emailIds.map(async (id) => {
      const { data: message } = await gmail.users.messages.get({
        userId: "me",
        id,
        format: "raw",
      });

      return {
        id,
        raw: Buffer.from(message.raw ?? "", "base64url"),
      };
    }),
  );

  return emails;
};
