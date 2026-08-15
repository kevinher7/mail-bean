import { simpleParser, type ParsedMail } from "mailparser";
import type { RawEmail } from "./gmail.js";

type Transaction = {
  date: string;
  time: string; // JST, as stated in the emails
  amount: number;
  currency: string;
  sourceAccount: string; // TODO: Make into enum
  payee: string;
  rawRef: string;
  dedupId: string;
};

type Issuer = {
  sourceAccount: "yucho" | "smbc";
  pattern: RegExp;
};

const ISSUERS: Record<string, Issuer> = {
  "yuchodebit@jp-bank.japanpost.jp": {
    sourceAccount: "yucho",
    pattern:
      /利用日時\s+(?<date>\d{4}\/\d{2}\/\d{2})\s+(?<time>\d{2}:\d{2}:\d{2})[\s\S]*?利用店舗\s+(?<payee>[^\n]+)[\s\S]*?利用金額\s+(?<amount>[\d,]+)円[\s\S]*?承認番号\s+(?<approval>\d+)/,
  },
  "smbc-debit@smbc-card.com": {
    sourceAccount: "smbc",
    pattern:
      /利用日\s*：(?<date>\d{4}\/\d{2}\/\d{2})\s+(?<time>\d{2}:\d{2}:\d{2})[\s\S]*?利用先\s*：(?<payee>[^\n]+)[\s\S]*?利用金額：(?<amount>[\d,]+)円[\s\S]*?承認番号：(?<approval>\d+)/,
  },
};

const parseTransaction = (
  email: ParsedMail,
  rawRef: string,
): Transaction | null => {
  const sender = email.from?.value[0]?.address?.toLowerCase() ?? "";
  const issuer = ISSUERS[sender];

  if (!issuer) return null;

  const emailText = email.text ?? "";

  if (!emailText) return null;

  const { date, time, payee, amount, approval } =
    issuer.pattern.exec(emailText)?.groups ?? {};

  if (!date || !time || !payee || !amount || !approval) return null;

  const isoDate = date.replaceAll("/", "-");
  const normalizedAmount = -Number(amount.replaceAll(",", "")); // Negative cause it is a spend

  return {
    date: isoDate,
    time,
    amount: normalizedAmount,
    currency: "JPY",
    sourceAccount: issuer.sourceAccount,
    payee: payee.trim(),
    rawRef,
    dedupId: `${issuer.sourceAccount}-${approval}`,
  };
};

export const parseEmailsTransactions = async (emails: RawEmail[]) => {
  return await Promise.all(
    emails.map(async ({ id, raw }) => {
      const parsedEmail = await simpleParser(raw, {
        skipTextToHtml: true,
        skipTextLinks: true,
      });

      return parseTransaction(parsedEmail, id);
    }),
  );
};
