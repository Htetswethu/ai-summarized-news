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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});