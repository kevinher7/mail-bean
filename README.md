# mail-bean

Reads bank debit notification emails from Gmail and imports them into [Actual Budget](https://actualbudget.org).

Supported issuers: SMBC debit, Yucho debit.

## Setup

### 1. Gmail

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and enable the Gmail API.
2. Configure the OAuth consent screen as **External** and set the publishing status to **Production**. In Testing, tokens expire after 7 days.
3. Create an OAuth client of type **Desktop app**. Note the client ID and secret.
4. Get a refresh token with the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground): open the settings gear, tick "Use your own OAuth credentials", enter your client ID and secret, authorize the `https://www.googleapis.com/auth/gmail.modify` scope, then exchange the code. Copy the refresh token.

If you manage cloud resources with Terraform, [docs/gmail-api-with-terraform.md](docs/gmail-api-with-terraform.md) shows how to enable the Gmail API from a module and which of the steps above stay in the console.

### 2. Actual

1. In Actual, open the budget and go to Settings, Advanced, and copy the Sync ID.
2. Create the accounts you want transactions in, for example "SMBC Debit" and "Yucho".

### 3. Config

```sh
cp .env.dist .env
```

Fill in the values. Each one is documented in `.env.dist`. Set `MAIL_BEAN_START_DATE` to the day you start using mail-bean so transactions you already entered by hand are not imported again.

## Run

```sh
npm install
npm run dev
```

Each run fetches the last month of emails and imports the ones Actual has not seen yet. Run it as often as you like, by hand or on a schedule.

### On a schedule

Build and install the binary, then point it at your env file from cron:

```sh
npm run build
npm install -g .
```

```
0 * * * * mail-bean --env /path/to/mail-bean.env
```

Without `--env`, mail-bean reads its config from the environment it is started in.

## Development

```sh
npm run check              # typecheck, format, lint, unit tests
npm run test:integration   # needs a local Actual server, see docker/
```
