'use strict';

/**
 * Inverted index with TF-IDF ranking.
 *
 * Pure built-ins (Map / Math.log only). Profiles feed text per item; the
 * index returns the top-k most distinguishing terms for each item — those
 * terms become the `trigger_pretool_content` matchers for the memory.
 *
 * No external dependencies. No project-specific vocabulary.
 */

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'do',
  'does',
  'each',
  'for',
  'from',
  'has',
  'have',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'may',
  'no',
  'not',
  'of',
  'on',
  'one',
  'only',
  'or',
  'other',
  'over',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'use',
  'used',
  'uses',
  'using',
  'via',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'will',
  'with',
  'within',
  'without',
  'you',
  'your',
  'all',
  'any',
  'between',
  'both',
  'case',
  'cases',
  'custom',
  'multiple',
  'optional',
  'support',
  'supports',
  'option',
  'options',
]);

const MIN_TOKEN_LENGTH = 3;
const TOKEN_RE = /[a-z][a-z0-9_-]*/gi;

function tokenize(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out = [];
  const matches = text.toLowerCase().match(TOKEN_RE);
  if (!matches) return out;
  for (const tok of matches) {
    if (tok.length < MIN_TOKEN_LENGTH) continue;
    if (STOPWORDS.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

class InvertedIndex {
  constructor() {
    this._postings = new Map();
    this._docFreq = new Map();
    this._docs = new Map();
    this._finalized = false;
  }

  add(docId, text) {
    if (this._finalized) {
      throw new Error('InvertedIndex.add() after finalize()');
    }
    if (typeof docId !== 'string' || !docId) {
      throw new Error('docId must be a non-empty string');
    }
    if (this._docs.has(docId)) {
      throw new Error(`duplicate docId: ${docId}`);
    }
    const tokens = tokenize(text);
    const tf = new Map();
    for (const tok of tokens) {
      tf.set(tok, (tf.get(tok) || 0) + 1);
    }
    this._docs.set(docId, { tf, length: tokens.length });
    for (const [term, count] of tf) {
      if (!this._postings.has(term)) {
        this._postings.set(term, []);
        this._docFreq.set(term, 0);
      }
      this._postings.get(term).push({ docId, tf: count });
      this._docFreq.set(term, this._docFreq.get(term) + 1);
    }
  }

  finalize() {
    this._finalized = true;
    return this;
  }

  size() {
    return this._docs.size;
  }

  hasDoc(docId) {
    return this._docs.has(docId);
  }

  docFreq(term) {
    return this._docFreq.get(term) || 0;
  }

  /**
   * Smoothed IDF: log((N + 1) / (df + 1)) + 1. Always positive, never
   * undefined. Math.log only — no external math libs.
   */
  idf(term) {
    const N = this._docs.size;
    const df = this._docFreq.get(term) || 0;
    return Math.log((N + 1) / (df + 1)) + 1;
  }

  /**
   * TF-IDF score for `term` in `docId`. Uses raw term frequency (no
   * normalization by length — short bodies should not be penalised).
   * Returns 0 when the term does not appear in the doc.
   */
  tfidf(docId, term) {
    const doc = this._docs.get(docId);
    if (!doc) return 0;
    const tf = doc.tf.get(term) || 0;
    if (tf === 0) return 0;
    return tf * this.idf(term);
  }

  /**
   * Return up to `k` terms from `docId` ranked by descending TF-IDF.
   * Ties broken alphabetically for determinism.
   *
   * Terms appearing in every document (idf collapses near zero) are
   * filtered out — they carry no signal.
   */
  topK(docId, k) {
    if (!this._finalized) {
      throw new Error('InvertedIndex.topK() before finalize()');
    }
    if (typeof k !== 'number' || k <= 0) {
      throw new Error('k must be a positive number');
    }
    const doc = this._docs.get(docId);
    if (!doc) return [];
    const N = this._docs.size;
    const scored = [];
    for (const [term] of doc.tf) {
      const df = this._docFreq.get(term) || 0;
      if (df >= N) continue;
      const score = this.tfidf(docId, term);
      if (score <= 0) continue;
      scored.push({ term, score });
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.term.localeCompare(b.term);
    });
    return scored.slice(0, k).map((s) => s.term);
  }
}

module.exports = {
  InvertedIndex,
  tokenize,
  STOPWORDS,
};
