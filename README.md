# AI Summarized News

Automated news aggregation and summarization platform that fetches stories from Hacker News, crawls their content, and generates AI-powered summaries.

## Features

- Fetches top stories from Hacker News API every 10 minutes
- Crawls article content and extracts text
- Generates AI summaries using OpenAI GPT
- Categorizes content and analyzes sentiment
- Web dashboard to browse summarized articles
- REST API to serve content

## Setup

### Prerequisites
- Node.js 18+
- Redis server
- PostgreSQL database
- OpenAI API key

### 1. Environment Setup

Create `.env` file in `/backend`:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/ai_news
REDIS_URL=redis://localhost:6379
OPENAI_API_KEY=your_openai_api_key
```

### 2. Install Dependencies

```bash
# Backend
cd backend
npm install

# Frontend
cd frontend
npm install
```

### 3. Run

```bash
# Start backend API
cd backend
npm run dev

# Start processing pipeline
cd backend
npm run pipeline

# Start frontend
cd frontend
npm run dev
```

## 📄 License

This project is licensed under the ISC License.