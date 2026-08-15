import { z } from "zod";

export const config = z
  .object({
    MAIL_BEAN_GOOGLE_CLIENT_ID: z.string().min(1),
    MAIL_BEAN_GOOGLE_CLIENT_SECRET: z.string().min(1),
    MAIL_BEAN_GOOGLE_REFRESH_TOKEN: z.string().min(1),
  })
  .transform((env) => ({
    clientId: env.MAIL_BEAN_GOOGLE_CLIENT_ID,
    clientSecret: env.MAIL_BEAN_GOOGLE_CLIENT_SECRET,
    refreshToken: env.MAIL_BEAN_GOOGLE_REFRESH_TOKEN,
  }))
  .parse(process.env);
