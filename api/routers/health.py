from fastapi import APIRouter

from api.config import settings
from api.schemas import HealthResponse


router = APIRouter(prefix="/api/v1", tags=["health"])


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(app=settings.app_name)
