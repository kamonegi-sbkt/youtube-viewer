export type ApiVideo = {
  video_id: string;
  title: string;
  channel_title: string;
  channel_id: string;
  published_iso: string;
  thumbnail: string;
  rel_time?: string;
  duration_text?: string;
  badge_kind?: string;
};

export type FeedResponse = {
  generated_at: string | null;
  videos: ApiVideo[];
};

export type VideoMeta = {
  videoId: string;
  title: string;
  channelTitle: string;
  channelId: string;
  thumbnail: string;
  publishedIso: string;
  duration: string;
  relTime?: string;
  badgeKind?: string;
};

export type LaterEntry = Omit<VideoMeta, 'videoId' | 'relTime' | 'badgeKind'> & {
  savedAt: number;
};

export type HistoryEntry = Omit<VideoMeta, 'videoId' | 'relTime' | 'badgeKind'> & {
  watchedAt: number;
};

export type ResumeEntry = {
  position: number;
  duration: number;
  updatedAt: number;
};
