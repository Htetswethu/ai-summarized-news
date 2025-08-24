import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

app.use(cors());
app.use(express.json());

app.get('/api/news', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, title, url as originalUrl, summary, created_at FROM summarized_content ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching news:', error);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

app.get('/api/news/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT id, title, url as originalUrl, summary, key_points, content_type, sentiment, category, created_at FROM summarized_content WHERE id = $1',
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Article not found' });
    }
    
    const article = result.rows[0];
    
    // Parse key_points if it's a JSON string
    if (article.key_points && typeof article.key_points === 'string') {
      try {
        article.key_points = JSON.parse(article.key_points);
      } catch (parseError) {
        console.warn('Failed to parse key_points JSON:', parseError);
        article.key_points = [];
      }
    }
    
    res.json(article);
  } catch (error) {
    console.error('Error fetching article:', error);
    res.status(500).json({ error: 'Failed to fetch article' });
  }
});

// Dashboard API endpoints

// Get all crawled content with status
app.get('/api/dashboard/crawled-content', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        cc.id,
        cc.url,
        cc.title,
        cc.content_type,
        cc.total_tokens,
        cc.status,
        cc.created_at,
        COUNT(ch.id) as chunks_count,
        COUNT(cg.id) as groups_count,
        COUNT(CASE WHEN cg.status = 'pending' THEN 1 END) as pending_groups,
        0 as summarizing_groups,
        COUNT(CASE WHEN cg.status = 'summarized' THEN 1 END) as summarized_groups,
        COUNT(CASE WHEN cg.status = 'failed' THEN 1 END) as failed_groups
      FROM crawled_content cc
      LEFT JOIN content_chunks ch ON cc.id = ch.crawled_content_id
      LEFT JOIN chunk_groups cg ON cc.id = cg.crawled_content_id
      GROUP BY cc.id, cc.url, cc.title, cc.content_type, cc.total_tokens, cc.status, cc.created_at
      ORDER BY cc.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching crawled content:', error);
    res.status(500).json({ error: 'Failed to fetch crawled content' });
  }
});

// Get chunk groups with status
app.get('/api/dashboard/chunk-groups', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        cg.id,
        cg.crawled_content_id,
        cc.title as content_title,
        cc.url as content_url,
        cg.group_index,
        cg.combined_tokens,
        cg.status,
        cg.created_at,
        cg.updated_at,
        array_length(cg.chunk_ids, 1) as chunks_in_group
      FROM chunk_groups cg
      JOIN crawled_content cc ON cg.crawled_content_id = cc.id
      ORDER BY cg.created_at DESC, cg.group_index ASC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching chunk groups:', error);
    res.status(500).json({ error: 'Failed to fetch chunk groups' });
  }
});

// Get content chunks for a specific crawled content
app.get('/api/dashboard/content-chunks/:contentId', async (req, res) => {
  try {
    const { contentId } = req.params;
    const result = await pool.query(`
      SELECT 
        ch.id,
        ch.crawled_content_id,
        ch.chunk_index,
        ch.token_count,
        ch.chunk_type,
        ch.created_at,
        LEFT(ch.chunk_text, 200) as preview
      FROM content_chunks ch
      WHERE ch.crawled_content_id = $1
      ORDER BY ch.chunk_index ASC
    `, [contentId]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching content chunks:', error);
    res.status(500).json({ error: 'Failed to fetch content chunks' });
  }
});

// Get pipeline stats
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const [crawledStats, chunkStats, groupStats, summaryStats] = await Promise.all([
      pool.query(`
        SELECT 
          status,
          COUNT(*) as count
        FROM crawled_content
        GROUP BY status
      `),
      pool.query(`
        SELECT 
          COUNT(*) as total_chunks,
          SUM(token_count) as total_tokens
        FROM content_chunks
      `),
      pool.query(`
        SELECT 
          status,
          COUNT(*) as count
        FROM chunk_groups
        GROUP BY status
      `),
      pool.query(`
        SELECT 
          COUNT(*) as total_summaries,
          COUNT(CASE WHEN created_at > NOW() - INTERVAL '24 hours' THEN 1 END) as recent_summaries
        FROM summarized_content
      `)
    ]);

    res.json({
      crawled_content: crawledStats.rows.reduce((acc, row) => {
        acc[row.status] = parseInt(row.count);
        return acc;
      }, {}),
      chunks: {
        total_chunks: parseInt(chunkStats.rows[0]?.total_chunks || 0),
        total_tokens: parseInt(chunkStats.rows[0]?.total_tokens || 0)
      },
      chunk_groups: groupStats.rows.reduce((acc, row) => {
        acc[row.status] = parseInt(row.count);
        return acc;
      }, {}),
      summaries: {
        total: parseInt(summaryStats.rows[0]?.total_summaries || 0),
        recent_24h: parseInt(summaryStats.rows[0]?.recent_summaries || 0)
      }
    });
  } catch (error) {
    console.error('Error fetching pipeline stats:', error);
    res.status(500).json({ error: 'Failed to fetch pipeline stats' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});