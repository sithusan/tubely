import { respondWithJSON } from "./json";
import { type ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { rm } from "node:fs/promises";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };

  if (videoId === undefined) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const formData = await req.formData();

  const file = formData.get("video");

  if (!(file instanceof File)) {
    throw new BadRequestError("video file missing");
  }

  const allowFileTypes = ["video/mp4"];
  const fileMimeType = file.type;

  if (!allowFileTypes.includes(fileMimeType)) {
    throw new BadRequestError("Mimetype not allowed");
  }

  const MAX_UPLOAD_SIZE = 1 << 30; // 1GB

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Video file size if large than max upload size");
  }

  const video = getVideo(cfg.db, videoId);

  if (video === undefined) {
    throw new NotFoundError("Couldn't find video");
  }

  if (video.userID !== userID) {
    throw new UserForbiddenError("Forbidden");
  }

  const fileName = `${randomBytes(32).toString("base64url")}.${
    fileMimeType.split("/")[1]
  }`;

  const filePath = path.join(cfg.assetsRoot, fileName);

  Bun.write(filePath, await file.arrayBuffer());

  const ratio = await getVideoAspectRatio(filePath);

  cfg.s3Client.write(`${ratio}/${fileName}`, Bun.file(filePath));

  video.videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${ratio}/${fileName}`;

  updateVideo(cfg.db, video);

  await rm(filePath, { force: true });

  return respondWithJSON(200, null);
}

async function getVideoAspectRatio(filePath: string): Promise<string> {
  const process = Bun.spawn([
    "ffprobe",
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    filePath,
  ]);

  const [stdout, stderr, exited] = await Promise.all([
    new Response(process.stdout).json(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  if (exited !== 0) {
    throw new Error("Error while getting aspect ratios");
  }

  if (stderr.length > 0) {
    throw new Error(`Error while getting aspect ratios : ${stderr}`);
  }

  if (stdout.streams === undefined || stdout.streams.length === 0) {
    throw new Error("No video streams found");
  }

  const { width, height } = stdout.streams[0] as {
    width: number;
    height: number;
  };

  const ratio = width / height;

  if (ratio > 1.7) {
    return "landscape"; // wider than ~1.7
  }
  if (ratio < 0.6) {
    return "portrait"; // narrower than ~0.6
  }
  return "other";
}
