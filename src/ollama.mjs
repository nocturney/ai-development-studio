const DEFAULT_PORTS = [11434, 11555, 11556];

export async function scanOllama({ ports = DEFAULT_PORTS, fetchImpl = fetch, timeoutMs = 1700 } = {}) {
  const found = [];
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let versionResponse, modelsResponse;
      try {
        [versionResponse, modelsResponse] = await Promise.all([
          fetchImpl(`${baseUrl}/api/version`, { signal: controller.signal }),
          fetchImpl(`${baseUrl}/api/tags`, { signal: controller.signal })
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (!versionResponse.ok || !modelsResponse.ok) continue;
      const [version, models] = await Promise.all([versionResponse.json(), modelsResponse.json()]);
      if (typeof version.version !== "string" || !Array.isArray(models.models)) continue;
      found.push({
        provider: "ollama",
        baseUrl,
        version: version.version,
        models: models.models.map(m => ({
          id: String(m.name ?? ""),
          sizeBytes: Number(m.size ?? 0)
        })).filter(m => m.id.length > 0)
      });
    } catch {
      // Offline or unavailable ports are normal and never trigger cloud fallback.
    }
  }
  return found;
}
