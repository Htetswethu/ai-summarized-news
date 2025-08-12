-- Summarized Content Table
-- This table stores AI-generated summaries of crawled content
CREATE TABLE IF NOT EXISTS summarized_content (
    id SERIAL PRIMARY KEY,
    url VARCHAR(2048) UNIQUE NOT NULL,
    title VARCHAR(1000) NOT NULL,
    original_text TEXT NOT NULL,
    summary TEXT NOT NULL,
    key_points JSONB NOT NULL,
    code_snippets JSONB NOT NULL,
    content_type VARCHAR(50) NOT NULL CHECK (content_type IN ('article', 'code', 'mixed')),
    sentiment VARCHAR(20) NOT NULL CHECK (sentiment IN ('positive', 'negative', 'neutral')),
    category VARCHAR(100) NOT NULL,
    crawled_at TIMESTAMP NOT NULL,
    summarized_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_summarized_content_url ON summarized_content(url);
CREATE INDEX IF NOT EXISTS idx_summarized_content_category ON summarized_content(category);
CREATE INDEX IF NOT EXISTS idx_summarized_content_sentiment ON summarized_content(sentiment);
CREATE INDEX IF NOT EXISTS idx_summarized_content_content_type ON summarized_content(content_type);
CREATE INDEX IF NOT EXISTS idx_summarized_content_created_at ON summarized_content(created_at);
CREATE INDEX IF NOT EXISTS idx_summarized_content_summarized_at ON summarized_content(summarized_at);

-- Function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger to automatically update updated_at
CREATE TRIGGER update_summarized_content_updated_at 
    BEFORE UPDATE ON summarized_content 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Example queries for analytics
-- 
-- Get summaries by category:
-- SELECT category, COUNT(*) FROM summarized_content GROUP BY category ORDER BY count DESC;
--
-- Get recent summaries:
-- SELECT title, category, sentiment, created_at FROM summarized_content 
-- WHERE created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at DESC;
--
-- Get content with code snippets:
-- SELECT title, url, jsonb_array_length(code_snippets) as snippet_count 
-- FROM summarized_content WHERE jsonb_array_length(code_snippets) > 0;
--
-- Search summaries by keyword:
-- SELECT title, summary FROM summarized_content 
-- WHERE summary ILIKE '%your_keyword%' OR title ILIKE '%your_keyword%';