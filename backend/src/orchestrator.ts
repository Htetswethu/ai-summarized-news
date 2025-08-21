import { FetchNewsService } from './services/fetchNewsService';
import { FetchUrlWorker } from './workers/fetchUrl';
import { CrawlerDbWorker } from './workers/crawlerDb';
import { ContentChunkerWorker } from './workers/contentChunker';
import { ChunkGroupSummarizerWorker } from './workers/chunkGroupSummarizer';
import dotenv from 'dotenv';

dotenv.config();

export class NewsOrchestrator {
  private fetchNewsService: FetchNewsService;
  private fetchUrlWorker: FetchUrlWorker;
  private crawlerDbWorker: CrawlerDbWorker;
  private contentChunkerWorker: ContentChunkerWorker;
  private chunkGroupSummarizerWorker: ChunkGroupSummarizerWorker;
  
  constructor() {
    this.fetchNewsService = new FetchNewsService();
    this.fetchUrlWorker = new FetchUrlWorker();
    this.crawlerDbWorker = new CrawlerDbWorker();
    this.contentChunkerWorker = new ContentChunkerWorker();
    this.chunkGroupSummarizerWorker = new ChunkGroupSummarizerWorker();
  }

  async start(): Promise<void> {
    console.log('🚀 Starting AI Summarized News Pipeline (Chunked Version)...\n');
    
    try {
      // Start all services concurrently
      await Promise.all([
        this.startFetchNewsService(),
        this.startFetchUrlWorker(),
        this.startCrawlerDbWorker(),
        this.startContentChunkerWorker(),
        this.startChunkGroupSummarizerWorker()
      ]);
    } catch (error) {
      console.error('❌ Error starting services:', error);
      await this.stop();
    }
  }

  private async startFetchNewsService(): Promise<void> {
    console.log('📰 Starting Hacker News fetcher (every 10 minutes)...');
    await this.fetchNewsService.startFetchInterval();
  }

  private async startFetchUrlWorker(): Promise<void> {
    console.log('🔗 Starting URL fetch worker...');
    await this.fetchUrlWorker.start();
  }

  private async startCrawlerDbWorker(): Promise<void> {
    console.log('🕷️  Starting database crawler worker...');
    await this.crawlerDbWorker.start();
  }

  private async startContentChunkerWorker(): Promise<void> {
    console.log('✂️  Starting content chunker worker...');
    await this.contentChunkerWorker.start();
  }

  private async startChunkGroupSummarizerWorker(): Promise<void> {
    console.log('🤖 Starting chunk group summarizer worker...');
    await this.chunkGroupSummarizerWorker.start();
  }

  async stop(): Promise<void> {
    console.log('\n🛑 Stopping all workers...');
    
    await Promise.all([
      this.fetchNewsService.cleanup(),
      this.fetchUrlWorker.cleanup(),
      this.crawlerDbWorker.cleanup(),
      this.contentChunkerWorker.cleanup(),
      this.chunkGroupSummarizerWorker.cleanup()
    ]);
    
    console.log('✅ All workers stopped cleanly');
  }

