const PROVIDER_ALIASES = {
  claude: "claude-code",
  "claude-code-headless": "claude-code"
};

function normalizeProviderName(provider) {
  const name = String(provider || "").trim();
  return PROVIDER_ALIASES[name] || name;
}

function parseProviderList(value, fallback = ["mock"]) {
  const providers = String(value || "")
    .split(",")
    .map(normalizeProviderName)
    .filter(Boolean);
  const unique = [];
  for (const provider of providers) {
    if (!unique.includes(provider)) {
      unique.push(provider);
    }
  }
  return unique.length ? unique : fallback;
}

module.exports = {
  normalizeProviderName,
  parseProviderList
};
