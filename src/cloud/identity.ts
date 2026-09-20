/** AUTH-1 named identities. Pure declarations shared by the browser, router and host chains. */
import { isCloudChain, type AccessPolicy } from "../auth/policy.ts";
import { NotConfiguredError } from "../errors.ts";
import type { NamedCredential } from "../types/credential.ts";

export const NAMED_CREDENTIALS: readonly NamedCredential[] = Object.freeze(["platform", "workload", "environment", "cli"]);

type NamedTable<T> = Readonly<Record<string, Readonly<Record<NamedCredential, T>>>>;
export const NAMED_RUNGS: NamedTable<readonly string[]> = {
  "aws-chain": {
    platform: ["container", "imds"], workload: ["web-identity"], environment: ["env:AWS_ACCESS_KEY_ID"],
    cli: ["assume-role", "sso", "shared-credentials-file", "login", "credential_process", "config-file"],
  },
  "azure-chain": {
    platform: ["managed-identity"], workload: ["workload-identity"], environment: ["environment"], cli: ["az", "pwsh", "azd"],
  },
  "gcp-chain": {
    platform: ["metadata"], workload: ["adc-env"], environment: ["adc-env"], cli: ["adc-file", "gcloud"],
  },
};
for (const names of Object.values(NAMED_RUNGS)) {
  for (const rungs of Object.values(names)) Object.freeze(rungs);
  Object.freeze(names);
}
Object.freeze(NAMED_RUNGS);
const MEANINGS: NamedTable<string> = {
  "aws-chain": {
    platform: "the ECS/EKS container endpoint, else the EC2 instance role (IMDSv2)",
    workload: "web identity (AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN) via STS",
    environment: "AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY",
    cli: "the active AWS profile (assume-role, SSO, shared files, aws login, credential_process)",
  },
  "azure-chain": {
    platform: "Azure managed identity", workload: "Entra workload identity (AZURE_FEDERATED_TOKEN_FILE)",
    environment: "an Entra service principal from AZURE_TENANT_ID / AZURE_CLIENT_ID + secret or certificate",
    cli: "az, Azure PowerShell or azd sign-in",
  },
  "gcp-chain": {
    platform: "the attached service account (GCE metadata server)",
    workload: "workload identity federation (GOOGLE_APPLICATION_CREDENTIALS, type external_account)",
    environment: "a service-account file (GOOGLE_APPLICATION_CREDENTIALS, type service_account or impersonated_service_account)",
    cli: "gcloud auth application-default login (the ADC file) or gcloud auth print-access-token",
  },
};

export function validateNamedCredential(policy: AccessPolicy, name: string | undefined, explicit = false): asserts name is NamedCredential | undefined {
  if (name === undefined) return;
  if (!(NAMED_CREDENTIALS as readonly string[]).includes(name)) {
    throw new NotConfiguredError(`${policy.provider}: unknown named credential; choose ${NAMED_CREDENTIALS.join(", ")}`, { provider: policy.provider });
  }
  if (!isCloudChain(policy)) throw new NotConfiguredError(`${policy.provider}: not a cloud door; named credentials exist only on cloud chains; pass apiKey instead`, { provider: policy.provider });
  if (explicit) throw new NotConfiguredError(`${policy.provider}: both api_keys and credentials name this door; pass an explicit apiKey or a named credential, not both`, { provider: policy.provider });
}

export function namedMeaning(policy: AccessPolicy, name: NamedCredential): string {
  validateNamedCredential(policy, name);
  return MEANINGS[policy.credentialPolicy]![name];
}
