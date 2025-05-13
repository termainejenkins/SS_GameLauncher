import express from 'express';
import cors from 'cors';

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Sample news data
const news = [
  { id: 1, title: 'Welcome to the Game!', content: 'Stay tuned for updates.' },
  { id: 2, title: 'Patch 1.0 Released', content: 'First patch is live!' }
];

app.get('/news', (req, res) => {
  res.json(news);
});

app.listen(PORT, () => {
  console.log(`Backend API server running on http://localhost:${PORT}`);
}); 