/**
 * Settings with no control in the interface, each with its reviewed reason. tests/settings-inventory.test.ts fails for a
 * setting that has neither a control nor an entry here, and for an entry whose key is gone or now has a control.
 */
export const SETTING_EXCEPTIONS: Record<string, string> = {
  "help.disabled_accounts": "A list of account ids cannot be typed sensibly; a switch per account on the account page is a follow-up.",
  "help.pilot_accounts": "A list of account ids cannot be typed sensibly; a switch per account on the account page is a follow-up.",
  "help.sensitive_patterns": "The one-per-line list control trims lines and cannot hold a newline, which would change privacy patterns; a lossless pattern editor is a follow-up.",
  "delivery.repositories.*.required_checks": "Per-repository requirements are set in config.yaml; a control is a follow-up with the CI check of #163.",
  "delivery.repositories.*.artifacts": "Per-repository requirements are set in config.yaml; a control is a follow-up with the CI check of #163.",
  "delivery.repositories.*.provenance": "Per-repository requirements are set in config.yaml; a control is a follow-up with the CI check of #163.",
  "policy.mandatory": "Overlay packs are files an admin puts in the data folder and names in config.yaml; observe mode only, so a control is a follow-up with enforcement.",
  "policy.repositories": "Per-repository packs are files an admin puts in the data folder and names in config.yaml; observe mode only, so a control is a follow-up with enforcement.",
  "policy.packs": "Policy packs are files an admin puts in the data folder and names in config.yaml; observe mode only, so a control is a follow-up with enforcement.",
  "providers.*.price.input_per_mtok": "Only a provider that reports tokens but no cost needs a price; a field on the Models page is a follow-up.",
  "providers.*.price.output_per_mtok": "Only a provider that reports tokens but no cost needs a price; a field on the Models page is a follow-up.",
  "context.max_sources": "Context selection is not used by runs yet; the keys are set in config.yaml for now, and a Settings control is a follow-up.",
  "context.max_source_bytes": "Context selection is not used by runs yet; the keys are set in config.yaml for now, and a Settings control is a follow-up.",
  "context.max_total_bytes": "Context selection is not used by runs yet; the keys are set in config.yaml for now, and a Settings control is a follow-up.",
  "context.classification": "Context selection is not used by runs yet; the keys are set in config.yaml for now, and a Settings control is a follow-up.",
  "context.max_classification": "Context selection is not used by runs yet; the keys are set in config.yaml for now, and a Settings control is a follow-up.",
  "context.consumers": "Context selection is not used by runs yet; the keys are set in config.yaml for now, and a Settings control is a follow-up.",
  "context.task_max_age_seconds": "Context selection is not used by runs yet; the keys are set in config.yaml for now, and a Settings control is a follow-up.",
  "telemetry.keep_days": "Telemetry is a new local file for operators; a Settings control is a follow-up.",
  "telemetry.local": "Telemetry is a new local file for operators; a Settings control is a follow-up.",
  "telemetry.otlp.enabled": "The OTLP exporter is for operators with a collector and is set in config.yaml; a Settings control is a follow-up with endpoint authentication.",
  "telemetry.otlp.endpoint": "The OTLP exporter is for operators with a collector and is set in config.yaml; a Settings control is a follow-up with endpoint authentication.",
  "telemetry.otlp.timeout_ms": "The OTLP exporter is for operators with a collector and is set in config.yaml; a Settings control is a follow-up with endpoint authentication.",
};
