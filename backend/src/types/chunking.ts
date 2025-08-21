export interface ChunkingConfig {
  // Token limits (approximate, using ~4 chars per token rule)
  maxTokensPerChunk: number;      // 1200 tokens ≈ 4800 characters
  minTokensPerChunk: number;      // 300 tokens ≈ 1200 characters  
  overlapTokens: number;          // 100 tokens ≈ 400 characters overlap
  chunksPerGroup: number;         // 2-3 chunks per summarization group
  maxChunksPerGroup: number;      // Maximum chunks in a single group
  
  // Character limits (for rough estimation)
  maxCharsPerChunk: number;       // ~4800 characters (1200 tokens)
  minCharsPerChunk: number;       // ~1200 characters (300 tokens)
  overlapChars: number;           // ~400 characters (100 tokens)
}

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  // Token-based limits (primary)
  maxTokensPerChunk: 1200,        // Manageable for AI processing
  minTokensPerChunk: 300,         // Minimum meaningful content
  overlapTokens: 100,             // Context preservation between chunks
  chunksPerGroup: 2,              // 2 chunks per group for summarization
  maxChunksPerGroup: 3,           // Max 3 chunks if needed
  
  // Character-based approximation (backup)
  maxCharsPerChunk: 4800,         // ~1200 tokens * 4 chars/token
  minCharsPerChunk: 1200,         // ~300 tokens * 4 chars/token
  overlapChars: 400,              // ~100 tokens * 4 chars/token
};

export interface CrawledContent {
  id?: number;
  url: string;
  title: string;
  raw_text: string;
  code_snippets: string[];
  content_type: 'article' | 'code' | 'mixed';
  total_tokens?: number;
  crawled_at: Date;
  status?: 'pending' | 'chunked' | 'failed';
}

export interface ContentChunk {
  id?: number;
  crawled_content_id: number;
  chunk_index: number;
  chunk_text: string;
  token_count: number;
  chunk_type: 'article' | 'code' | 'mixed';
}

export interface ChunkGroup {
  id?: number;
  crawled_content_id: number;
  chunk_ids: number[];
  group_index: number;
  combined_text: string;
  combined_tokens: number;
  status: 'pending' | 'summarized' | 'failed';
}

// Token estimation utility (rough approximation)
export function estimateTokenCount(text: string): number {
  // Simple estimation: ~4 characters per token for English/Myanmar text
  // This includes spaces, punctuation, and typical text structure
  return Math.ceil(text.length / 4);
}

// Text boundary detection for smart chunking
export interface TextBoundary {
  index: number;
  type: 'paragraph' | 'sentence' | 'section' | 'code_block';
  priority: number; // Higher priority = better breaking point
}

export function findTextBoundaries(text: string): TextBoundary[] {
  const boundaries: TextBoundary[] = [];
  
  // Paragraph boundaries (highest priority)
  let match;
  const paragraphRegex = /\n\s*\n/g;
  while ((match = paragraphRegex.exec(text)) !== null) {
    boundaries.push({
      index: match.index + match[0].length,
      type: 'paragraph',
      priority: 100
    });
  }
  
  // Section headers (high priority)
  const sectionRegex = /\n#+\s+.+\n/g;
  while ((match = sectionRegex.exec(text)) !== null) {
    boundaries.push({
      index: match.index + match[0].length,
      type: 'section',
      priority: 90
    });
  }
  
  // Code block boundaries (high priority)
  const codeBlockRegex = /(```[\s\S]*?```|<pre>[\s\S]*?<\/pre>)/g;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    boundaries.push({
      index: match.index,
      type: 'code_block',
      priority: 85
    });
    boundaries.push({
      index: match.index + match[0].length,
      type: 'code_block',
      priority: 85
    });
  }
  
  // Sentence boundaries (medium priority)
  const sentenceRegex = /[.!?]\s+(?=[A-Z])/g;
  while ((match = sentenceRegex.exec(text)) !== null) {
    boundaries.push({
      index: match.index + 1,
      type: 'sentence',
      priority: 50
    });
  }
  
  return boundaries.sort((a, b) => a.index - b.index);
}
