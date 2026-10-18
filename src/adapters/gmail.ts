/* eslint-disable no-await-in-loop -- Sequential requests and retries enforce Gmail's quota. */
import { setTimeout } from "node:timers/promises";

import { auth as googleAuth, gmail as gmailClient } from "@googleapis/gmail";

type GmailRequestError = Error & {
  code?: string | number;
  response?: {
    status: number;
    headers: Headers;
    data?: { error?: { errors?: { reason?: string }[] } };
  };
};

const TRANSIENT_NETWORK_ERRORS = new Set([
  "EAI_AGAIN",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "TimeoutError",
]);

// Space every attempt, including listings, below 6,000 units/minute at 60 units each.
const REQUEST_INTERVAL_MS = 750;
const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 32_000;
let nextRequestAt = 0;

const requestGmail = async <T>(request: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    while (performance.now() < nextRequestAt) {
      await setTimeout(
        Math.min(nextRequestAt - performance.now(), MAX_BACKOFF_MS),
      );
    }
    nextRequestAt = performance.now() + REQUEST_INTERVAL_MS;

    try {
      return await request();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const { code, response } = error as GmailRequestError;
      const status = response?.status;
      const quotaExceeded =
        status === 403 &&
        response?.data?.error?.errors?.some(({ reason }) =>
          ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason ?? ""),
        );
      const retryable =
        status === 429 ||
        (status !== undefined && [500, 502, 503, 504].includes(status)) ||
        quotaExceeded ||
        (status === undefined && TRANSIENT_NETWORK_ERRORS.has(String(code)));

      if (!retryable || attempt >= MAX_RETRIES) throw error;

      const retryAfter = response?.headers.get("retry-after");
      const retryAfterMs = retryAfter
        ? Number.isFinite(Number(retryAfter))
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - Date.now()
        : 0;
      const backoffMs = Math.min(
        1000 * 2 ** attempt + Math.random() * 1000,
        MAX_BACKOFF_MS,
      );
      nextRequestAt = Math.max(
        nextRequestAt,
        performance.now() + Math.max(backoffMs, retryAfterMs || 0),
      );
    }
  }
};

type GmailConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  startDate: Date | undefined;
};

const BANK_SENDERS = {
  yucho: "yuchodebit@jp-bank.japanpost.jp",
  smbc: "smbc-debit@smbc-card.com",
};

const EMAIL_SUBJECTS = ["ご利用のお知らせ"];

const emailDateFilter = (startDate?: Date) => {
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

  if (startDate && startDate > oneMonthAgo)
    return `after:${Math.floor(startDate.getTime() / 1000)}`;

  return "newer_than:1m";
};

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

  const query = [
    `from:{${Object.values(BANK_SENDERS).join(" ")}}`,
    `subject:{${Object.values(EMAIL_SUBJECTS).join(" ")}}`,
    emailDateFilter(config.startDate),
  ].join(" ");

  const { data } = await requestGmail(() =>
    gmail.users.messages.list(
      {
        userId: "me",
        q: query,
        maxResults: 500,
      },
      { retry: false },
    ),
  );

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

  const emails: RawEmail[] = [];
  for (const id of emailIds) {
    const { data: message } = await requestGmail(() =>
      gmail.users.messages.get(
        {
          userId: "me",
          id,
          format: "raw",
        },
        { retry: false },
      ),
    );

    emails.push({
      id,
      raw: Buffer.from(message.raw ?? "", "base64url"),
    });
  }

  return emails;
};
