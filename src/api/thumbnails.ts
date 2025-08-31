import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const formData = await req.formData();

  const file = formData.get("thumbnail");

  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail file missing");
  }

  const MAX_UPLOAD_SIZE = 10 << 20; // Bit shifting. shifting left by n times is 2^n. so n^20. (n^20 === 10 * 1024 * 1024)

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError(
      "Thumbnail file size is larger than max upload size"
    );
  }

  const video = await getVideo(cfg.db, videoId);

  if (video === undefined) {
    throw new NotFoundError("Video not found");
  }

  if (video.userID !== userID) {
    throw new UserForbiddenError("Forbidden");
  }

  const buffer = Buffer.from(await file.arrayBuffer()).toBase64();

  const dataURL = `data:${file.type};base64,${buffer}`;

  video.thumbnailURL = dataURL;

  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
