/** Named connection choices for the demo; provider behavior comes from lm15. */
export const CONNECTIONS = [
  { id: "openai", label: "OpenAI", env: "OPENAI_API_KEY", model: "gpt-4.1-mini" },
  { id: "anthropic", label: "Anthropic", env: "ANTHROPIC_API_KEY", model: "claude-haiku-4-5" },
  { id: "gemini", label: "Google Gemini", env: "GEMINI_API_KEY", model: "gemini-2.5-flash" },
  { id: "groq", label: "Groq", env: "GROQ_API_KEY", model: "llama-3.3-70b-versatile" },
  { id: "openrouter", label: "OpenRouter", env: "OPENROUTER_API_KEY", model: "openai/gpt-4.1-mini" },
  { id: "deepseek", label: "DeepSeek", env: "DEEPSEEK_API_KEY", model: "deepseek-chat" },
  { id: "zai", label: "Z.AI", env: "ZAI_API_KEY", model: "glm-4.5" },
  { id: "meta", label: "Meta", env: "META_API_KEY", model: "muse-spark-1.3" },
  { id: "moonshotai", label: "Moonshot / Kimi", env: "MOONSHOTAI_API_KEY", model: "kimi-k2.5" },
  { id: "ollama", label: "Ollama (local)", env: "", model: "qwen3.5:0.8b" },
  { id: "custom", label: "Custom Chat Completions server", env: "", model: "" },
] as const;
