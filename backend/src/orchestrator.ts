import { FetchNewsService } from './services/fetchNewsService';
import { FetchUrlWorker } from './workers/fetchUrl';
import { CrawlerWorker } from './workers/crawler';
import { AiSummarizerWorker } from './workers/aiSummarizer';
import dotenv from 'dotenv';

dotenv.config();

export class NewsOrchestrator {
  private fetchNewsService: FetchNewsService;
  private fetchUrlWorker: FetchUrlWorker;
  private crawlerWorker: CrawlerWorker;
  private aiSummarizerWorker: AiSummarizerWorker;
  
  constructor() {
    this.fetchNewsService = new FetchNewsService();
    this.fetchUrlWorker = new FetchUrlWorker();
    this.crawlerWorker = new CrawlerWorker();
    this.aiSummarizerWorker = new AiSummarizerWorker();
  }

  async start(): Promise<void> {
    console.log('🚀 Starting AI Summarized News Pipeline...\n');
    
    try {
      // Start all services concurrently
      await Promise.all([
        this.startFetchNewsService(),
        this.startFetchUrlWorker(),
        this.startCrawlerWorker(),
        this.startAiSummarizerWorker()
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

  private async startCrawlerWorker(): Promise<void> {
    console.log('🕷️  Starting web crawler worker...');
    await this.crawlerWorker.start();
  }

  private async startAiSummarizerWorker(): Promise<void> {
    console.log('🤖 Starting AI summarizer worker...');
    await this.aiSummarizerWorker.start();
  }

  async stop(): Promise<void> {
    console.log('\n🛑 Stopping all workers...');
    
    await Promise.all([
      this.fetchNewsService.cleanup(),
      this.fetchUrlWorker.cleanup(),
      this.crawlerWorker.cleanup(),
      this.aiSummarizerWorker.cleanup()
    ]);
    
    console.log('✅ All workers stopped cleanly');
  }

  async getStatus(): Promise<void> {
    try {
      console.log('\n📊 Pipeline Status:');
      console.log('=================');
      
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
      
      // Crawler Status
      const crawlerStatus = await this.crawlerWorker.getQueueStatus();
      console.log('\n🕷️  Crawler:');
      console.log(`   - Running: ${this.crawlerWorker.isWorkerRunning()}`);
      console.log(`   - URLs queue: ${crawlerStatus.urlQueueLength}`);
      console.log(`   - Content queue: ${crawlerStatus.contentQueueLength}`);
      console.log(`   - Processed URLs: ${crawlerStatus.processedUrlsCount}`);
      
      // AI Summarizer Status
      const aiStatus = await this.aiSummarizerWorker.getStatus();
      console.log('\n🤖 AI Summarizer:');
      console.log(`   - Running: ${this.aiSummarizerWorker.isWorkerRunning()}`);
      console.log(`   - Content queue: ${aiStatus.contentQueueLength}`);
      console.log(`   - Total summaries: ${aiStatus.totalSummarizedCount}`);
      console.log(`   - Recent (24h): ${aiStatus.recentSummariesCount}`);
      
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