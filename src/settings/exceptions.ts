/**
 * Settings with no control in the interface, each with its reviewed reason. tests/settings-inventory.test.ts fails for a
 * setting that has neither a control nor an entry here, and for an entry whose key is gone or now has a control.
 */
export const SETTING_EXCEPTIONS: Record<string, string> = {
  "help.disabled_accounts": "A list of account ids cannot be typed sensibly; a switch per account on the account page is a follow-up.",
  "help.pilot_accounts": "A list of account ids cannot be typed sensibly; a switch per account on the account page is a follow-up.",
  "help.sensitive_patterns": "The one-per-line list control trims lines and cannot hold a newline, which would change privacy patterns; a lossless pattern editor is a follow-up.",
  "policy.packs": "Policy packs are files an admin puts in the data folder and names in config.yaml; observe mode only, so a control is a follow-up with enforcement.",
  "providers.*.price.input_per_mtok": "Only a provider that reports tokens but no cost needs a price; a field on the Models page is a follow-up.",
  "providers.*.price.output_per_mtok": "Only a provider that reports tokens but no cost needs a price; a field on the Models page is a follow-up.",
  "telemetry.keep_days": "Telemetry is a new local file for operators; a control on the Settings page comes with the exporter.",
  "telemetry.local": "Telemetry is a new local file for operators; a control on the Settings page comes with the exporter.",
};
