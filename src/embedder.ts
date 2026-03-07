// ── Types ───────────────────────────────────────────────────────────────────

export type EmbeddingVector = number[]

// ── Singleton embedder ──────────────────────────────────────────────────────

let embedder: any

export async function getEmbedder(): Promise<any> {
  if (!embedder) {
    let pipeline: any
    try {
      const mod = await import("@xenova/transformers")
      pipeline = mod.pipeline
    } catch {
      throw new Error(
        "Semantic search requires @xenova/transformers. Install it with: npm install @xenova/transformers",
      )
    }
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
  }
  return embedder
}

export async function embed(text: string): Promise<EmbeddingVector> {
  const model = await getEmbedder()
  const result = await model(text, { pooling: "mean", normalize: true })
  return Array.from(result.data) as number[]
}

// ── Similarity ──────────────────────────────────────────────────────────────

export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
  }
  return dot
}

// ── Availability check ──────────────────────────────────────────────────────

export async function isEmbeddingAvailable(): Promise<boolean> {
  try {
    await getEmbedder()
    return true
  } catch {
    return false
  }
}
