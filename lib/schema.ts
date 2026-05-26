export type SourceType = "x_account" | "podcast" | "newsletter" | "papers";
export type PodcastType = "youtube_channel" | "youtube_playlist";
export type FeedItemSourceType = "tweet" | "podcast" | "newsletter" | "paper";
export type CorpusTier = "hot_set" | "core_canon" | "archive" | "ignored";
export type PaperCorpusScope = "default" | "latest" | "archive" | "all";

export interface PaperCorpusTierMetadata {
  manualTier?: CorpusTier | null;
  pinned?: boolean;
  ignored?: boolean;
  scoreVersion?: string | null;
  lastReviewRunId?: number | null;
  lastReviewAction?: string | null;
  lastReviewReasons?: string[];
  popularity?: Record<string, unknown>;
  retention?: {
    intakeDefaultTier?: CorpusTier | null;
    graceDays?: number | null;
    selectedAt?: string | null;
    pendingTier?: CorpusTier | null;
    pendingSourceTier?: CorpusTier | null;
    pendingReviewRunId?: number | null;
    pendingReviewAction?: string | null;
    pendingReviewStartedAt?: string | null;
    pendingReviewReasons?: string[];
    hotSetReadyAt?: string | null;
    hotSetReadyReviewRunId?: number | null;
    richEvidencePrunedAt?: string | null;
    [key: string]: unknown;
  };
  signals?: Record<string, unknown>;
  notes?: string[];
}

export interface Source {
  id: number;
  type: SourceType;
  name: string;
  handle: string | null;
  podcast_type: PodcastType | null;
  channel_handle: string | null;
  playlist_id: string | null;
  url: string | null;
  feed_url: string | null;
  created_at: string;
  active: boolean;
}

export interface TopReply {
  authorHandle: string;
  authorName: string;
  text: string;
  likes: number;
}

export interface TweetMeta {
  likes: number;
  retweets: number;
  replies: number;
  isQuote: boolean;
  quotedTweetId: string | null;
  topReplies: TopReply[] | null;
}

export interface HFPaperProviderMeta {
  upvotes: number;
  numComments: number;
  githubRepo: string | null;
  githubStars: number | null;
  aiSummary: string | null;
  aiKeywords: string[] | null;
}

export interface AlphaxivProviderMeta {
  votes: number;
  visitsAll: number;
  visitsLast7Days: number;
  githubUrl: string | null;
  githubStars: number | null;
  topics: string[];
  summary: string | null;
  originalProblem: string[] | null;
  solution: string[] | null;
  keyInsights: string[] | null;
  results: string[] | null;
}

export interface PaperProviderMeta {
  hf?: HFPaperProviderMeta;
  alphaxiv?: AlphaxivProviderMeta;
}

export interface PaperMeta {
  upvotes: number;
  numComments: number;
  githubRepo: string | null;
  githubStars: number | null;
  aiSummary: string | null;
  aiKeywords: string[] | null;
  authors: { name: string; user?: string }[];
  providers?: PaperProviderMeta;
}

export interface FeedItem {
  id: number;
  source_type: FeedItemSourceType;
  external_id: string;
  source_id: number | null;
  title: string | null;
  content: string;
  url: string;
  author_name: string;
  author_handle: string | null;
  author_bio: string | null;
  published_at: string | null;
  tweet_meta: TweetMeta | null;
  paper_meta: PaperMeta | null;
  full_text: string | null;
  full_text_source: "arxiv_html" | "hf_page" | null;
  corpus_tier: CorpusTier;
  relevance_score: number | null;
  canon_score: number | null;
  hot_set_reason: string | null;
  canon_reason: string | null;
  archive_reason: string | null;
  ignored_reason: string | null;
  last_seen_at: string | null;
  last_scored_at: string | null;
  last_hydrated_at: string | null;
  tier_metadata_json: PaperCorpusTierMetadata;
  fetched_at: string;
}

export interface Digest {
  id: number;
  content: string;
  item_count: number;
  tweet_count: number;
  podcast_count: number;
  newsletter_count: number;
  paper_count: number;
  source_item_ids: number[];
  model: string | null;
  generated_at: string;
}

export interface SearchResult {
  id: number;
  source_type: FeedItemSourceType;
  title: string | null;
  author_name: string;
  url: string;
  published_at: string | null;
  snippet: string;
}

