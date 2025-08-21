import { Client as PgClient } from 'pg';
import dotenv from 'dotenv';
import { 
  CrawledContent, 
  ContentChunk, 
  ChunkGroup, 
  ChunkingConfig, 
  DEFAULT_CHUNKING_CONFIG,
  estimateTokenCount,
  findTextBoundaries,
  TextBoundary
} from '../types/chunking';

dotenv.config();

export class ContentChunkerWorker {
  private pgClient: PgClient;
  private isRunning = false;
  private batchSize: number;
  private config: ChunkingConfig;

  constructor(config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG) {
    this.batchSize = parseInt(process.env.CHUNKER_BATCH_SIZE || '5', 10);
    this.config = config;

    // PostgreSQL client
    this.pgClient = new PgClient({
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DB,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });
  }

  async connect(): Promise<void> {
    try {
      await this.pgClient.connect();
      await this.initializeDatabase();
    } catch (error: any) {
      if (!error.message?.includes('Client has already been connected')) {
        throw error;
      }
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.pgClient.end();
    } catch (error) {
      console.warn('Error disconnecting from PostgreSQL:', error);
    }
  }

  async initializeDatabase(): Promise<void> {
    const createTablesQuery = `
      CREATE TABLE IF NOT EXISTS content_chunks (
        id SERIAL PRIMARY KEY,
        crawled_content_id INTEGER REFERENCES crawled_content(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL,
        chunk_text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        chunk_type VARCHAR(20) DEFAULT 'text' CHECK (chunk_type IN ('article', 'code', 'mixed')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(crawled_content_id, chunk_index)
      );

      CREATE TABLE IF NOT EXISTS chunk_groups (
        id SERIAL PRIMARY KEY,
        crawled_content_id INTEGER REFERENCES crawled_content(id) ON DELETE CASCADE,
        chunk_ids INTEGER[] NOT NULL,
        group_index INTEGER NOT NULL,
        combined_text TEXT NOT NULL,
        combined_tokens INTEGER NOT NULL,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'summarized', 'failed')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(crawled_content_id, group_index)
      );
    `;
    
    await this.pgClient.query(createTablesQuery);
    console.log('Content chunker tables initialized');
  }

  /**
   * text chunking algorithm
   */
  chunkText(text: string, contentType: 'article' | 'code' | 'mixed'): string[] {
    const chunks: string[] = [];
    const boundaries = findTextBoundaries(text);
    
    let currentChunk = '';
    let currentTokens = 0;
    let lastBoundary = 0;

    // Add a final boundary at the end of text
    boundaries.push({ index: text.length, type: 'paragraph', priority: 100 });

    for (const boundary of boundaries) {
      const segmentText = text.slice(lastBoundary, boundary.index);
      const segmentTokens = estimateTokenCount(segmentText);
      
      // Check if adding this segment would exceed chunk limit
      if (currentTokens + segmentTokens > this.config.maxTokensPerChunk && currentChunk.length > 0) {
        // Finalize current chunk if it meets minimum size
        if (currentTokens >= this.config.minTokensPerChunk) {
          chunks.push(currentChunk.trim());
          
          // Start new chunk with overlap if configured
          if (this.config.overlapTokens > 0) {
            const overlapText = this.getOverlapText(currentChunk, this.config.overlapTokens);
            currentChunk = overlapText + segmentText;
            currentTokens = estimateTokenCount(currentChunk);
          } else {
            currentChunk = segmentText;
            currentTokens = segmentTokens;
          }
        } else {
          // Current chunk too small, add segment anyway
          currentChunk += segmentText;
          currentTokens += segmentTokens;
        }
      } else {
        // Add segment to current chunk
        currentChunk += segmentText;
        currentTokens += segmentTokens;
      }
      
      lastBoundary = boundary.index;
    }

    // Add final chunk if it has content
    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }

    // Handle case where no good boundaries were found - split by character count
    if (chunks.length === 0 && text.length > 0) {
      return this.fallbackChunking(text);
    }

