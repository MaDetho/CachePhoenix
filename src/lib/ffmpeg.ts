import { Command } from "@tauri-apps/plugin-shell";

export interface FFprobeInfo {
  format: {
    duration?: string;
    size?: string;
    format_name?: string;
  };
  streams: Array<{
    codec_type: string;
    codec_name: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    sample_rate?: string;
    channels?: number;
    profile?: string;
  }>;
}

async function runSidecar(
  name: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = Command.sidecar(`binaries/${name}`, args);
  const output = await command.execute();
  return {
    stdout: output.stdout,
    stderr: output.stderr,
    code: output.code ?? -1,
  };
}

/** Quick health check: can we execute the ffmpeg sidecar at all? */
export async function ffmpegHealthCheck(): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await runSidecar("ffmpeg", ["-version"]);
    return { ok: result.code === 0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function ffprobe(filePath: string): Promise<FFprobeInfo> {
  const result = await runSidecar("ffprobe", [
    "-v", "error",
    "-show_format",
    "-show_streams",
    "-print_format", "json",
    filePath,
  ]);

  if (result.code !== 0) {
    throw new Error(`ffprobe failed: ${result.stderr}`);
  }

  return JSON.parse(result.stdout);
}

export async function ffmpegReEncode(
  inputPath: string,
  outputPath: string,
  onProgress?: (line: string) => void,
): Promise<boolean> {
  const command = Command.sidecar("binaries/ffmpeg", [
    "-y",
    "-fflags", "+genpts+discardcorrupt",
    "-analyzeduration", "100M",
    "-probesize", "100M",
    "-err_detect", "ignore_err",
    "-i", inputPath,
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    "-max_muxing_queue_size", "1024",
    outputPath,
  ]);

  if (onProgress) {
    command.on("close", (_data) => {});
    command.stderr.on("data", (line) => onProgress(line));
    command.stdout.on("data", (line) => onProgress(line));
  }

  const output = await command.execute();
  return output.code === 0;
}

/**
 * Remux (stream-copy) an MP4 without re-encoding.
 * Used for chunked MP4 reconstructions where the raw data must be preserved as-is.
 * Re-encoding would cause ffmpeg to silently truncate at the first corrupted/zero-filled gap.
 */
export async function ffmpegRemux(
  inputPath: string,
  outputPath: string,
  onProgress?: (line: string) => void,
): Promise<boolean> {
  const command = Command.sidecar("binaries/ffmpeg", [
    "-y",
    "-fflags", "+genpts+discardcorrupt+igndts",
    "-analyzeduration", "100M",
    "-probesize", "100M",
    "-err_detect", "ignore_err",
    "-i", inputPath,
    "-c", "copy",
    "-movflags", "+faststart",
    "-max_muxing_queue_size", "1024",
    outputPath,
  ]);

  if (onProgress) {
    command.on("close", (_data) => {});
    command.stderr.on("data", (line) => onProgress(line));
    command.stdout.on("data", (line) => onProgress(line));
  }

  const output = await command.execute();
  return output.code === 0;
}

export async function ffmpegValidate(
  filePath: string,
): Promise<{ valid: boolean; errors: string[] }> {
  const result = await runSidecar("ffmpeg", [
    "-v", "error",
    "-i", filePath,
    "-f", "null",
    "-",
  ]);

  const errors = result.stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return { valid: errors.length === 0, errors };
}

export async function generateThumbnail(
  videoPath: string,
  outputPath: string,
  timestamp = "00:00:01",
): Promise<boolean> {
  const result = await runSidecar("ffmpeg", [
    "-y",
    "-fflags", "+genpts+discardcorrupt",
    "-err_detect", "ignore_err",
    "-ss", timestamp,
    "-i", videoPath,
    "-frames:v", "1",
    "-q:v", "2",
    "-vf", "scale='min(480,iw)':-2",
    outputPath,
  ]);

  if (result.code !== 0) {
    console.warn(`[ffmpeg thumbnail] failed for ${videoPath}: ${result.stderr.slice(0, 500)}`);
  }
  return result.code === 0;
}

export async function convertGifToMp4(
  gifPath: string,
  outputPath: string,
): Promise<boolean> {
  const result = await runSidecar("ffmpeg", [
    "-y",
    "-i", gifPath,
    "-movflags", "+faststart",
    "-pix_fmt", "yuv420p",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v", "libx264",
    "-crf", "20",
    "-preset", "medium",
    outputPath,
  ]);

  return result.code === 0;
}

export async function ffmpegConcat(
  inputPaths: string[],
  outputPath: string,
  onProgress?: (line: string) => void,
): Promise<boolean> {
  const listContent = inputPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n");

  const { invoke } = await import("@tauri-apps/api/core");
  const tempListPath = outputPath.replace(/\.[^.]+$/, "_concat_list.txt");
  const encoder = new TextEncoder();
  await invoke("write_file_bytes", {
    path: tempListPath,
    data: Array.from(encoder.encode(listContent)),
  });

  const command = Command.sidecar("binaries/ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", tempListPath,
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    "-max_muxing_queue_size", "1024",
    outputPath,
  ]);

  if (onProgress) {
    command.stderr.on("data", (line) => onProgress(line));
  }

  const output = await command.execute();

  try {
    const { remove } = await import("@tauri-apps/plugin-fs");
    await remove(tempListPath);
  } catch {
    // cleanup is best-effort
  }

  return output.code === 0;
}

export async function ffmpegRawExtract(
  inputPath: string,
  outputPath: string,
  format: "h264" | "hevc" | "ivf",
  onProgress?: (line: string) => void,
): Promise<boolean> {
  const command = Command.sidecar("binaries/ffmpeg", [
    "-y",
    "-fflags", "+genpts+discardcorrupt",
    "-err_detect", "ignore_err",
    "-f", format,
    "-i", inputPath,
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "18",
    "-pix_fmt", "yuv420p",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-movflags", "+faststart",
    outputPath,
  ]);

  if (onProgress) {
    command.stderr.on("data", (line) => onProgress(line));
  }

  const output = await command.execute();
  return output.code === 0;
}
