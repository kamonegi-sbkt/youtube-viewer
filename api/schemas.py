from __future__ import annotations

from pydantic import BaseModel, Field


class Video(BaseModel):
    video_id: str
    title: str
    channel_title: str
    channel_id: str
    published_iso: str
    thumbnail: str
    rel_time: str = ""
    duration_text: str = ""
    badge_kind: str = ""


class FeedResponse(BaseModel):
    generated_at: str | None = Field(default=None)
    videos: list[Video] = Field(default_factory=list)


class HealthResponse(BaseModel):
    status: str = "ok"
    app: str = "My YouTube Viewer"
