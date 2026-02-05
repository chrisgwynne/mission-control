import { openDb } from './db.js';

/**
 * Deduplication logic for memory questions
 * Prevents insertion of semantically similar questions
 */

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function calculateSimilarity(str1, str2) {
  const words1 = new Set(normalizeText(str1).split(' '));
  const words2 = new Set(normalizeText(str2).split(' '));
  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);
  return intersection.size / union.size;
}

export function findSimilarQuestions(db, newQuestion, threshold = 0.7) {
  const questions = db.prepare(
    'SELECT id, question, status FROM memory_questions WHERE status IN (?, ?)'
  ).all('open', 'answered');
  
  const similar = [];
  for (const q of questions) {
    const similarity = calculateSimilarity(newQuestion, q.question);
    if (similarity >= threshold) {
      similar.push({ ...q, similarity });
    }
  }
  return similar.sort((a, b) => b.similarity - a.similarity);
}

export function shouldInsertQuestion(db, question, threshold = 0.7) {
  const similar = findSimilarQuestions(db, question, threshold);
  return similar.length === 0 ? null : similar[0];
}

export function insertQuestionDeduplicated(db, question, reason, threshold = 0.7) {
  const existing = shouldInsertQuestion(db, question, threshold);
  if (existing) {
    return {
      inserted: false,
      reason: 'duplicate_detected',
      existingQuestion: existing,
      message: `Similar question already exists (${Math.round(existing.similarity * 100)}% match)`
    };
  }
  
  const id = 'q_' + Math.random().toString(36).substring(2, 11);
  const now = Date.now();
  
  db.prepare(`
    INSERT INTO memory_questions (id, created_at, updated_at, status, question, reason)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, now, now, 'open', question, reason);
  
  return {
    inserted: true,
    id,
    message: 'Question inserted successfully'
  };
}

// Demo/test
const db = openDb();
console.log('=== DEDUPLICATION TEST ===');

// Test 1: New unique question
const result1 = insertQuestionDeduplicated(
  db,
  'What is your preferred code editor theme and why?',
  'tooling preferences'
);
console.log('Test 1 (new question):', result1.inserted ? 'INSERTED' : 'REJECTED');

// Test 2: Similar to existing
const result2 = insertQuestionDeduplicated(
  db,
  'When I auto-create tasks via initiative loop, what is the acceptable daily limit?',
  'autonomy tuning'
);
console.log('Test 2 (similar existing):', result2.inserted ? 'INSERTED' : 'REJECTED', result2.message);

// Show current unique questions count
const stats = db.prepare(`
  SELECT status, COUNT(*) as count 
  FROM memory_questions 
  GROUP BY status
`).all();
console.log('\n=== CURRENT QUESTION STATS ===');
stats.forEach(s => console.log(`${s.status}: ${s.count}`));
