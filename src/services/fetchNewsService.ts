import axios from "axios";
import { createClient, RedisClientType } from "redis";
import dotenv from "dotenv";

dotenv.config();

export class FetchNewsService {
  private readonly baseUrl = "https://hacker-news.firebaseio.com/v0";
  private readonly axiosInstance;
  private readonly apiRateLimit: number;
  private redisClient: RedisClientType;
  private fetchInterval: NodeJS.Timeout | null = null;
  private readonly intervalMs = 10 * 60 * 1000; // 10 minutes

  private readonly luaDeduplicateAndPush = `
    local queue_key = KEYS[1]
    local seen_set_key = KEYS[2]
    local story_ids = ARGV
    
    local new_ids = {}
    for i = 1, #story_ids do
      local id = story_ids[i]
      local is_new = redis.call('SADD', seen_set_key, id)
      if is_new == 1 then
        table.insert(new_ids, id)
      end
    end
    
    if #new_ids > 0 then
      redis.call('RPUSH', queue_key, unpack(new_ids))
      redis.call('EXPIRE', queue_key, 86400)
    end
    
    redis.call('EXPIRE', seen_set_key, 86400)
    
    return #new_ids
  `;

  constructor() {
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout: 10000,
    });
    this.apiRateLimit = parseInt(process.env.API_RATE_LIMIT || "100", 10);

    this.redisClient = createClient({
      url: process.env.REDIS_URL || "redis://localhost:6379",
    });

    this.redisClient.on("error", (err) => {
      console.error("Redis Client Error:", err);
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

  async fetchTopStoryIds(): Promise<number> {
    try {
      await this.connect();

      const response = await this.axiosInstance.get<number[]>(
        "/topstories.json"
      );
      const allIds = response.data.slice(0, this.apiRateLimit);

      if (allIds.length === 0) {
        return 0;
      }

      const newIdsCount = (await this.redisClient.eval(
        this.luaDeduplicateAndPush,
        {
          keys: ["ids_queue", "seen_story_ids"],
          arguments: allIds.map((id) => id.toString()),
        }
      )) as number;

      console.log(
        `Fetched ${allIds.length} story IDs, ${newIdsCount} new IDs added to queue`
      );
      return newIdsCount;
    } catch (error) {
      console.error("Error fetching top story IDs:", error);
      throw new Error("Failed to fetch top story IDs from Hacker News API");
    }
  }

  async getQueueLength(): Promise<number> {
    await this.connect();
    return await this.redisClient.lLen("ids_queue");
  }

  async getSeenCount(): Promise<number> {
    await this.connect();
    return await this.redisClient.sCard("seen_story_ids");
  }

  getApiRateLimit(): number {
    return this.apiRateLimit;
  }

  async startFetchInterval(): Promise<void> {
    if (this.fetchInterval) {
      console.log("Fetch interval already running");
      return;
    }

    console.log(
      "Starting fetch interval - will fetch stories every 10 minutes"
    );

    // Fetch immediately on start
    try {
      await this.fetchTopStoryIds();
    } catch (error) {
      console.error("Error in initial fetch:", error);
    }

    // Set up interval
    this.fetchInterval = setInterval(async () => {
      try {
        console.log("Scheduled fetch starting...");
        await this.fetchTopStoryIds();
      } catch (error) {
        console.error("Error in scheduled fetch:", error);
      }
    }, this.intervalMs);

    console.log(
      `Fetch interval started - next fetch in ${this.intervalMs / 1000} seconds`
    );
  }

  stopFetchInterval(): void {
    if (this.fetchInterval) {
      clearInterval(this.fetchInterval);
      this.fetchInterval = null;
      console.log("Fetch interval stopped");
    }
  }

  isIntervalRunning(): boolean {
    return this.fetchInterval !== null;
  }

  async cleanup(): Promise<void> {
    this.stopFetchInterval();
    await this.disconnect();
  }
}
