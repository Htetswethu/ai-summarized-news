import axios from 'axios';
import { createClient, RedisClientType } from 'redis';
import dotenv from 'dotenv';
import { HackerNewsItem } from '../types';

dotenv.config();

export class FetchUrlWorker {
  private readonly baseUrl = 'https://hacker-news.firebaseio.com/v0';
  private readonly axiosInstance;
  private redisClient: RedisClientType;
  private isRunning = false;
  private batchSize: number;
  
  private readonly luaPushUrls = `
    local url_queue_key = KEYS[1]
    local processed_set_key = KEYS[2]
    local urls = ARGV
    
    local new_urls = {}
    for i = 1, #urls do
      local url = urls[i]
      if url and url ~= "" then
        local is_new = redis.call('SADD', processed_set_key, url)
        if is_new == 1 then
          table.insert(new_urls, url)
        end
      end
    end
    
    if #new_urls > 0 then
      redis.call('RPUSH', url_queue_key, unpack(new_urls))
      redis.call('EXPIRE', url_queue_key, 86400)
    end
    
    redis.call('EXPIRE', processed_set_key, 86400)
    
    return #new_urls
  `;

  constructor() {
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
    });
    
    this.batchSize = parseInt(process.env.BATCH_SIZE || '10', 10);
    
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

  async fetchItemById(id: number): Promise<HackerNewsItem | null> {
    try {
      const response = await this.axiosInstance.get<HackerNewsItem>(`/item/${id}.json`);
      return response.data;
    } catch (error) {
      console.error(`Error fetching item ${id}:`, error);
      return null;
    }
  }

  async processBatch(): Promise<number> {
    try {
      await this.connect();
      
      // Get batch of IDs from queue (FIFO)
      const ids = await this.redisClient.lRange('ids_queue', 0, this.batchSize - 1);
      
      if (ids.length === 0) {
        return 0;
      }
      
      // Remove processed IDs from queue
      await this.redisClient.lTrim('ids_queue', ids.length, -1);
      
      // Fetch items in parallel
      const itemPromises = ids.map(id => this.fetchItemById(parseInt(id, 10)));
      const items = await Promise.all(itemPromises);
      
      // Extract URLs from valid items
      const urls: string[] = [];
      let validItemsCount = 0;
      
      for (const item of items) {
        if (item && item.url && item.type === 'story') {
          urls.push(item.url);
          validItemsCount++;
        }
      }
      
      let newUrlsCount = 0;
      if (urls.length > 0) {
        // Push URLs to queue with deduplication
        newUrlsCount = await this.redisClient.eval(
          this.luaPushUrls,
          {
            keys: ['url_queue', 'processed_urls'],
            arguments: urls
          }
        ) as number;
      }
      
      console.log(`Processed ${ids.length} IDs -> ${validItemsCount} valid stories -> ${newUrlsCount} new URLs added to queue`);
      return newUrlsCount;
      
    } catch (error) {
      console.error('Error processing batch:', error);
      throw error;
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('Worker already running');
      return;
    }
    
    this.isRunning = true;
    console.log('Starting URL fetch worker...');
    
    while (this.isRunning) {
      try {
        const processedCount = await this.processBatch();
        
        if (processedCount === 0) {
          // No items to process, wait before checking again
          await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second wait
        }
      } catch (error) {
        console.error('Error in worker loop:', error);
        await new Promise(resolve => setTimeout(resolve, 10000)); // 10 second wait on error
      }
    }
    
    console.log('URL fetch worker stopped');
  }

  stop(): void {
    console.log('Stopping URL fetch worker...');
    this.isRunning = false;
  }

  async getQueueStatus(): Promise<{
    idsQueueLength: number;
    urlQueueLength: number;
    processedUrlsCount: number;
  }> {
    await this.connect();
    
    const [idsQueueLength, urlQueueLength, processedUrlsCount] = await Promise.all([
      this.redisClient.lLen('ids_queue'),
      this.redisClient.lLen('url_queue'),
      this.redisClient.sCard('processed_urls')
    ]);
    
    return {
      idsQueueLength,
      urlQueueLength,
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