export interface FeedItemInsert {
  source_type: FeedItemSourceType;
  external_id: string;
  source_id?: number | null;
  title?: string | null;
  content: string;
  url: string;
  author_name: string;
  author_handle?: string | null;
  author_bio?: string | null;
  published_at?: string | null;
  tweet_meta?: TweetMeta | null;
  paper_meta?: PaperMeta | null;
  full_text?: string | null;
  full_text_source?: "arxiv_html" | "hf_page" | null;
}

export type KnowledgeNoteScope = "daily_digest" | "theme" | "builder" | "paper";
export type CitationReason =
  | "supporting_evidence"
  | "counterpoint"
  | "background";
export type ClaimConfidence = "high" | "medium" | "low";
export type MemorySearchScope = "all" | "chunk" | "note";
export type MemorySearchSource = FeedItemSourceType | "all";
export type MemoryItemKind = "chunk" | "note";
export type PersistentMemoryToolName =
  | "search_memory"
  | "get_memory_item"
  | "get_theme_brief"
  | "get_builder_brief";

export interface KnowledgeClaim {
  claim: string;
  confidence: ClaimConfidence;
  sourceFeedItemIds: number[];
  sourceChunkIds?: number[];
}

export interface KnowledgeSourceRef {
  feedItemId: number;
  knowledgeChunkId: number | null;
  citationReason: CitationReason;
  excerpt: string | null;
}

