// Markers of Azure-only content in a skill. Data only, no imports; the code that reads it is source-skill-evaluation.ts.
// A marker is a literal or a look-behind followed by a flat pattern, so no input makes a pattern backtrack badly.

export type ProviderRequirementKind = "clis" | "mcp" | "credentials" | "services";

export interface ProviderMarker {
  rule: string;
  provider: string;
  kind: ProviderRequirementKind;
  /** A declared name equal to one of these, or starting with `<name>-`, covers the marker. */
  names: readonly string[];
  /** A declared name equal to one of these covers the marker; unlike `names`, no `<alias>-…` name does. */
  aliases: readonly string[];
  re: RegExp;
}

// A command is its name, alone or after a path, followed by a subcommand or an option; no list of subcommands to keep up to date.
const invocation = (name: string) => `(?<![\\w.-])(?:(?:\\/[\\w.+-]+)*\\/)?${name}\\s+(?:[a-z][a-z0-9-]*\\b|--?[A-Za-z]|CLI\\b)`;

export const PROVIDER_MARKERS: readonly ProviderMarker[] = [
  {
    rule: "azure-cli", provider: "azure", kind: "clis", names: ["az"], aliases: ["azure-cli"],
    re: new RegExp(`${invocation("az")}|(?<=\`)az(?=\`)|\\bAzure\\s+CLI\\b`),
  },
  {
    rule: "azure-developer-cli", provider: "azure", kind: "clis", names: ["azd"], aliases: ["azure-developer-cli"],
    re: new RegExp(`${invocation("azd")}|(?<=\`)azd(?=\`)|\\bAzure\\s+Developer\\s+CLI\\b`),
  },
  {
    rule: "azure-identity", provider: "azure", kind: "credentials", names: ["azure-identity"], aliases: ["azure"],
    re: /\b(?:DefaultAzureCredential|ManagedIdentityCredential|ClientSecretCredential|ClientCertificateCredential|WorkloadIdentityCredential|AzureCliCredential|AzureDeveloperCliCredential|AzurePowerShellCredential|InteractiveBrowserCredential|DeviceCodeCredential|ChainedTokenCredential|EnvironmentCredential)\b/,
  },
  {
    rule: "azure-mcp", provider: "azure", kind: "mcp", names: ["azure"], aliases: [],
    re: /\bmcp__azure[A-Za-z0-9_-]*__|\bazmcp[_-][a-z0-9_-]+|@azure\/mcp\b/,
  },
  { rule: "azure-portal", provider: "azure", kind: "services", names: ["azure-portal"], aliases: ["azure"], re: /(?<![\w-])portal\.azure\.(?:com|us|cn)\b/i },
  { rule: "azure-cosmos-host", provider: "azure", kind: "services", names: ["azure-cosmos"], aliases: ["azure", "cosmos-db", "cosmosdb"], re: /(?<![\w-])(?:documents|cosmos)\.azure\.com\b/i },
  { rule: "azure-storage-host", provider: "azure", kind: "services", names: ["azure-storage"], aliases: ["azure"], re: /(?<![\w-])core\.windows\.net\b/i },
  { rule: "azure-key-vault-host", provider: "azure", kind: "services", names: ["azure-key-vault", "azure-keyvault"], aliases: ["azure"], re: /(?<![\w-])vault\.azure\.net\b/i },
  { rule: "azure-sql-host", provider: "azure", kind: "services", names: ["azure-sql"], aliases: ["azure"], re: /(?<![\w-])database\.windows\.net\b/i },
  { rule: "azure-service-bus-host", provider: "azure", kind: "services", names: ["azure-service-bus", "azure-servicebus"], aliases: ["azure"], re: /(?<![\w-])servicebus\.windows\.net\b/i },
  { rule: "azure-openai-host", provider: "azure", kind: "services", names: ["azure-openai", "azure-cognitive"], aliases: ["azure"], re: /(?<![\w-])(?:openai|cognitiveservices)\.azure\.com\b/i },
  { rule: "azure-search-host", provider: "azure", kind: "services", names: ["azure-search", "azure-ai-search"], aliases: ["azure"], re: /(?<![\w-])search\.windows\.net\b/i },
  { rule: "azure-app-host", provider: "azure", kind: "services", names: ["azure-app-service", "azure-functions", "azure-web"], aliases: ["azure"], re: /(?<![\w-])azurewebsites\.net\b/i },
  { rule: "azure-registry-host", provider: "azure", kind: "services", names: ["azure-container-registry", "azure-acr"], aliases: ["azure"], re: /(?<![\w-])azurecr\.io\b/i },
  { rule: "azure-management-host", provider: "azure", kind: "services", names: ["azure-management", "azure-resource-manager", "azure-arm"], aliases: ["azure"], re: /(?<![\w-])management\.azure\.com\b/i },
  { rule: "azure-entra-host", provider: "azure", kind: "services", names: ["azure-entra", "azure-identity"], aliases: ["azure"], re: /(?<![\w-])login\.microsoftonline\.com\b/i },
];
