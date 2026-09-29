export async function fetchCached(url, onProgress) {
  try {
    if (typeof caches !== "undefined") {
      const cache = await caches.open("planigator-voices");
      const hit = await cache.match(url);
      if (hit) {
        onProgress?.(1);
        return hit.arrayBuffer();
      }
      const buffer = await fetchBuffer(url, onProgress);
      try {
        await cache.put(url, new Response(buffer.slice(0)));
      } catch {
        // Private browsing can refuse the cache. The voice still plays.
      }
      return buffer;
    }
  } catch {
    // Cache lookup failed. Download it directly.
  }
  return fetchBuffer(url, onProgress);
}

async function fetchBuffer(url, onProgress) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed (${resp.status})`);
  const total = Number(resp.headers.get("content-length")) || 0;
  if (!resp.body || !total) {
    const buffer = await resp.arrayBuffer();
    onProgress?.(1);
    return buffer;
  }
  const reader = resp.body.getReader();
  const parts = [];
  let got = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.byteLength;
    onProgress?.(Math.min(0.99, got / total));
  }
  const bytes = new Uint8Array(got);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  onProgress?.(1);
  return bytes.buffer;
}
