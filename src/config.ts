import { z } from "zod";

const startDateSchema = z
  .string()
  .optional()
  .transform((value) => (value ? new Date(value) : undefined))
  .pipe(z.date().optional());

const gmailSchema = z
  .object({
    MAIL_BEAN_GOOGLE_CLIENT_ID: z.string().min(1),
    MAIL_BEAN_GOOGLE_CLIENT_SECRET: z.string().min(1),
    MAIL_BEAN_GOOGLE_REFRESH_TOKEN: z.string().min(1),
    MAIL_BEAN_START_DATE: startDateSchema,
  })
  .transform((env) => ({
    clientId: env.MAIL_BEAN_GOOGLE_CLIENT_ID,
    clientSecret: env.MAIL_BEAN_GOOGLE_CLIENT_SECRET,
    refreshToken: env.MAIL_BEAN_GOOGLE_REFRESH_TOKEN,
    startDate: env.MAIL_BEAN_START_DATE,
  }));

const accountMapSchema = z
  .string()
  .transform((value) => JSON.parse(value) as unknown)
  .pipe(z.record(z.string(), z.string()));

const invertPayeeMap = (payeesByTarget: Record<string, string[]>) => {
  const targetByPayee: Record<string, string> = {};

  for (const [target, payees] of Object.entries(payeesByTarget)) {
    for (const payee of payees) {
      const normalizedPayee = payee.trim().toLowerCase();
      if (targetByPayee[normalizedPayee]) {
        throw new Error(`Payee "${payee}" is mapped twice`);
      }
      targetByPayee[normalizedPayee] = target;
    }
  }

  return targetByPayee;
};

const payeeMapSchema = z
  .string()
  .default("{}")
  .transform((value) => JSON.parse(value) as unknown)
  .pipe(z.record(z.string().min(1), z.array(z.string().min(1))))
  .transform(invertPayeeMap);

const actualSchema = z
  .object({
    MAIL_BEAN_ACTUAL_SERVER_URL: z.url(),
    MAIL_BEAN_ACTUAL_PASSWORD: z.string().min(1),
    MAIL_BEAN_ACTUAL_SYNC_ID: z.uuid(),
    MAIL_BEAN_ACTUAL_E2E_PASSWORD: z.string().optional(),
    MAIL_BEAN_ACTUAL_DATA_DIR: z.string().min(1),
    MAIL_BEAN_ACCOUNT_MAP: accountMapSchema,
    MAIL_BEAN_ACTUAL_CATEGORY_MAP: payeeMapSchema,
    MAIL_BEAN_ACTUAL_TRANSFER_MAP: payeeMapSchema,
  })
  .transform((env) => {
    const payeesInBothMaps = Object.keys(
      env.MAIL_BEAN_ACTUAL_TRANSFER_MAP,
    ).filter((payee) => payee in env.MAIL_BEAN_ACTUAL_CATEGORY_MAP);
    if (payeesInBothMaps.length > 0) {
      throw new Error(
        `Payees in both category and transfer map: ${payeesInBothMaps.join(", ")}`,
      );
    }

    return {
      serverURL: env.MAIL_BEAN_ACTUAL_SERVER_URL,
      password: env.MAIL_BEAN_ACTUAL_PASSWORD,
      syncId: env.MAIL_BEAN_ACTUAL_SYNC_ID,
      e2ePassword: env.MAIL_BEAN_ACTUAL_E2E_PASSWORD || undefined,
      dataDir: env.MAIL_BEAN_ACTUAL_DATA_DIR,
      accountMap: env.MAIL_BEAN_ACCOUNT_MAP,
      categoryMap: env.MAIL_BEAN_ACTUAL_CATEGORY_MAP,
      transferMap: env.MAIL_BEAN_ACTUAL_TRANSFER_MAP,
    };
  });

export const gmailConfig = () => gmailSchema.parse(process.env);
export const actualConfig = () => actualSchema.parse(process.env);
