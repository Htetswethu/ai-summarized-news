import { Client as PgClient } from 'pg';
import { createClient, RedisClientType } from 'redis';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { ChunkGroup } from '../types/chunking';

dotenv.config();

interface SummarizedContent {
  id?: number;
  url: string;
  title: string;
  original_text: string;
  summary: string;
  key_points: string[];
  code_snippets: string[];
  content_type: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  category: string;
  crawled_at: Date;
  summarized_at: Date;
  crawled_content_id?: number;
  chunk_group_id?: number;
  is_partial_summary: boolean;
}

interface ContentWithGroups {
  id: number;
  url: string;
  title: string;
  content_type: string;
  crawled_at: Date;
  groups: ChunkGroup[];
}

export class ChunkGroupSummarizerWorker {
  private pgClient: PgClient;
  private redisClient: RedisClientType;
  private openai: OpenAI;
  private isRunning = false;
  private batchSize: number;

  constructor() {
    this.batchSize = parseInt(process.env.SUMMARIZER_BATCH_SIZE || '3', 10);
    
    // PostgreSQL client
    this.pgClient = new PgClient({
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DB,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });

    // Redis client
    this.redisClient = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
    });

    // OpenAI client
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    });
  }

  async connect(): Promise<void> {
    try {
      await this.pgClient.connect();
      await this.redisClient.connect();
      await this.initializeDatabase();
    } catch (error: any) {
      if (!error.message?.includes('Client has already been connected') && 
          !error.message?.includes('The client is already open')) {
        throw error;
      }
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.pgClient.end();
      await this.redisClient.disconnect();
    } catch (error) {
      console.warn('Error disconnecting from databases:', error);
    }
  }

  async initializeDatabase(): Promise<void> {
    // Ensure summarized_content table has the new columns
    const alterTableQuery = `
      ALTER TABLE summarized_content 
      ADD COLUMN IF NOT EXISTS crawled_content_id INTEGER REFERENCES crawled_content(id),
      ADD COLUMN IF NOT EXISTS chunk_group_id INTEGER REFERENCES chunk_groups(id),
      ADD COLUMN IF NOT EXISTS is_partial_summary BOOLEAN DEFAULT FALSE;
    `;
    
    await this.pgClient.query(alterTableQuery);
  }

  /**
   * Store partial summary in Redis FIFO queue
   */
  private async storePartialSummary(crawledContentId: number, partialSummary: SummarizedContent): Promise<void> {
    const queueKey = `partial_summaries:${crawledContentId}`;
    const summaryData = JSON.stringify(partialSummary);
    await this.redisClient.lPush(queueKey, summaryData);
    console.log(`📦 Stored partial summary in Redis queue: ${queueKey}`);
  }

  /**
   * Retrieve all partial summaries from Redis FIFO queue
   */
  private async getPartialSummaries(crawledContentId: number): Promise<SummarizedContent[]> {
    const queueKey = `partial_summaries:${crawledContentId}`;
    const summaryStrings = await this.redisClient.lRange(queueKey, 0, -1);
    
    // Reverse to get FIFO order (lPush adds to beginning, so we need to reverse)
    const partialSummaries = summaryStrings.reverse().map(str => {
      const summary = JSON.parse(str);
      // Convert date strings back to Date objects
      summary.crawled_at = new Date(summary.crawled_at);
      summary.summarized_at = new Date(summary.summarized_at);
      return summary;
    });
    
    console.log(`📤 Retrieved ${partialSummaries.length} partial summaries from Redis`);
    return partialSummaries;
  }

  /**
   * Clean up partial summaries from Redis after final summary is created
   */
  private async cleanupPartialSummaries(crawledContentId: number): Promise<void> {
    const queueKey = `partial_summaries:${crawledContentId}`;
    await this.redisClient.del(queueKey);
    console.log(`🧹 Cleaned up Redis queue: ${queueKey}`);
  }

  /**
   * Summarize a single chunk group
   */
  async summarizeChunkGroup(
    group: ChunkGroup, 
    contentTitle: string, 
    contentType: string,
    groupIndex: number,
    totalGroups: number
  ): Promise<SummarizedContent | null> {
    try {
      console.log(`🤖 Part ${groupIndex + 1}/${totalGroups}: ${contentTitle.substring(0, 50)}${contentTitle.length > 50 ? '...' : ''} (${group.combined_tokens} tokens)`);
      
      // Prepare context-aware prompt
      let systemPrompt = '';
      let userPrompt = '';
      
      const isMultiGroup = totalGroups > 1;
      const contextInfo = isMultiGroup ? 
        `This is part ${groupIndex + 1} of ${totalGroups} parts of the article "${contentTitle}".` : 
        `This is the complete article "${contentTitle}".`;

      if (contentType === 'code') {
        systemPrompt = `You are an expert technical content summarizer. You must respond in Myanmar/Burmese language only. Analyze the provided technical content and provide a summary focusing on main technical concepts, key code examples, and implementation details. ${contextInfo}`;
      } else {
        systemPrompt = `You are an expert content summarizer. You must respond in Myanmar/Burmese language only. Analyze the provided content and provide a summary focusing on main points, key information, and important insights. ${contextInfo}`;
      }

      userPrompt = `
${contextInfo}
Content Type: ${contentType}

Content to Summarize:
${group.combined_text.substring(0, 12000)} ${group.combined_text.length > 12000 ? '...[truncated]' : ''}

Please provide a summary in Myanmar/Burmese language in plain text format:
1. Write a 2-3 sentence summary in Burmese
2. List 3-5 key points in Burmese (use bullet points •)
3. Identify content category in English (Technology, Programming, AI/ML, Web Development, Data Science, etc.)
4. Sentiment analysis (positive/negative/neutral)

Format your response as JSON with Burmese text:
{
  "summary": "Your Burmese summary here",
  "keyPoints": ["Burmese point 1", "Burmese point 2", "Burmese point 3"],
  "category": "Category Name in English",
  "sentiment": "positive|negative|neutral"
}
`;

      const completion = await this.openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 3500,
        temperature: 0.3,
      });

      const responseContent = completion.choices[0]?.message?.content;
      if (!responseContent) {
        throw new Error('No response from OpenAI');
      }

      // Parse the JSON response
      let aiResponse;
      try {
        const cleanedResponse = responseContent.replace(/```json\s*|\s*```/g, '').trim();
        aiResponse = JSON.parse(cleanedResponse);
      } catch (parseError) {
        console.error('Failed to parse AI response as JSON:', responseContent);
        aiResponse = {
          summary: responseContent.substring(0, 500),
          keyPoints: ['Content analysis available'],
          category: contentType === 'code' ? 'Programming' : 'General',
          sentiment: 'neutral'
        };
      }

      return {
        url: '', // Will be filled by caller
        title: contentTitle,
        original_text: group.combined_text.substring(0, 10000),
        summary: aiResponse.summary || 'Summary not available',
        key_points: aiResponse.keyPoints || [],
        code_snippets: [], // Will be filled by caller
        content_type: contentType,
        sentiment: aiResponse.sentiment || 'neutral',
        category: aiResponse.category || 'General',
        crawled_at: new Date(),
        summarized_at: new Date(),
        chunk_group_id: group.id,
        is_partial_summary: totalGroups > 1
      };

    } catch (error) {
      console.error(`Error summarizing chunk group ${group.id}:`, error);
      return null;
    }
  }

  /**
   * Create a final summary from multiple partial summaries
   */
  async createFinalSummary(
    partialSummaries: SummarizedContent[],
    contentData: ContentWithGroups
  ): Promise<SummarizedContent | null> {
    if (partialSummaries.length === 1) {
      // Only one partial summary, make it the final summary
      const summary = partialSummaries[0];
      summary.is_partial_summary = false;
      return summary;
    }

    try {
      console.log(`🔄 Final summary: ${contentData.title.substring(0, 50)}${contentData.title.length > 50 ? '...' : ''} (${partialSummaries.length} parts)`);

      // Combine all partial summaries
      const combinedSummary = partialSummaries
        .map((s, i) => `Part ${i + 1}: ${s.summary}`)
        .join('\n\n');
      
      const combinedKeyPoints = partialSummaries
        .flatMap(s => s.key_points)
        .filter(point => point && point.trim().length > 0);

      const systemPrompt = `You are an expert content summarizer. You must respond in Myanmar/Burmese language only. You are given multiple partial summaries of an article. Create a cohesive final summary that captures the overall essence of the entire article.`;

      const userPrompt = `
Article: "${contentData.title}"
Content Type: ${contentData.content_type}

Partial Summaries:
${combinedSummary}

Combined Key Points:
${combinedKeyPoints.map((point, i) => `• ${point}`).join('\n')}

Please create a final cohesive summary in Myanmar/Burmese that captures the overall article:
1. Write a comprehensive 3-4 sentence summary in Burmese
2. Select and refine the most important 4-6 key points in Burmese
3. Determine the overall category and sentiment

Format your response as JSON with Burmese text:
{
  "summary": "Your comprehensive Burmese summary here",
  "keyPoints": ["Refined Burmese point 1", "Refined Burmese point 2", "Refined Burmese point 3"],
  "category": "Overall Category Name in English",
  "sentiment": "overall_sentiment"
}
`;

      console.log('🤖 Calling OpenAI for final summary...');
      const completion = await this.openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 1200,
        temperature: 0.3,
      });
      console.log('✅ OpenAI response received for final summary');

      const responseContent = completion.choices[0]?.message?.content;
      if (!responseContent) {
        throw new Error('No response from OpenAI');
      }

      let aiResponse;
      try {
        const cleanedResponse = responseContent.replace(/```json\s*|\s*```/g, '').trim();
        aiResponse = JSON.parse(cleanedResponse);
      } catch (parseError) {
        console.error('Failed to parse final summary response:', responseContent);
        // Fallback: combine the best partial summary
        const bestPartial = partialSummaries[0];
        aiResponse = {
          summary: bestPartial.summary,
          keyPoints: combinedKeyPoints.slice(0, 6),
          category: bestPartial.category,
          sentiment: bestPartial.sentiment
        };
      }

      return {
        url: contentData.url,
        title: contentData.title,
        original_text: partialSummaries.map(s => s.original_text).join('\n\n').substring(0, 15000),
        summary: aiResponse.summary || 'Final summary not available',
        key_points: aiResponse.keyPoints || combinedKeyPoints.slice(0, 6),
        code_snippets: [], // TODO: Extract from content
        content_type: contentData.content_type,
        sentiment: aiResponse.sentiment || partialSummaries[0].sentiment,
        category: aiResponse.category || partialSummaries[0].category,
        crawled_at: contentData.crawled_at,
        summarized_at: new Date(),
        crawled_content_id: contentData.id,
        is_partial_summary: false
      };

    } catch (error) {
      console.error('Error creating final summary:', error);
      return null;
    }
  }

  /**
   * Save summary to database
   */
  async saveSummary(summary: SummarizedContent): Promise<boolean> {
    try {
      const query = `
        INSERT INTO summarized_content (
          url, title, original_text, summary, key_points, code_snippets,
          content_type, sentiment, category, crawled_at, summarized_at,
          crawled_content_id, chunk_group_id, is_partial_summary
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (url) 
        DO UPDATE SET
          title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          key_points = EXCLUDED.key_points,
          content_type = EXCLUDED.content_type,
          sentiment = EXCLUDED.sentiment,
          category = EXCLUDED.category,
          summarized_at = EXCLUDED.summarized_at,
          crawled_content_id = EXCLUDED.crawled_content_id,
          is_partial_summary = EXCLUDED.is_partial_summary,
          updated_at = CURRENT_TIMESTAMP
      `;

      await this.pgClient.query(query, [
        summary.url,
        summary.title,
        summary.original_text,
        summary.summary,
        JSON.stringify(summary.key_points),
        JSON.stringify(summary.code_snippets),
        summary.content_type,
        summary.sentiment,
        summary.category,
        summary.crawled_at,
        summary.summarized_at,
        summary.crawled_content_id,
        summary.chunk_group_id,
        summary.is_partial_summary
      ]);

      return true;
    } catch (error) {
      console.error('Error saving summary to database:', error);
      return false;
    }
  }

  /**
   * Process a complete article (all its chunk groups)
   */
  async processArticle(contentData: ContentWithGroups): Promise<boolean> {
    try {
      console.log(`\n📝 Summarizing: ${contentData.title.substring(0, 60)}${contentData.title.length > 60 ? '...' : ''} (${contentData.groups.length} groups)`);

      let successfulSummaries = 0;

      // Summarize each chunk group and store in Redis
      for (const group of contentData.groups) {
        const partialSummary = await this.summarizeChunkGroup(
          group,
          contentData.title,
          contentData.content_type,
          group.group_index,
          contentData.groups.length
        );

        if (partialSummary) {
          partialSummary.url = contentData.url;
          partialSummary.crawled_content_id = contentData.id;
          partialSummary.crawled_at = contentData.crawled_at;
          
          // Store partial summary in Redis
          await this.storePartialSummary(contentData.id, partialSummary);
          successfulSummaries++;

          // Mark group as summarized
          await this.pgClient.query(
            "UPDATE chunk_groups SET status = 'summarized', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
            [group.id]
          );
          console.log(`✅ Part ${group.group_index + 1} completed`);
        } else {
          // Mark group as failed
          await this.pgClient.query(
            "UPDATE chunk_groups SET status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1",
            [group.id]
          );
          console.log(`❌ Part ${group.group_index + 1} failed`);
        }

        // Rate limiting delay
        await new Promise(resolve => setTimeout(resolve, 1500));
      }

      if (successfulSummaries === 0) {
        console.log(`❌ No successful summaries: ${contentData.title.substring(0, 40)}...`);
        return false;
      }

      // Retrieve partial summaries from Redis and create final summary
      console.log('🔄 Creating final summary...');
      const partialSummaries = await this.getPartialSummaries(contentData.id);
      const finalSummary = await this.createFinalSummary(partialSummaries, contentData);
      
      if (finalSummary) {
        console.log('💾 Saving final summary to database...');
        const saved = await this.saveSummary(finalSummary);
        if (saved) {
          // Clean up partial summaries from Redis
          await this.cleanupPartialSummaries(contentData.id);
          console.log(`✅ Final summary saved: ${contentData.title.substring(0, 50)}${contentData.title.length > 50 ? '...' : ''}`);
          return true;
        } else {
          console.log('❌ Failed to save final summary to database');
        }
      } else {
        console.log('❌ Failed to create final summary');
      }

      console.log(`❌ Failed final summary: ${contentData.title.substring(0, 40)}...`);
      return false;

    } catch (error) {
      console.error(`Error processing article ${contentData.id}:`, error);
      return false;
    }
  }

  /**
   * Process a batch of articles
   */
  async processBatch(): Promise<number> {
    try {
      await this.connect();

      // Get articles with pending chunk groups
      const result = await this.pgClient.query(`
        SELECT DISTINCT 
          cc.id, cc.url, cc.title, cc.content_type, cc.crawled_at, cc.created_at,
          COUNT(cg.id) as pending_groups
        FROM crawled_content cc
        JOIN chunk_groups cg ON cc.id = cg.crawled_content_id
        WHERE cg.status = 'pending'
        GROUP BY cc.id, cc.url, cc.title, cc.content_type, cc.crawled_at, cc.created_at
        ORDER BY cc.created_at ASC
        LIMIT $1
      `, [this.batchSize]);

      if (result.rows.length === 0) {
        return 0;
      }

      let successCount = 0;
      
      for (const row of result.rows) {
        // Get all pending groups for this article
        const groupsResult = await this.pgClient.query(`
          SELECT id, crawled_content_id, chunk_ids, group_index, combined_text, combined_tokens, status
          FROM chunk_groups 
          WHERE crawled_content_id = $1 AND status = 'pending'
          ORDER BY group_index ASC
        `, [row.id]);

        const contentData: ContentWithGroups = {
          id: row.id,
          url: row.url,
          title: row.title,
          content_type: row.content_type,
          crawled_at: row.crawled_at,
          groups: groupsResult.rows.map(groupRow => ({
            id: groupRow.id,
            crawled_content_id: groupRow.crawled_content_id,
            chunk_ids: groupRow.chunk_ids,
            group_index: groupRow.group_index,
            combined_text: groupRow.combined_text,
            combined_tokens: groupRow.combined_tokens,
            status: groupRow.status
          }))
        };

        if (await this.processArticle(contentData)) {
          successCount++;
        }
      }

      if (result.rows.length > 0) {
        console.log(`\n📊 Summarized: ${successCount}/${result.rows.length} articles\n`);
      }
      return successCount;

    } catch (error) {
      console.error('Error processing batch:', error);
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Chunk group summarizer worker already running');
      return;
    }

    this.isRunning = true;
    console.log('Starting chunk group summarizer worker...');

    while (this.isRunning) {
      try {
        const processedCount = await this.processBatch();

        if (processedCount === 0) {
          // No articles to process, wait before checking again
          await new Promise(resolve => setTimeout(resolve, 15000)); // 15 second wait
        } else {
          // Small delay between batches
          await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second wait
        }
      } catch (error) {
        console.error('Error in chunk group summarizer loop:', error);
        await new Promise(resolve => setTimeout(resolve, 30000)); // 30 second wait on error
      }
    }

    console.log('Chunk group summarizer worker stopped');
  }

  stop(): void {
    console.log('Stopping chunk group summarizer worker...');
    this.isRunning = false;
  }

  async getStatus(): Promise<{
    pendingGroupsCount: number;
    articlesReadyCount: number;
    totalSummariesCount: number;
    recentSummariesCount: number;
  }> {
    await this.connect();

    const [pendingGroups, articlesReady, totalSummaries, recentSummaries] = await Promise.all([
      this.pgClient.query("SELECT COUNT(*) as count FROM chunk_groups WHERE status = 'pending'"),
      this.pgClient.query(`
        SELECT COUNT(DISTINCT cc.id) as count 
        FROM crawled_content cc 
        JOIN chunk_groups cg ON cc.id = cg.crawled_content_id 
        WHERE cg.status = 'pending'
      `),
      this.pgClient.query('SELECT COUNT(*) as count FROM summarized_content WHERE is_partial_summary = false'),
      this.pgClient.query("SELECT COUNT(*) as count FROM summarized_content WHERE created_at > NOW() - INTERVAL '24 hours' AND is_partial_summary = false")
    ]);

    return {
      pendingGroupsCount: parseInt(pendingGroups.rows[0].count),
      articlesReadyCount: parseInt(articlesReady.rows[0].count),
      totalSummariesCount: parseInt(totalSummaries.rows[0].count),
      recentSummariesCount: parseInt(recentSummaries.rows[0].count),
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