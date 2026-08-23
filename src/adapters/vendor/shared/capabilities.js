const MODE_OPTIONS = ["default", "auto-review", "full-access"];
const REASONING_EFFORT_OPTIONS = ["low", "medium", "high", "xhigh"];
const DEFAULT_REASONING_EFFORT = "high";
const DEFAULT_MODE = "auto-review";
const APPROVAL_POLICY_OPTIONS = ["never", "on-request"];
const MODEL_OPTIONS = ["gpt-5.5", "gpt-5.4", "gpt-5.3-codex", "gpt-5.2", "gpt-5-codex", "o3"];
const CAPABILITY_OPTION_LIMIT = 50;
const CAPABILITY_STRING_LIMIT = 128;

function uniqueOptions(values, fallback, { limit = CAPABILITY_OPTION_LIMIT, maxLength = CAPABILITY_STRING_LIMIT } = {}) {
  const options = [];
  for (const value of values || []) {
    const option = String(value || "").trim();
    if (option && option.length <= maxLength && !options.includes(option)) {
      options.push(option);
      if (options.length >= limit) {
        break;
      }
    }
  }
  return options.length ? options : fallback;
}

function shortString(value) {
  const text = String(value || "").trim();
  return text && text.length <= CAPABILITY_STRING_LIMIT ? text : null;
}

function baseCapabilities(provider = "codex", overrides = {}) {
  const modelFallback = provider === "codex" ? MODEL_OPTIONS : [];
  return {
    providers: uniqueOptions(overrides.providers, [provider], { limit: 8 }),
    models: uniqueOptions(overrides.models, modelFallback),
    default_model: shortString(overrides.default_model),
    input_modalities: uniqueOptions(overrides.input_modalities, []),
    reasoning_efforts: uniqueOptions(overrides.reasoning_efforts, REASONING_EFFORT_OPTIONS),
    approval_policies: uniqueOptions(overrides.approval_policies, APPROVAL_POLICY_OPTIONS),
    modes: uniqueOptions(overrides.modes, MODE_OPTIONS)
  };
}

function compactProviderCapabilities(provider = "codex", capabilities = {}) {
  const compacted = baseCapabilities(provider, {
    models: capabilities.models,
    providers: [provider],
    default_model: capabilities.default_model,
    input_modalities: capabilities.input_modalities,
    reasoning_efforts: capabilities.reasoning_efforts,
    approval_policies: capabilities.approval_policies,
    modes: capabilities.modes
  });
  compacted.providers = [provider];
  if (compacted.default_model && !compacted.models.includes(compacted.default_model)) {
    compacted.default_model = compacted.models[0] || null;
  }
  return compacted;
}

function compactProviderCapabilitiesMap(providerCapabilities = {}, providers = []) {
  const map = {};
  for (const provider of providers.slice(0, 8)) {
    const key = shortString(provider);
    if (!key || !providerCapabilities[key]) {
      continue;
    }
    map[key] = compactProviderCapabilities(key, providerCapabilities[key]);
  }
  return map;
}

function buildCapabilities(provider = "codex", overrides = {}) {
  const capabilities = baseCapabilities(provider, overrides);
  if (capabilities.default_model && !capabilities.models.includes(capabilities.default_model)) {
    capabilities.default_model = capabilities.models[0] || null;
  }
  const providerCapabilities = compactProviderCapabilitiesMap(overrides.provider_capabilities, capabilities.providers);
  if (Object.keys(providerCapabilities).length) {
    capabilities.provider_capabilities = providerCapabilities;
  }
  return capabilities;
}

function compactCapabilities(provider = "codex", capabilities = {}) {
  return buildCapabilities(provider, {
    models: capabilities.models,
    providers: capabilities.providers,
    default_model: capabilities.default_model,
    input_modalities: capabilities.input_modalities,
    reasoning_efforts: capabilities.reasoning_efforts,
    approval_policies: capabilities.approval_policies,
    modes: capabilities.modes,
    provider_capabilities: capabilities.provider_capabilities
  });
}

function capabilitiesForProvider(provider, capabilities = {}) {
  const selected = String(provider || "").trim();
  if (selected && capabilities.provider_capabilities?.[selected]) {
    return capabilities.provider_capabilities[selected];
  }
  return capabilities;
}

function assertAllowedOption(name, value, options) {
  if (!options.includes(value)) {
    const error = new Error(`${name} 只能是：${options.join(", ")}`);
    error.statusCode = 400;
    throw error;
  }
}

function optionList(capabilities, key, fallback) {
  return uniqueOptions(capabilities?.[key], fallback);
}

function selectOption(input, defaults, key, options, fallback) {
  const hasInput = input[key] !== undefined && input[key] !== null && String(input[key]).trim() !== "";
  const raw = hasInput ? input[key] : defaults[key];
  const fallbackValue = options.includes(fallback) ? fallback : options[0];
  const value = String(raw || fallbackValue);
  if (hasInput) {
    assertAllowedOption(key, value, options);
    return value;
  }
  return options.includes(value) ? value : fallbackValue;
}

function normalizeAgentSettings(input = {}, defaults = {}, capabilities = {}) {
  const modelOptions = optionList(capabilities, "models", []);
  const reasoningOptions = optionList(capabilities, "reasoning_efforts", REASONING_EFFORT_OPTIONS);
  const approvalOptions = optionList(capabilities, "approval_policies", APPROVAL_POLICY_OPTIONS);
  const modeOptions = optionList(capabilities, "modes", MODE_OPTIONS);

  const requestedModel = input.model ?? defaults.model ?? capabilities.default_model ?? null;
  const model = requestedModel === null || String(requestedModel).trim() === ""
    ? null
    : String(requestedModel);
  if (model && modelOptions.length && !modelOptions.includes(model)) {
    assertAllowedOption("model", model, modelOptions);
  }
  const reasoning_effort = selectOption(input, defaults, "reasoning_effort", reasoningOptions, DEFAULT_REASONING_EFFORT);
  const approval_policy = selectOption(input, defaults, "approval_policy", approvalOptions, "on-request");
  const mode = selectOption(input, defaults, "mode", modeOptions, DEFAULT_MODE);

  return { model, reasoning_effort, approval_policy, mode };
}

function codexPolicyForMode(mode) {
  if (mode === "auto-review") {
    return {
      sandbox: "workspace-write",
      networkAccess: false,
      approvalRisk: "low"
    };
  }
  if (mode === "full-access") {
    return {
      sandbox: "danger-full-access",
      networkAccess: true,
      approvalRisk: "high"
    };
  }
  return {
    sandbox: "workspace-write",
    networkAccess: false,
    approvalRisk: "medium"
  };
}

module.exports = {
  APPROVAL_POLICY_OPTIONS,
  DEFAULT_MODE,
  DEFAULT_REASONING_EFFORT,
  MODEL_OPTIONS,
  MODE_OPTIONS,
  REASONING_EFFORT_OPTIONS,
  buildCapabilities,
  capabilitiesForProvider,
  compactCapabilities,
  codexPolicyForMode,
  normalizeAgentSettings
};