    return chunks;
  }

  /**
   * Fallback chunking when no good boundaries are found
   */
  private fallbackChunking(text: string): string[] {
    const chunks: string[] = [];
    const maxChars = this.config.maxCharsPerChunk;
    const overlapChars = this.config.overlapChars;

    for (let i = 0; i < text.length; i += maxChars - overlapChars) {
      const chunk = text.slice(i, i + maxChars);
      if (chunk.trim().length > 0) {
        chunks.push(chunk.trim());
      }
    }

    return chunks;
  }

  /**
   * Get overlap text from the end of a chunk
   */
  private getOverlapText(chunk: string, overlapTokens: number): string {
    const overlapChars = overlapTokens * 4; // Rough estimation
    if (chunk.length <= overlapChars) {
      return chunk;
    }
    
    // Try to find a good breaking point near the end
    const startIndex = Math.max(0, chunk.length - overlapChars);
    const overlapSection = chunk.slice(startIndex);
    
    // Look for sentence or paragraph boundaries
    const sentenceBoundary = overlapSection.lastIndexOf('. ');
    if (sentenceBoundary > overlapChars / 2) {
      return chunk.slice(startIndex + sentenceBoundary + 2);
    }
    
    return overlapSection;
  }

  /**
   * Create chunk groups for summarization
   */
  createChunkGroups(chunks: ContentChunk[]): ChunkGroup[] {
    const groups: ChunkGroup[] = [];
    const chunksPerGroup = this.config.chunksPerGroup;
    const maxChunksPerGroup = this.config.maxChunksPerGroup;

    for (let i = 0; i < chunks.length; i += chunksPerGroup) {
      const groupChunks = chunks.slice(i, i + maxChunksPerGroup);
      
      const combinedText = groupChunks.map(chunk => chunk.chunk_text).join('\n\n');
      const combinedTokens = groupChunks.reduce((total, chunk) => total + chunk.token_count, 0);
      
      groups.push({
        crawled_content_id: chunks[0].crawled_content_id,
        chunk_ids: groupChunks.map(chunk => chunk.id!).filter(id => id !== undefined),
        group_index: Math.floor(i / chunksPerGroup),
        combined_text: combinedText,
        combined_tokens: combinedTokens,
        status: 'pending'
      });
    }

    return groups;
  }

  /**
   * Save chunks to database
   */
  async saveChunks(contentId: number, chunks: string[], contentType: 'article' | 'code' | 'mixed'): Promise<ContentChunk[]> {
    const savedChunks: ContentChunk[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      const tokenCount = estimateTokenCount(chunkText);
      
      const query = `
        INSERT INTO content_chunks (
          crawled_content_id, chunk_index, chunk_text, token_count, chunk_type
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (crawled_content_id, chunk_index)
        DO UPDATE SET
          chunk_text = EXCLUDED.chunk_text,
          token_count = EXCLUDED.token_count,
          chunk_type = EXCLUDED.chunk_type
        RETURNING id
      `;

      try {
        const result = await this.pgClient.query(query, [
          contentId,
          i,
          chunkText,
          tokenCount,
          contentType
        ]);

        savedChunks.push({
          id: result.rows[0].id,
          crawled_content_id: contentId,
          chunk_index: i,
          chunk_text: chunkText,
          token_count: tokenCount,
          chunk_type: contentType
        });
      } catch (error) {
        console.error(`Error saving chunk ${i} for content ${contentId}:`, error);
      }
    }

    return savedChunks;
  }

  /**
   * Save chunk groups to database
   */
  async saveChunkGroups(groups: ChunkGroup[]): Promise<number> {
    let savedCount = 0;

    for (const group of groups) {
      const query = `
        INSERT INTO chunk_groups (
          crawled_content_id, chunk_ids, group_index, combined_text, combined_tokens, status
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (crawled_content_id, group_index)
        DO UPDATE SET
          chunk_ids = EXCLUDED.chunk_ids,
          combined_text = EXCLUDED.combined_text,
          combined_tokens = EXCLUDED.combined_tokens,
          status = 'pending',
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `;

      try {
        await this.pgClient.query(query, [
          group.crawled_content_id,
          group.chunk_ids,
          group.group_index,
          group.combined_text,
          group.combined_tokens,
          group.status
        ]);
        savedCount++;
      } catch (error) {
        console.error(`Error saving chunk group ${group.group_index}:`, error);
      }
    }

    return savedCount;
  }

  /**
   * Process a single article into chunks and groups
   */
  async processContent(content: CrawledContent): Promise<boolean> {
    try {
      console.log(`Processing content: ${content.title} (${content.total_tokens} tokens)`);

      // Chunk the text
      const textChunks = this.chunkText(content.raw_text, content.content_type);
      
      if (textChunks.length === 0) {
        console.warn(`No chunks created for content ${content.id}: ${content.title}`);
        return false;
      }

      // Save chunks to database
      const savedChunks = await this.saveChunks(content.id!, textChunks, content.content_type);
      
      if (savedChunks.length === 0) {
        console.error(`Failed to save chunks for content ${content.id}`);
        return false;
      }

      // Create chunk groups
      const chunkGroups = this.createChunkGroups(savedChunks);
      
      // Save chunk groups
      const savedGroupsCount = await this.saveChunkGroups(chunkGroups);

      // Update content status to 'chunked'
      await this.pgClient.query(
        "UPDATE crawled_content SET status = 'chunked', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [content.id]
      );

      console.log(`✅ Processed ${content.title}: ${savedChunks.length} chunks, ${savedGroupsCount} groups`);
      return true;

    } catch (error) {
      console.error(`Error processing content ${content.id}:`, error);
      
      // Mark as failed
      try {
        await this.pgClient.query(
          "UPDATE crawled_content SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
          [content.id]
        );
      } catch (updateError) {
        console.error('Failed to update status to failed:', updateError);
      }
      
      return false;
    }
  }

  /**
   * Process a batch of pending content
   */
  async processBatch(): Promise<number> {
    try {
      await this.connect();

      // Get pending crawled content
      const result = await this.pgClient.query(
        `SELECT id, url, title, raw_text, code_snippets, content_type, total_tokens, crawled_at
         FROM crawled_content 
         WHERE status = 'pending' 
         ORDER BY created_at ASC 
         LIMIT $1`,
        [this.batchSize]
      );

      if (result.rows.length === 0) {
        return 0;
      }

      console.log(`Processing batch of ${result.rows.length} content items`);

      let successCount = 0;
      for (const row of result.rows) {
        const content: CrawledContent = {
          id: row.id,
          url: row.url,
          title: row.title,
          raw_text: row.raw_text,
          code_snippets: Array.isArray(row.code_snippets) ? row.code_snippets : JSON.parse(row.code_snippets || '[]'),
          content_type: row.content_type,
          total_tokens: row.total_tokens,
          crawled_at: row.crawled_at,
          status: 'pending'
        };

        if (await this.processContent(content)) {
          successCount++;
        }
      }

      console.log(`Processed ${result.rows.length} content items -> ${successCount} successful`);
      return successCount;

    } catch (error) {
      console.error('Error processing batch:', error);
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Content chunker worker already running');
      return;
    }

    this.isRunning = true;
    console.log('Starting content chunker worker...');

    while (this.isRunning) {
      try {
        const processedCount = await this.processBatch();

        if (processedCount === 0) {
          // No content to process, wait before checking again
          await new Promise(resolve => setTimeout(resolve, 10000)); // 10 second wait
        } else {
          // Small delay between batches
          await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second wait
        }
      } catch (error) {
        console.error('Error in content chunker loop:', error);
        await new Promise(resolve => setTimeout(resolve, 15000)); // 15 second wait on error
      }
    }

    console.log('Content chunker worker stopped');
  }

  stop(): void {
    console.log('Stopping content chunker worker...');
    this.isRunning = false;
  }

  async getStatus(): Promise<{
    pendingContentCount: number;
    chunkedContentCount: number;
    totalChunksCount: number;
    pendingGroupsCount: number;
  }> {
    await this.connect();

    const [pendingContent, chunkedContent, totalChunks, pendingGroups] = await Promise.all([
      this.pgClient.query("SELECT COUNT(*) as count FROM crawled_content WHERE status = 'pending'"),
      this.pgClient.query("SELECT COUNT(*) as count FROM crawled_content WHERE status = 'chunked'"),
      this.pgClient.query('SELECT COUNT(*) as count FROM content_chunks'),
      this.pgClient.query("SELECT COUNT(*) as count FROM chunk_groups WHERE status = 'pending'")
    ]);

    return {
      pendingContentCount: parseInt(pendingContent.rows[0].count),
      chunkedContentCount: parseInt(chunkedContent.rows[0].count),
      totalChunksCount: parseInt(totalChunks.rows[0].count),
      pendingGroupsCount: parseInt(pendingGroups.rows[0].count),
    };
  }

  isWorkerRunning(): boolean {
    return this.isRunning;
  }

  async cleanup(): Promise<void> {
    this.stop();
    await this.disconnect();
  }
}