-- Migration script for chunked content system
-- Run this after the existing schema.sql

-- Store raw crawled content (replaces Redis queue)
CREATE TABLE IF NOT EXISTS crawled_content (
    id SERIAL PRIMARY KEY,
    url VARCHAR(2048) UNIQUE NOT NULL,
    title VARCHAR(1000) NOT NULL,
    raw_text TEXT NOT NULL,
    code_snippets JSONB NOT NULL DEFAULT '[]',
    content_type VARCHAR(50) NOT NULL CHECK (content_type IN ('article', 'code', 'mixed')),
    total_tokens INTEGER, -- estimated token count for the full content
    crawled_at TIMESTAMP NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'chunked', 'failed')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Store content chunks (manageable pieces of content)
CREATE TABLE IF NOT EXISTS content_chunks (
    id SERIAL PRIMARY KEY,
    crawled_content_id INTEGER REFERENCES crawled_content(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL, -- 0-based ordering within the article
    chunk_text TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    chunk_type VARCHAR(20) DEFAULT 'text' CHECK (chunk_type IN ('text', 'code', 'mixed')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(crawled_content_id, chunk_index)
);

-- Store chunk groups for summarization (replaces Redis content queue)
CREATE TABLE IF NOT EXISTS chunk_groups (
    id SERIAL PRIMARY KEY,
    crawled_content_id INTEGER REFERENCES crawled_content(id) ON DELETE CASCADE,
    chunk_ids INTEGER[] NOT NULL, -- array of chunk IDs in this group
    group_index INTEGER NOT NULL, -- 0-based ordering of groups within the article
    combined_text TEXT NOT NULL, -- concatenated text from all chunks in group
    combined_tokens INTEGER NOT NULL, -- total token count for the group
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'summarized', 'failed')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(crawled_content_id, group_index)
);

-- Add relationship columns to existing summarized_content table
ALTER TABLE summarized_content 
ADD COLUMN IF NOT EXISTS crawled_content_id INTEGER REFERENCES crawled_content(id),
ADD COLUMN IF NOT EXISTS chunk_group_id INTEGER REFERENCES chunk_groups(id),
ADD COLUMN IF NOT EXISTS is_partial_summary BOOLEAN DEFAULT FALSE; -- true for individual chunk group summaries

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_crawled_content_url ON crawled_content(url);
CREATE INDEX IF NOT EXISTS idx_crawled_content_status ON crawled_content(status);
CREATE INDEX IF NOT EXISTS idx_crawled_content_created_at ON crawled_content(created_at);

CREATE INDEX IF NOT EXISTS idx_content_chunks_crawled_content_id ON content_chunks(crawled_content_id);
CREATE INDEX IF NOT EXISTS idx_content_chunks_chunk_index ON content_chunks(crawled_content_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_chunk_groups_crawled_content_id ON chunk_groups(crawled_content_id);
CREATE INDEX IF NOT EXISTS idx_chunk_groups_status ON chunk_groups(status);
CREATE INDEX IF NOT EXISTS idx_chunk_groups_group_index ON chunk_groups(crawled_content_id, group_index);

-- Trigger to automatically update updated_at columns
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER IF NOT EXISTS update_crawled_content_updated_at 
    BEFORE UPDATE ON crawled_content 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER IF NOT EXISTS update_chunk_groups_updated_at 
    BEFORE UPDATE ON chunk_groups 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Example queries for monitoring and debugging
-- 
-- Get chunking status for all articles:
-- SELECT cc.url, cc.title, cc.status, cc.total_tokens, 
--        COUNT(ch.id) as chunk_count, COUNT(cg.id) as group_count
-- FROM crawled_content cc
-- LEFT JOIN content_chunks ch ON cc.id = ch.crawled_content_id
-- LEFT JOIN chunk_groups cg ON cc.id = cg.crawled_content_id
-- GROUP BY cc.id, cc.url, cc.title, cc.status, cc.total_tokens
-- ORDER BY cc.created_at DESC;
--
-- Get pending chunk groups for summarization:
-- SELECT cg.id, cc.title, cg.group_index, cg.combined_tokens, cg.created_at
-- FROM chunk_groups cg
-- JOIN crawled_content cc ON cg.crawled_content_id = cc.id
-- WHERE cg.status = 'pending'
-- ORDER BY cg.created_at ASC;
--
-- Get chunk distribution for an article:
-- SELECT chunk_index, token_count, chunk_type, LEFT(chunk_text, 100) as preview
-- FROM content_chunks 
-- WHERE crawled_content_id = $1
-- ORDER BY chunk_index;