  async getStatus(): Promise<void> {
    try {
      console.log('\n📊 Chunked Pipeline Status:');
      console.log('===========================');
      
      // Fetch News Service Status
      const fetchStatus = {
        intervalRunning: this.fetchNewsService.isIntervalRunning(),
        queueLength: await this.fetchNewsService.getQueueLength(),
        seenCount: await this.fetchNewsService.getSeenCount(),
        rateLimit: this.fetchNewsService.getApiRateLimit()
      };
      
      console.log('📰 News Fetcher:');
      console.log(`   - Interval running: ${fetchStatus.intervalRunning}`);
      console.log(`   - IDs in queue: ${fetchStatus.queueLength}`);
      console.log(`   - Stories seen: ${fetchStatus.seenCount}`);
      console.log(`   - Rate limit: ${fetchStatus.rateLimit}`);
      
      // URL Worker Status
      const urlStatus = await this.fetchUrlWorker.getQueueStatus();
      console.log('\n🔗 URL Worker:');
      console.log(`   - Running: ${this.fetchUrlWorker.isWorkerRunning()}`);
      console.log(`   - IDs queue: ${urlStatus.idsQueueLength}`);
      console.log(`   - URLs queue: ${urlStatus.urlQueueLength}`);
      console.log(`   - Processed URLs: ${urlStatus.processedUrlsCount}`);
      
      // Database Crawler Status
      const crawlerStatus = await this.crawlerDbWorker.getStatus();
      console.log('\n🕷️  Database Crawler:');
      console.log(`   - Running: ${this.crawlerDbWorker.isWorkerRunning()}`);
      console.log(`   - URLs queue: ${crawlerStatus.urlQueueLength}`);
      console.log(`   - Pending content: ${crawlerStatus.pendingContentCount}`);
      console.log(`   - Total crawled: ${crawlerStatus.totalCrawledCount}`);
      
      // Content Chunker Status
      const chunkerStatus = await this.contentChunkerWorker.getStatus();
      console.log('\n✂️  Content Chunker:');
      console.log(`   - Running: ${this.contentChunkerWorker.isWorkerRunning()}`);
      console.log(`   - Pending content: ${chunkerStatus.pendingContentCount}`);
      console.log(`   - Chunked content: ${chunkerStatus.chunkedContentCount}`);
      console.log(`   - Total chunks: ${chunkerStatus.totalChunksCount}`);
      console.log(`   - Pending groups: ${chunkerStatus.pendingGroupsCount}`);
      
      // Chunk Group Summarizer Status
      const summarizerStatus = await this.chunkGroupSummarizerWorker.getStatus();
      console.log('\n🤖 Chunk Group Summarizer:');
      console.log(`   - Running: ${this.chunkGroupSummarizerWorker.isWorkerRunning()}`);
      console.log(`   - Pending groups: ${summarizerStatus.pendingGroupsCount}`);
      console.log(`   - Articles ready: ${summarizerStatus.articlesReadyCount}`);
      console.log(`   - Total summaries: ${summarizerStatus.totalSummariesCount}`);
      console.log(`   - Recent (24h): ${summarizerStatus.recentSummariesCount}`);
      
      // Pipeline Health Summary
      console.log('\n🏥 Pipeline Health:');
      const totalPendingWork = 
        fetchStatus.queueLength + 
        urlStatus.idsQueueLength + 
        urlStatus.urlQueueLength + 
        crawlerStatus.pendingContentCount + 
        chunkerStatus.pendingContentCount + 
        summarizerStatus.pendingGroupsCount;
      
      console.log(`   - Total pending work: ${totalPendingWork} items`);
      console.log(`   - Articles processed today: ${summarizerStatus.recentSummariesCount}`);
      console.log(`   - Pipeline status: ${totalPendingWork > 0 ? '🔄 Processing' : '✅ Idle'}`);
      
    } catch (error) {
      console.error('Error getting status:', error);
    }
  }

  async runStatusLoop(): Promise<void> {
    // Show status every 30 seconds
    setInterval(async () => {
      await this.getStatus();
    }, 30000);
  }
}

// Global orchestrator reference for cleanup
let globalOrchestrator: NewsOrchestrator | null = null;

// Handle graceful shutdown for signal interupt received - Ctrl+C in terminal
process.on('SIGINT', async () => {
  console.log('\n⚡ Received SIGINT, shutting down gracefully...');
  if (globalOrchestrator) {
    await globalOrchestrator.stop();
  }
  process.exit(0);
});

// Handle graceful shutdown for signal terminate received - docker or system shutdown
process.on('SIGTERM', async () => {
  console.log('\n⚡ Received SIGTERM, shutting down gracefully...');
  if (globalOrchestrator) {
    await globalOrchestrator.stop();
  }
  process.exit(0);
});

// Main execution
async function main() {
  const orchestrator = new NewsOrchestrator();
  globalOrchestrator = orchestrator;
  
  // Show initial status
  console.log('📋 Checking initial pipeline status...');
  await orchestrator.getStatus();
  
  // Start status monitoring
  orchestrator.runStatusLoop();
  
  // Start the pipeline
  await orchestrator.start();
}

if (require.main === module) {
  main().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  });
}