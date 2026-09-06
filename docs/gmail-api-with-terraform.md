# Managing the Google project with Terraform

Optional. The README setup works entirely from the Google Cloud console. This
doc is for anyone who would rather keep the Gmail API enablement in Terraform,
and it is honest about how little Terraform can do here. The google provider
covers exactly one step of the Gmail setup. Everything else is still a click
path.

## The gmail module

One leaf, three files. The `google_project_service` resource enables the Gmail
API on an existing project. That is the whole module.

`main.tf`

```hcl
terraform {
  required_version = ">= 1.9.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
}

resource "google_project_service" "required" {
  for_each = var.services

  project = var.project_id
  service = each.value

  disable_on_destroy = true
}
```

`variables.tf`

```hcl
variable "project_id" {
  description = "ID of the Google Cloud project that owns the Gmail OAuth client."
  type        = string
}

variable "services" {
  description = "Google APIs to enable on the project."
  type        = set(string)
  default     = ["gmail.googleapis.com"]
}
```

`terraform.tfvars`

```hcl
project_id = "your-gcloud-project-id"
```

Add whatever `backend` block you use for state. Local state is fine for a leaf
this small.

`disable_on_destroy = true` means `terraform destroy` turns the Gmail API off
again. With the API off, mail-bean's refresh token stops working until you
re-apply, so treat destroy as a real outage rather than a cleanup.

## Credentials

The provider authenticates with gcloud Application Default Credentials:

```sh
gcloud auth application-default login
```

ADC are user credentials and belong to no project, so Google needs a quota
project to bill API calls against. Without one the provider fails on the first
API request. Export both variables before running Terraform, or put them in a
`.envrc` if you use direnv:

```sh
export GOOGLE_CLOUD_QUOTA_PROJECT=your-gcloud-project-id
export USER_PROJECT_OVERRIDE=true
```

Then the usual:

```sh
terraform init
terraform plan
terraform apply
```

## What Terraform cannot do

The google provider has no resource for the OAuth consent screen or for a
non-IAP OAuth 2.0 client. See
[terraform-provider-google#6074](https://github.com/hashicorp/terraform-provider-google/issues/6074)
and
[#16452](https://github.com/hashicorp/terraform-provider-google/issues/16452).
Publishing status has no API at all. These steps stay in the console, and the
README setup section walks through them:

- Configure the OAuth consent screen and set its publishing status to
  Production. Do this before minting a refresh token. In Testing, refresh
  tokens expire every 7 days.
- Create the OAuth client, type Desktop app. Copy its client ID and secret into
  `.env`.
- Run the consent flow once to get the refresh token.

The scope you grant at that first consent is baked into the refresh token.
Changing it later invalidates the token and you redo the consent.

Project creation is manual on purpose, even though the provider supports it. A
`google_project` resource would put the project holding the live OAuth client
one `terraform destroy` away from deletion, and deleting the project revokes
every token issued under it. Create the project in the console, note its ID
into `terraform.tfvars`, and let Terraform manage only the API.
