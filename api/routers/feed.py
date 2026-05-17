from fastapi import APIRouter, Response

from api.schemas import FeedResponse
from services.feed_store import load_feed


router = APIRouter(prefix="/api/v1", tags=["feed"])


@router.get("/feed", response_model=FeedResponse)
def feed(response: Response) -> FeedResponse:
    response.headers["Cache-Control"] = "no-store, max-age=0"
    response.headers["Pragma"] = "no-cache"
    data = load_feed()
    return FeedResponse(
        generated_at=data.get("generated_at"),
        videos=data.get("videos") or [],
    )
