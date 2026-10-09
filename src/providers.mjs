export const PROVIDER_CATALOG = Object.freeze([
  { id: "ollama", label: "Ollama", location: "local", costModel: "hardware", adapter: "ollama", status: "foundation" },
  { id: "lm-studio", label: "LM Studio", location: "local", costModel: "hardware", adapter: "openai-compatible", status: "planned" },
  { id: "llama-cpp", label: "llama.cpp", location: "local", costModel: "hardware", adapter: "openai-compatible", status: "planned" },
  { id: "openrouter-free", label: "OpenRouter Free Models", location: "remote", costModel: "free-limited", adapter: "openai-compatible", status: "planned" },
  { id: "groq-free", label: "Groq Free Plan", location: "remote", costModel: "free-limited", adapter: "openai-compatible", status: "planned" },
  { id: "gemini-free", label: "Gemini API Free Tier", location: "remote", costModel: "free-limited", adapter: "google", status: "planned" },
  { id: "puter-user", label: "Puter.js User-Pays", location: "remote", costModel: "user-allowance", adapter: "puter", status: "research" },
  { id: "g4f-experimental", label: "GPT4Free (g4f)", location: "remote", costModel: "unverified", adapter: "external-community", status: "research-only" },
  { id: "pollinations", label: "Pollinations", location: "remote", costModel: "user-allowance", adapter: "pollinations", status: "research" }
]);

export function checkProviderAccess(provider, policy = {}) {
  if (!provider) return { allowed: false, reason: "unknown-provider" };
  if (provider.location === "local") return { allowed: true, reason: "local" };
  if (policy.cloudEnabled !== true) return { allowed: false, reason: "cloud-disabled" };
  if (!Array.isArray(policy.approvedProviderIds) || !policy.approvedProviderIds.includes(provider.id)) {
    return { allowed: false, reason: "provider-not-approved" };
  }
  if (provider.costModel === "user-allowance" && policy.userFundedApproved !== true) {
    return { allowed: false, reason: "user-funded-not-approved" };
  }
  if (!["free-limited", "user-allowance"].includes(provider.costModel)) {
    return { allowed: false, reason: "unverified-cost-or-access" };
  }
  if (provider.status !== "ready") return { allowed: false, reason: "adapter-not-ready" };
  return { allowed: true, reason: "cloud-explicitly-approved" };
}
