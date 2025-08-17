import { createClient, RedisClientType } from 'redis';
import { Client as PgClient } from 'pg';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

interface CrawledContent {
  url: string;
  title: string;
  text: string;
  codeSnippets: string[];
  timestamp: number;
  contentType: 'article' | 'code' | 'mixed';
}

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
}

export class AiSummarizerWorker {
  private redisClient: RedisClientType;
  private pgClient: PgClient;
  private openai: OpenAI;
  private isRunning = false;
  private batchSize: number;

  constructor() {
    this.batchSize = parseInt(process.env.BATCH_SIZE || '3', 10);
    
    // Redis client
    this.redisClient = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379'
    });
    
    this.redisClient.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });

    // PostgreSQL client
    this.pgClient = new PgClient({
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DB,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      ssl: process.env.POSTGRES_SSL === 'true' ? { rejectUnauthorized: false } : false,
    });

    // OpenAI client (configured for OpenRouter)
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    });
  }

  async connect(): Promise<void> {
    // Connect to Redis
    if (!this.redisClient.isOpen) {
      await this.redisClient.connect();
    }
    
    // Connect to PostgreSQL (will only connect if not already connected)
    try {
      await this.pgClient.connect();
      await this.initializeDatabase();
    } catch (error: any) {
      // If already connected, ignore the error
      if (!error.message?.includes('Client has already been connected')) {
        throw error;
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.redisClient.isOpen) {
      await this.redisClient.disconnect();
    }
    
    try {
      await this.pgClient.end();
    } catch (error) {
      // Ignore errors when disconnecting
      console.warn('Error disconnecting from PostgreSQL:', error);
    }
  }

  async initializeDatabase(): Promise<void> {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS summarized_content (
        id SERIAL PRIMARY KEY,
        url VARCHAR(2048) UNIQUE NOT NULL,
        title VARCHAR(1000) NOT NULL,
        original_text TEXT NOT NULL,
        summary TEXT NOT NULL,
        key_points JSONB NOT NULL,
        code_snippets JSONB NOT NULL,
        content_type VARCHAR(50) NOT NULL,
        sentiment VARCHAR(20) NOT NULL,
        category VARCHAR(100) NOT NULL,
        crawled_at TIMESTAMP NOT NULL,
        summarized_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_summarized_content_url ON summarized_content(url);
      CREATE INDEX IF NOT EXISTS idx_summarized_content_category ON summarized_content(category);
      CREATE INDEX IF NOT EXISTS idx_summarized_content_sentiment ON summarized_content(sentiment);
      CREATE INDEX IF NOT EXISTS idx_summarized_content_created_at ON summarized_content(created_at);
    `;
    
    await this.pgClient.query(createTableQuery);
    console.log('Database tables initialized');
  }

  async summarizeContent(content: CrawledContent): Promise<SummarizedContent | null> {
    try {
      console.log(`Summarizing content: ${content.title}`);
      
      // Prepare the prompt based on content type
      let systemPrompt = '';
      let userPrompt = '';
      
      if (content.contentType === 'code') {
        systemPrompt = `You are an expert technical content summarizer. You must respond in Myanmar/Burmese language only. Analyze the provided technical article/documentation and provide a summary focusing on main technical concepts, key code examples, practical applications, and important implementation details.`;
      } else {
        systemPrompt = `You are an expert content summarizer. You must respond in Myanmar/Burmese language only. Analyze the provided article and provide a summary focusing on main points, key information, important insights, and practical implications.`;
      }

      userPrompt = `
Title: ${content.title}
Content Type: ${content.contentType}
${content.codeSnippets.length > 0 ? `Code Snippets Found: ${content.codeSnippets.length}` : ''}

Content:
${content.text.substring(0, 8000)} ${content.text.length > 8000 ? '...[truncated]' : ''}

${content.codeSnippets.length > 0 ? `\nCode Snippets:\n${content.codeSnippets.slice(0, 3).join('\n\n---\n\n')}` : ''}

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
        max_tokens: 1000,
        temperature: 0.3,
      });

      const responseContent = completion.choices[0]?.message?.content;
      if (!responseContent) {
        throw new Error('No response from OpenAI');
      }

      // Parse the JSON response
      let aiResponse;
      try {
        aiResponse = JSON.parse(responseContent);
      } catch (parseError) {
        console.error('Failed to parse AI response as JSON:', responseContent);
        // Fallback: create a basic response
        aiResponse = {
          summary: responseContent.substring(0, 500),
          keyPoints: ['Content analysis available'],
          category: content.contentType === 'code' ? 'Programming' : 'General',
          sentiment: 'neutral'
        };
      }

      const summarizedContent: SummarizedContent = {
        url: content.url,
        title: content.title,
        original_text: content.text.substring(0, 10000), // Limit stored text
        summary: aiResponse.summary || 'Summary not available',
        key_points: aiResponse.keyPoints || [],
        code_snippets: content.codeSnippets,
        content_type: content.contentType,
        sentiment: aiResponse.sentiment || 'neutral',
        category: aiResponse.category || 'General',
        crawled_at: new Date(content.timestamp),
        summarized_at: new Date(),
      };

      return summarizedContent;

    } catch (error) {
      console.error(`Error summarizing content for ${content.url}:`, error);
      return null;
    }
  }

  async saveToDatabase(content: SummarizedContent): Promise<boolean> {
    try {
      const query = `
        INSERT INTO summarized_content (
          url, title, original_text, summary, key_points, code_snippets,
          content_type, sentiment, category, crawled_at, summarized_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (url) 
        DO UPDATE SET
          title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          key_points = EXCLUDED.key_points,
          content_type = EXCLUDED.content_type,
          sentiment = EXCLUDED.sentiment,
          category = EXCLUDED.category,
          summarized_at = EXCLUDED.summarized_at,
          updated_at = CURRENT_TIMESTAMP
      `;

      await this.pgClient.query(query, [
        content.url,
        content.title,
        content.original_text,
        content.summary,
        JSON.stringify(content.key_points),
        JSON.stringify(content.code_snippets),
        content.content_type,
        content.sentiment,
        content.category,
        content.crawled_at,
        content.summarized_at,
      ]);

      return true;
    } catch (error) {
      console.error(`Error saving to database:`, error);
      return false;
    }
  }

  async processBatch(): Promise<number> {
    try {
      await this.connect();
      
      // Get batch of content from Redis queue (FIFO)
      const contentStrings = await this.redisClient.lRange('crawled_content_queue', 0, this.batchSize - 1);
      
      if (contentStrings.length === 0) {
        return 0;
      }
      
      // Remove processed content from queue
      await this.redisClient.lTrim('crawled_content_queue', contentStrings.length, -1);
      
      console.log(`Processing batch of ${contentStrings.length} content items`);
      
      let successCount = 0;
      
      for (const contentString of contentStrings) {
        try {
          const content: CrawledContent = JSON.parse(contentString);
          
          // Summarize content using AI
          const summarizedContent = await this.summarizeContent(content);
          
          if (summarizedContent) {
            // Save to PostgreSQL
            const saved = await this.saveToDatabase(summarizedContent);
            if (saved) {
              successCount++;
              console.log(`✅ Successfully processed: ${content.title}`);
            }
          }
          
          // Add delay between API calls to respect rate limits
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (error) {
          console.error('Error processing individual content item:', error);
        }
      }
      
      console.log(`Processed ${contentStrings.length} items -> ${successCount} successfully saved to database`);
      return successCount;
      
    } catch (error) {
      console.error('Error processing batch:', error);
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('AI Summarizer worker already running');
      return;
    }
    
    this.isRunning = true;
    console.log('Starting AI Summarizer worker...');
    
    while (this.isRunning) {
      try {
        const processedCount = await this.processBatch();
        
        if (processedCount === 0) {
          // No content to process, wait before checking again
          await new Promise(resolve => setTimeout(resolve, 15000)); // 15 second wait
        } else {
          // Small delay between batches
          await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second wait
        }
      } catch (error) {
        console.error('Error in AI Summarizer worker loop:', error);
        await new Promise(resolve => setTimeout(resolve, 30000)); // 30 second wait on error
      }
    }
    
    console.log('AI Summarizer worker stopped');
  }

  stop(): void {
    console.log('Stopping AI Summarizer worker...');
    this.isRunning = false;
  }

  async getStatus(): Promise<{
    contentQueueLength: number;
    totalSummarizedCount: number;
    recentSummariesCount: number;
  }> {
    await this.connect();
    
    const contentQueueLength = await this.redisClient.lLen('crawled_content_queue');
    
    // Get database stats
    const totalResult = await this.pgClient.query('SELECT COUNT(*) as count FROM summarized_content');
    const recentResult = await this.pgClient.query(
      'SELECT COUNT(*) as count FROM summarized_content WHERE created_at > NOW() - INTERVAL \'24 hours\''
    );
    
    return {
      contentQueueLength,
      totalSummarizedCount: parseInt(totalResult.rows[0].count),
      recentSummariesCount: parseInt(recentResult.rows[0].count),
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