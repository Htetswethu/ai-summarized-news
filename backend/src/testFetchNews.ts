// backend/src/testFetchNews.ts
import { FetchNewsService } from "./services/fetchNewsService";

async function main() {
  const fetcher = new FetchNewsService();
  try {
    const newIdsCount = await fetcher.fetchTopStoryIds();
    console.log(
      `Fetched and added ${newIdsCount} new story IDs to Redis queue.`
    );
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await fetcher.disconnect();
  }
}

main();