export interface KnowledgeChunk {
  id: number;
  feed_item_id: number;
  chunk_index: number;
  source_type: FeedItemSourceType;
  title: string | null;
  author_name: string;
  published_at: string | null;
  text: string;
  retrieval_text: string | null;
  token_count: number;
  text_tsv: string;
  entity_labels: string[];
  embedding_model: string | null;
  embedding_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeChunkWithEmbedding extends KnowledgeChunk {
  embedding: number[] | null;
}

export interface KnowledgeNote {
  id: number;
  scope: KnowledgeNoteScope;
  scope_key: string;
  title: string;
  summary: string;
  claims_json: KnowledgeClaim[];
  source_refs_json: KnowledgeSourceRef[];
  entity_labels: string[];
  effective_date: string;
  summary_tsv: string;
  created_from_digest_id: number | null;
  embedding_model: string | null;
  embedding_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeNoteWithEmbedding extends KnowledgeNote {
  embedding: number[] | null;
}

export interface KnowledgeNoteSource {
  id: number;
  knowledge_note_id: number;
  feed_item_id: number;
  knowledge_chunk_id: number | null;
  source_rank: number;
  citation_reason: CitationReason;
  excerpt: string | null;
  created_at: string;
}

export interface UserMemoryKnownContext {
  topic: string;
  summary: string;
  confidence: ClaimConfidence;
  sourceDigestId?: number;
}

export interface UserMemoryOpenQuestion {
  question: string;
  topic: string | null;
  status: "open" | "answered" | "dismissed";
  sourceDigestId?: number;
}

export interface UserBriefingPreferences {
  voice?: string;
  pace?: "slow" | "medium" | "fast";
  verbosity?: "brief" | "balanced" | "detailed";
  energy?: "calm" | "neutral" | "high";
  interruptibility?: "low" | "medium" | "high";
}

export interface UserMemory {
  user_id: string;
  preferred_topics: string[];
  tracked_builders: string[];
  known_context: UserMemoryKnownContext[];
  open_questions: UserMemoryOpenQuestion[];
  briefing_preferences: UserBriefingPreferences;
  last_briefing_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SearchMemoryToolArguments {
  query: string;
  scope?: MemorySearchScope;
  source?: MemorySearchSource;
  mode?: MemorySearchMode;
  paperCorpusScope?: PaperCorpusScope;
  currentDigestOnly?: boolean;
  after?: string;
  before?: string;
  limit?: number;
}

export interface GetMemoryItemToolArguments {
  memory_kind: MemoryItemKind;
  memory_id: number;
}

export interface GetThemeBriefToolArguments {
  theme: string;
  as_of?: string;
  limit?: number;
}

export interface GetBuilderBriefToolArguments {
  builder: string;
  as_of?: string;
  limit?: number;
}

export interface MemorySearchChunkHit {
  kind: "chunk";
  id: number;
  feed_item_id: number;
  source_type: FeedItemSourceType;
  title: string | null;
  author_name: string;
  published_at: string | null;
  url: string;
  text: string;
  snippet: string;
  entity_labels: string[];
  source_score?: {
    fts_rank: number | null;
    vec_rank: number | null;
    vec_distance: number | null;
    rrf_score: number | null;
    rerank_score?: number;
    rerank_model?: string;
    expansion_query?: string;
  };
  paper_evidence?: PaperEvidenceHitMetadata;
}

export interface MemorySearchNoteHit {
  kind: "note";
  id: number;
  scope: KnowledgeNoteScope;
  scope_key: string;
  title: string;
  summary: string;
  effective_date: string;
  source_refs: KnowledgeSourceRef[];
}

export type MemorySearchHit = MemorySearchChunkHit | MemorySearchNoteHit;

export type MemorySearchMode = "discovery" | "evidence";

export type PaperEvidenceStatus =
  | "supports"
  | "paper_related_only"
  | "weak/reference_evidence"
  | "unsupported";

export interface PaperEvidenceMetadata {
  status: PaperEvidenceStatus;
  candidate_feed_item_ids: number[];
  supporting_chunk_ids: number[];
  related_chunk_ids: number[];
  supporting_span_ids?: number[];
  supporting_card_ids?: number[];
  weak_reference_chunk_ids?: number[];
  reason: string;
}

export interface PaperEvidenceHitMetadata {
  span_id: number;
  card_id?: number;
  origin?: "llm_proposition" | "parser_sentence";
  section_path: string[];
  span_type: string;
  claim_type?: string;
  entities?: string[];
  methods?: string[];
  datasets?: string[];
  metrics?: string[];
  numbers?: string[];
  aliases?: string[];
}

export interface PaperEvidenceDebugChunk {
  chunk_id: number;
  feed_item_id: number;
  title: string | null;
  chunk_index: number | null;
  verifier_evidence_text: string;
  returned_snippet: string;
  matched_terms: string[];
  matched_numbers: string[];
  matched_anchor_groups: string[];
  missing_anchor_groups: string[];
  anchor_groups_by_kind?: {
    paper_identity_anchor: string[];
    claim_anchor: string[];
    numeric_or_detail_anchor: string[];
  };
  identity_anchor_matches?: {
    title: string[];
    metadata: string[];
    chunk: string[];
    snippet: string[];
  };
  claim_detail_anchor_matches?: string[];
  demotion_reason?: string | null;
  is_reference_like: boolean;
  is_paper_card: boolean;
  supports: boolean;
  reason: string;
}

export interface SearchMemoryToolResult {
  query: string;
  scope: MemorySearchScope;
  source: MemorySearchSource;
  mode?: MemorySearchMode;
  current_digest_search?: {
    searched: boolean;
    source_item_ids: number[];
    status: "hit" | "miss";
    broader_search_suggested?: boolean;
    guidance?: string;
  };
  paper_evidence?: PaperEvidenceMetadata;
  paper_evidence_debug?: PaperEvidenceDebugChunk[];
  results: MemorySearchHit[];
}

export interface GetMemoryChunkToolResult {
  kind: "chunk";
  id: number;
  feed_item_id: number;
  source_type: FeedItemSourceType;
  title: string | null;
  author_name: string;
  published_at: string | null;
  url: string;
  text_excerpt: string;
  entity_labels: string[];
}

export interface GetMemoryNoteToolResult {
  kind: "note";
  id: number;
  scope: KnowledgeNoteScope;
  scope_key: string;
  title: string;
  summary: string;
  claims: KnowledgeClaim[];
  effective_date: string;
  source_refs: KnowledgeSourceRef[];
}

export type GetMemoryItemToolResult =
  | GetMemoryChunkToolResult
  | GetMemoryNoteToolResult;

export interface MemoryBriefNote {
  id: number;
  title: string;
  summary: string;
  effective_date: string;
  source_refs: KnowledgeSourceRef[];
}

export interface ThemeBriefToolResult {
  theme: string;
  as_of: string | null;
  notes: MemoryBriefNote[];
  supporting_source_refs: KnowledgeSourceRef[];
}

export interface BuilderBriefToolResult {
  builder: string;
  as_of: string | null;
  notes: MemoryBriefNote[];
  supporting_source_refs: KnowledgeSourceRef[];
}
