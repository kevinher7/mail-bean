import { z } from "zod";

const gmailSchema = z
  .object({
    MAIL_BEAN_GOOGLE_CLIENT_ID: z.string().min(1),
    MAIL_BEAN_GOOGLE_CLIENT_SECRET: z.string().min(1),
    MAIL_BEAN_GOOGLE_REFRESH_TOKEN: z.string().min(1),
  })
  .transform((env) => ({
    clientId: env.MAIL_BEAN_GOOGLE_CLIENT_ID,
    clientSecret: env.MAIL_BEAN_GOOGLE_CLIENT_SECRET,
    refreshToken: env.MAIL_BEAN_GOOGLE_REFRESH_TOKEN,
  }));

const accountMapSchema = z
  .string()
  .transform((value) => JSON.parse(value) as unknown)
  .pipe(z.record(z.string(), z.string()));

const categoryMapSchema = z
  .string()
  .default("{}")
  .transform((value) => JSON.parse(value) as unknown)
  .pipe(z.record(z.string().min(1), z.array(z.string().min(1))))
  .transform((payeesByCategory) => {
    const categoryByPayee: Record<string, string> = {};

    for (const [category, payees] of Object.entries(payeesByCategory)) {
      for (const payee of payees) {
        const normalizedPayee = payee.trim().toLowerCase();
        if (categoryByPayee[normalizedPayee]) {
          throw new Error(`Payee "${payee}" is mapped to two categories`);
        }
        categoryByPayee[normalizedPayee] = category;
      }
    }

    return categoryByPayee;
  });

const actualSchema = z
  .object({
    MAIL_BEAN_ACTUAL_SERVER_URL: z.url(),
    MAIL_BEAN_ACTUAL_PASSWORD: z.string().min(1),
    MAIL_BEAN_ACTUAL_SYNC_ID: z.uuid(),
    MAIL_BEAN_ACTUAL_E2E_PASSWORD: z.string().optional(),
    MAIL_BEAN_ACTUAL_DATA_DIR: z.string().min(1),
    MAIL_BEAN_ACCOUNT_MAP: accountMapSchema,
    MAIL_BEAN_ACTUAL_CATEGORY_MAP: categoryMapSchema,
  })
  .transform((env) => ({
    serverURL: env.MAIL_BEAN_ACTUAL_SERVER_URL,
    password: env.MAIL_BEAN_ACTUAL_PASSWORD,
    syncId: env.MAIL_BEAN_ACTUAL_SYNC_ID,
    e2ePassword: env.MAIL_BEAN_ACTUAL_E2E_PASSWORD || undefined,
    dataDir: env.MAIL_BEAN_ACTUAL_DATA_DIR,
    accountMap: env.MAIL_BEAN_ACCOUNT_MAP,
    categoryMap: env.MAIL_BEAN_ACTUAL_CATEGORY_MAP,
  }));

export const gmailConfig = () => gmailSchema.parse(process.env);
export const actualConfig = () => actualSchema.parse(process.env);
