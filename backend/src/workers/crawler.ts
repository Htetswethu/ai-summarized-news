import axios from 'axios';
import * as cheerio from 'cheerio';
import { createClient, RedisClientType } from 'redis';
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

export class CrawlerWorker {
  private redisClient: RedisClientType;
  private isRunning = false;
  private batchSize: number;
  private readonly maxContentLength = 200000; // Prevent extremely large content
  
  private readonly luaPushContent = `
    local content_queue_key = KEYS[1]
    local processed_urls_key = KEYS[2]
    local contents = ARGV
    
    local new_contents = {}
    for i = 1, #contents do
      local content = contents[i]
      if content and content ~= "" then
        local content_data = cjson.decode(content)
        local url = content_data.url
        local is_new = redis.call('SADD', processed_urls_key, url)
        if is_new == 1 then
          table.insert(new_contents, content)
        end
      end
    end
    
    if #new_contents > 0 then
      redis.call('RPUSH', content_queue_key, unpack(new_contents))
      redis.call('EXPIRE', content_queue_key, 86400)
    end
    
    redis.call('EXPIRE', processed_urls_key, 86400)
    
    return #new_contents
  `;

  constructor() {
    this.batchSize = parseInt(process.env.BATCH_SIZE || '5', 10);
    
    this.redisClient = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379'
    });
    
    this.redisClient.on('error', (err) => {
      console.error('Redis Client Error:', err);
    });
  }

  async connect(): Promise<void> {
    if (!this.redisClient.isOpen) {
      await this.redisClient.connect();
    }
  }

  async disconnect(): Promise<void> {
    if (this.redisClient.isOpen) {
      await this.redisClient.disconnect();
    }
  }

  async crawlUrl(url: string): Promise<CrawledContent | null> {
    try {
      console.log(`Crawling: ${url}`);
      
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)'
        },
        maxContentLength: this.maxContentLength
      });

      if (response.status !== 200) {
        console.warn(`Failed to fetch ${url}: Status ${response.status}`);
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
          // Simple heuristics to identify code
          if (this.looksLikeCode(codeText)) {
            codeSnippets.push(codeText);
          }
        }
      });

      // Determine content type
      let contentType: CrawledContent['contentType'] = 'article';
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
        text: mainContent,
        codeSnippets: codeSnippets.slice(0, 10), // Limit number of code snippets
        timestamp: Date.now(),
        contentType
      };

    } catch (error) {
      console.error(`Error crawling ${url}:`, error);
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

  async processBatch(): Promise<number> {
    try {
      await this.connect();
      
      // Get batch of URLs from queue (FIFO)
      const urls = await this.redisClient.lRange('url_queue', 0, this.batchSize - 1);
      
      if (urls.length === 0) {
        return 0;
      }
      
      // Remove processed URLs from queue
      await this.redisClient.lTrim('url_queue', urls.length, -1);
      
      console.log(`Processing batch of ${urls.length} URLs`);
      
      // Crawl URLs in parallel (but with some delay to be respectful)
      const crawlPromises = urls.map((url, index) => 
        new Promise<CrawledContent | null>(resolve => {
          setTimeout(async () => {
            resolve(await this.crawlUrl(url));
          }, index * 1000); // 1 second delay between requests
        })
      );
      
      const results = await Promise.all(crawlPromises);
      
      // Filter successful crawls and prepare for Redis
      const validResults = results.filter((result): result is CrawledContent => result !== null);
      
      let newContentCount = 0;
      if (validResults.length > 0) {
        const serializedContent = validResults.map(content => JSON.stringify(content));
        
        // Push content to queue with deduplication
        newContentCount = await this.redisClient.eval(
          this.luaPushContent,
          {
            keys: ['crawled_content_queue', 'processed_content_urls'],
            arguments: serializedContent
          }
        ) as number;
      }
      
      console.log(`Processed ${urls.length} URLs -> ${validResults.length} successful crawls -> ${newContentCount} new content items added to queue`);
      return newContentCount;
      
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
    console.log('Starting crawler worker...');
    
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
    
    console.log('Crawler worker stopped');
  }

  stop(): void {
    console.log('Stopping crawler worker...');
    this.isRunning = false;
  }

  async getQueueStatus(): Promise<{
    urlQueueLength: number;
    contentQueueLength: number;
    processedUrlsCount: number;
  }> {
    await this.connect();
    
    const [urlQueueLength, contentQueueLength, processedUrlsCount] = await Promise.all([
      this.redisClient.lLen('url_queue'),
      this.redisClient.lLen('crawled_content_queue'),
      this.redisClient.sCard('processed_content_urls')
    ]);
    
    return {
      urlQueueLength,
      contentQueueLength,
      processedUrlsCount
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