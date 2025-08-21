import axios from 'axios';
import * as cheerio from 'cheerio';
import { createClient, RedisClientType } from 'redis';
import { Client as PgClient } from 'pg';
import dotenv from 'dotenv';
import { CrawledContent, estimateTokenCount } from '../types/chunking';

dotenv.config();

export class CrawlerDbWorker {
  private redisClient: RedisClientType;
  private pgClient: PgClient;
  private isRunning = false;
  private batchSize: number;
  private readonly maxContentLength = 200000; // Prevent extremely large content

  constructor() {
    this.batchSize = parseInt(process.env.BATCH_SIZE || '5', 10);
    
    // Redis for URL queue (input)
    this.redisClient = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379'
    });
    
    this.redisClient.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });

    // PostgreSQL for content storage (output)
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
    // Connect to Redis
    if (!this.redisClient.isOpen) {
      await this.redisClient.connect();
    }
    
    // Connect to PostgreSQL
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
    if (this.redisClient.isOpen) {
      await this.redisClient.disconnect();
    }
    
    try {
      await this.pgClient.end();
    } catch (error) {
      console.warn('Error disconnecting from PostgreSQL:', error);
    }
  }

  async initializeDatabase(): Promise<void> {
    // Ensure our tables exist
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS crawled_content (
        id SERIAL PRIMARY KEY,
        url VARCHAR(2048) UNIQUE NOT NULL,
        title VARCHAR(1000) NOT NULL,
        raw_text TEXT NOT NULL,
        code_snippets JSONB NOT NULL DEFAULT '[]',
        content_type VARCHAR(50) NOT NULL CHECK (content_type IN ('article', 'code', 'mixed')),
        total_tokens INTEGER,
        crawled_at TIMESTAMP NOT NULL,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'chunked', 'failed')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      CREATE INDEX IF NOT EXISTS idx_crawled_content_url ON crawled_content(url);
      CREATE INDEX IF NOT EXISTS idx_crawled_content_status ON crawled_content(status);
    `;
    
    await this.pgClient.query(createTableQuery);
  }

  async crawlUrl(url: string): Promise<CrawledContent | null> {
    try {
      console.log(`🕷️  ${url}`);
      
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)'
        },
        maxContentLength: this.maxContentLength
      });

      if (response.status !== 200) {
        console.log(`❌ Failed: ${url} (${response.status})`);
        return null;
      }

      const $ = cheerio.load(response.data);
      
      // Remove script, style, and other non-content elements
      $('script, style, nav, header, footer, aside, .advertisement, .ads').remove();
      
      // Extract title
      const title = $('title').text().trim() || 
                   $('h1').first().text().trim() || 
                   'No title found';

      // Extract main content
      let mainContent = '';
      const contentSelectors = [
        'article',
        '[role="main"]', 
        '.content',
        '.post-content',
        '.entry-content',
        '.article-content',
        'main',
        '.story-body'
      ];
      
      // Try to find main content area
      let $content = null;
      for (const selector of contentSelectors) {
        $content = $(selector);
        if ($content.length > 0 && $content.text().trim().length > 100) {
          break;
        }
      }
      
      // Fallback to body if no main content found
      if (!$content || $content.length === 0) {
        $content = $('body');
      }
      
      // Extract text content
      mainContent = $content.text()
        .replace(/\s+/g, ' ')
        .replace(/\n\s*\n/g, '\n')
        .trim();

      // Extract code snippets
      const codeSnippets: string[] = [];
      $content.find('pre, code, .highlight, .code-block').each((_, element) => {
        const codeText = $(element).text().trim();
        if (codeText.length > 10 && codeText.length < 5000) {
          if (this.looksLikeCode(codeText)) {
            codeSnippets.push(codeText);
          }
        }
      });

      // Determine content type
      let contentType: CrawledContent['content_type'] = 'article';
      if (codeSnippets.length > 0) {
        contentType = codeSnippets.length > 3 ? 'code' : 'mixed';
      }

      // Limit content length
      if (mainContent.length > this.maxContentLength) {
        mainContent = mainContent.substring(0, this.maxContentLength) + '...';
      }

      return {
        url,
        title: title.substring(0, 500), // Limit title length
        raw_text: mainContent,
        code_snippets: codeSnippets.slice(0, 10), // Limit number of code snippets
        content_type: contentType,
        total_tokens: estimateTokenCount(mainContent),
        crawled_at: new Date()
      };

    } catch (error) {
      console.log(`❌ Error: ${url} (${error instanceof Error ? error.message : 'Unknown error'})`);
      return null;
    }
  }

  private looksLikeCode(text: string): boolean {
    // Simple heuristics to identify code snippets
    const codeIndicators = [
      /\b(function|class|import|export|const|let|var)\s+/,
      /\b(if|else|for|while|return|try|catch)\s*\(/,
      /[{}();]\s*$/m,
      /^\s*[<>]/m, // HTML/XML tags
      /^\s*#include|^\s*import/m, // C/Python imports
      /^\s*def\s+\w+\s*\(/m, // Python functions
      /^\s*public\s+class/m, // Java classes
      /console\.(log|error|warn)/,
      /document\.(getElementById|querySelector)/
    ];

    return codeIndicators.some(pattern => pattern.test(text));
  }

  async saveCrawledContent(content: CrawledContent): Promise<number | null> {
    try {
      const query = `
        INSERT INTO crawled_content (
          url, title, raw_text, code_snippets, content_type, total_tokens, crawled_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (url) 
        DO UPDATE SET
          title = EXCLUDED.title,
          raw_text = EXCLUDED.raw_text,
          code_snippets = EXCLUDED.code_snippets,
          content_type = EXCLUDED.content_type,
          total_tokens = EXCLUDED.total_tokens,
          crawled_at = EXCLUDED.crawled_at,
          status = 'pending',
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `;

      const result = await this.pgClient.query(query, [
        content.url,
        content.title,
        content.raw_text,
        JSON.stringify(content.code_snippets),
        content.content_type,
        content.total_tokens,
        content.crawled_at
      ]);

      return result.rows[0]?.id || null;
    } catch (error) {
      console.error(`Error saving crawled content:`, error);
      return null;
    }
  }

  async processBatch(): Promise<number> {
    try {
      await this.connect();
      
      // Get batch of URLs from Redis queue (FIFO)
      const urls = await this.redisClient.lRange('url_queue', 0, this.batchSize - 1);
      
      if (urls.length === 0) {
        return 0;
      }
      
      // Remove processed URLs from queue
      await this.redisClient.lTrim('url_queue', urls.length, -1);
      
      if (urls.length > 0) {
        console.log(`\n📥 Processing ${urls.length} URLs:`);
      }
      
      // Crawl URLs in parallel (with some delay to be respectful)
      const crawlPromises = urls.map((url, index) => 
        new Promise<CrawledContent | null>(resolve => {
          setTimeout(async () => {
            resolve(await this.crawlUrl(url));
          }, index * 1000); // 1 second delay between requests
        })
      );
      
      const results = await Promise.all(crawlPromises);
      
      // Save successful crawls to database
      const validResults = results.filter((result): result is CrawledContent => result !== null);
      
      let savedCount = 0;
      for (const content of validResults) {
        const savedId = await this.saveCrawledContent(content);
        if (savedId) {
          savedCount++;
          console.log(`✅ Saved: ${content.title.substring(0, 60)}${content.title.length > 60 ? '...' : ''} (${content.total_tokens} tokens)`);
        }
      }
      
      if (urls.length > 0) {
        console.log(`📊 Crawled: ${savedCount}/${urls.length} successful\n`);
      }
      return savedCount;
      
    } catch (error) {
      console.error('Error processing batch:', error);
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Crawler worker already running');
      return;
    }
    
    this.isRunning = true;
    console.log('Starting database crawler worker...');
    
    while (this.isRunning) {
      try {
        const processedCount = await this.processBatch();
        
        if (processedCount === 0) {
          // No URLs to process, wait before checking again
          await new Promise(resolve => setTimeout(resolve, 10000)); // 10 second wait
        } else {
          // Small delay even when processing to be respectful to servers
          await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second wait
        }
      } catch (error) {
        console.error('Error in crawler worker loop:', error);
        await new Promise(resolve => setTimeout(resolve, 15000)); // 15 second wait on error
      }
    }
    
    console.log('Database crawler worker stopped');
  }

  stop(): void {
    console.log('Stopping database crawler worker...');
    this.isRunning = false;
  }

  async getStatus(): Promise<{
    urlQueueLength: number;
    pendingContentCount: number;
    totalCrawledCount: number;
  }> {
    await this.connect();
    
    const urlQueueLength = await this.redisClient.lLen('url_queue');
    
    // Get database stats
    const pendingResult = await this.pgClient.query("SELECT COUNT(*) as count FROM crawled_content WHERE status = 'pending'");
    const totalResult = await this.pgClient.query('SELECT COUNT(*) as count FROM crawled_content');
    
    return {
      urlQueueLength,
      pendingContentCount: parseInt(pendingResult.rows[0].count),
      totalCrawledCount: parseInt(totalResult.rows[0].count),
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