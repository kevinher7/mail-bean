import { simpleParser, type ParsedMail } from "mailparser";

import type { Transaction } from "../contracts.js";
import type { RawEmail } from "./gmail.js";

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

const parseTransaction = (email: ParsedMail): Transaction | null => {
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
    dedupId: `${issuer.sourceAccount}-${approval}`,
  };
};

export const parseEmailsTransactions = async (emails: RawEmail[]) => {
  return await Promise.all(
    emails.map(async (email) => {
      const parsedEmail = await simpleParser(email.raw, {
        skipTextToHtml: true,
        skipTextLinks: true,
      });

      // TODO: Right now we don't use the minted "id" field from the emails
      // maybe try to surface a mail url of sorts for easy verification
      return parseTransaction(parsedEmail);
    }),
  );
};
