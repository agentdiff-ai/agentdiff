#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderDesignedVideo, writeDesignedAudit } from "./demo-factory-designed.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const specRoot = path.join(repoRoot, "demos");
const outRoot = path.join(repoRoot, ".agentdiff", "demos");
const defaultWidth = 1920;
const defaultHeight = 1080;

export function loadDemoSpec(id, root = repoRoot) {
  const specPath = path.join(root, "demos", `${id}.json`);
  const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
  validateDemoSpec(spec);
  return { spec, specPath };
}

export function validateDemoSpec(spec) {
  if (!spec.id || typeof spec.id !== "string") throw new Error("demo spec requires string id");
  if (!Array.isArray(spec.shots) || spec.shots.length !== 4) throw new Error("demo spec requires exactly four shots");
  for (const shot of spec.shots) {
    for (const field of ["id", "title", "durationSeconds", "url", "fallbackUrl", "strategy", "screenshot", "caption", "voiceover"]) {
      if (shot[field] === undefined || shot[field] === null || shot[field] === "") {
        throw new Error(`shot ${shot.id ?? "(unknown)"} missing ${field}`);
      }
    }
    if (!Array.isArray(shot.expectedText) || shot.expectedText.length === 0) {
      throw new Error(`shot ${shot.id} requires expectedText`);
    }
  }
  if (spec.render?.mode === "designed") {
    if (!Array.isArray(spec.render.scenes) || spec.render.scenes.length < 2) {
      throw new Error("designed demo requires at least two render scenes");
    }
    if (spec.render.transitions && spec.render.transitions.length !== spec.render.scenes.length - 1) {
      throw new Error("designed demo requires one transition per scene boundary");
    }
    for (const scene of spec.render.scenes) {
      for (const field of ["id", "kind", "durationSeconds", "voiceover"]) {
        if (scene[field] === undefined || scene[field] === null || scene[field] === "") {
          throw new Error(`render scene ${scene.id ?? "(unknown)"} missing ${field}`);
        }
      }
    }
  }
}

export function getRenderUnits(spec) {
  return spec.render?.mode === "designed" ? spec.render.scenes : spec.shots;
}

export function buildSrt(shots) {
  let cursor = 0;
  return `${shots
    .map((shot, index) => {
      const start = cursor;
      const end = cursor + Number(shot.durationSeconds);
      cursor = end;
      return [
        String(index + 1),
        `${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}`,
        shot.voiceover,
        ""
      ].join("\n");
    })
    .join("\n")}\n`;
}

export function formatSrtTimestamp(seconds) {
  const whole = Math.floor(seconds);
  const millis = Math.round((seconds - whole) * 1000);
  const hh = String(Math.floor(whole / 3600)).padStart(2, "0");
  const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
  const ss = String(whole % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss},${String(millis).padStart(3, "0")}`;
}

function parseArgs(argv) {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const id = positional[0];
  const stage = readArg(argv, "--stage") ?? "all";
  return { id, stage };
}

function readArg(argv, name) {
  const index = argv.indexOf(name);
  if (index !== -1) return argv[index + 1];
  const prefix = `${name}=`;
  const match = argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

async function main() {
  const { id, stage } = parseArgs(process.argv.slice(2));
  if (!id) {
    console.error("Usage: node scripts/demo-factory.js <demo-id> --stage capture|render|check|all");
    console.error(`Available demos: ${listDemoIds().join(", ") || "(none)"}`);
    process.exit(1);
  }
  if (!["capture", "render", "check", "all"].includes(stage)) {
    throw new Error(`Unsupported stage: ${stage}`);
  }

  const { spec } = loadDemoSpec(id);
  const paths = demoPaths(spec);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.mkdirSync(paths.screenshots, { recursive: true });
  fs.mkdirSync(paths.final, { recursive: true });

  if (stage === "capture" || stage === "all") {
    await captureDemo(spec, paths);
  }
  if (stage === "render" || stage === "all") {
    renderDemo(spec, paths);
  }
  if (stage === "check" || stage === "all") {
    checkDemo(spec, paths);
  }
}

function listDemoIds() {
  if (!fs.existsSync(specRoot)) return [];
  return fs
    .readdirSync(specRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
}

function demoPaths(spec) {
  const root = path.join(outRoot, spec.id);
  const final = path.join(root, "final");
  return {
    root,
    screenshots: path.join(root, "screenshots"),
    clips: path.join(root, "clips"),
    final,
    captureResults: path.join(root, "capture-results.json"),
    captureReport: path.join(root, "capture-report.md"),
    renderPlan: path.join(final, "render-plan.md"),
    qualityReport: path.join(final, "quality-report.md"),
    subtitles: path.join(final, "subtitles.srt"),
    voiceoverText: path.join(final, "voiceover.txt"),
    voiceoverWav: path.join(final, "voiceover.wav"),
    humanVoiceoverWav: path.join(final, "voiceover-human.wav"),
    finalMp4: path.join(final, spec.outputFile),
    previewFrames: path.join(final, "preview-frames"),
    designed: path.join(root, "designed"),
    designedScenes: path.join(root, "designed", "scenes"),
    designedClips: path.join(root, "designed", "clips"),
    alignment: path.join(final, "alignment"),
    alignmentTransitions: path.join(final, "alignment", "transitions"),
    alignmentContactSheet: path.join(final, "alignment", "contact-sheet.png"),
    transitionContactSheet: path.join(final, "alignment", "transition-contact-sheet.png")
  };
}

async function captureDemo(spec, paths) {
  fs.rmSync(paths.screenshots, { recursive: true, force: true });
  fs.mkdirSync(paths.screenshots, { recursive: true });
  const chrome = findChrome();
  if (!chrome) throw new Error("Chrome or Edge was not found.");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdiff-demo-chrome-"));
  const child = spawn(chrome, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-gpu",
    "--hide-scrollbars",
    `--window-size=${spec.video?.width ?? defaultWidth},${spec.video?.height ?? defaultHeight}`,
    "--force-device-scale-factor=1",
    "--lang=en-US",
    "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const warnings = [];
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    if (!text.includes("usb_service_win")) warnings.push(text.trim());
  });

  try {
    await waitForFile(path.join(userDataDir, "DevToolsActivePort"));
    const { cdp, ws } = await createCdp(readDevToolsEndpoint(userDataDir));
    await setupPage(cdp, spec);
    const shots = [];
    for (const shot of spec.shots) {
      shots.push(await captureShot(cdp, spec, paths, shot));
    }
    ws.close();
    const report = {
      generatedAt: new Date().toISOString(),
      method: `Chrome DevTools fallback (${chrome})`,
      shots,
      warnings
    };
    fs.writeFileSync(paths.captureResults, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(paths.captureReport, renderCaptureReport(report));
    console.log(`capture report: ${paths.captureReport}`);
  } finally {
    await stopChrome(child, userDataDir);
  }
}

async function captureShot(cdp, spec, paths, shot) {
  await navigate(cdp, shot.captureUrl || shot.url);
  const expectedText = await getExpectedTextStatus(cdp, shot.expectedText);
  const clip = await getClipForStrategy(cdp, spec, shot.strategy);
  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: Boolean(clip.beyond),
    clip
  });
  const outputPath = path.join(paths.screenshots, shot.screenshot);
  fs.writeFileSync(outputPath, Buffer.from(screenshot.data, "base64"));
  return {
    id: shot.id,
    title: shot.title,
    url: shot.url,
    fallbackUrl: shot.fallbackUrl,
    screenshot: outputPath,
    sizeBytes: fs.statSync(outputPath).size,
    clip: {
      x: Math.round(clip.x),
      y: Math.round(clip.y),
      width: Math.round(clip.width),
      height: Math.round(clip.height)
    },
    expectedText
  };
}

function renderDemo(spec, paths) {
  fs.mkdirSync(paths.final, { recursive: true });
  fs.mkdirSync(paths.clips, { recursive: true });
  fs.rmSync(paths.previewFrames, { recursive: true, force: true });
  fs.mkdirSync(paths.previewFrames, { recursive: true });

  const ffmpeg = findCommand("ffmpeg");
  if (!ffmpeg) throw new Error("ffmpeg was not found.");
  const units = getRenderUnits(spec);
  const voiceoverText = units.map((unit) => unit.voiceover).join("\n\n");
  fs.writeFileSync(paths.voiceoverText, `${voiceoverText}\n`);
  fs.writeFileSync(paths.subtitles, buildSrt(units));

  const audio = generateVoiceover(spec, paths, ffmpeg, units);
  let silentVideo;
  if (spec.render?.mode === "designed") {
    const chrome = findChrome();
    const result = renderDesignedVideo({ spec, paths, ffmpeg, chrome, run });
    silentVideo = result.silentVideo;
  } else {
    const clipPaths = spec.shots.map((shot, index) => renderClip(spec, paths, shot, index, ffmpeg));
    const concatPath = path.join(paths.clips, "clips.txt");
    fs.writeFileSync(concatPath, clipPaths.map((clipPath) => `file '${ffmpegPath(clipPath)}'`).join("\n"));
    silentVideo = path.join(paths.clips, "video-no-audio.mp4");
    run(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c", "copy", silentVideo], "concat video clips");
  }

  const muxArgs = ["-y", "-i", silentVideo];
  if (audio.ok) muxArgs.push("-i", paths.voiceoverWav);
  muxArgs.push("-map", "0:v");
  if (audio.ok) muxArgs.push("-map", "1:a", "-c:a", "aac");
  muxArgs.push("-c:v", "copy", paths.finalMp4);
  run(ffmpeg, muxArgs, "mux final video");

  const duration = totalDuration(spec);
  for (const second of previewTimes(duration)) {
    const frame = path.join(paths.previewFrames, `preview-${String(second).padStart(2, "0")}.png`);
    run(ffmpeg, ["-y", "-ss", String(second), "-i", paths.finalMp4, "-frames:v", "1", frame], `extract preview frame ${second}s`);
  }
  if (spec.render?.mode === "designed") {
    writeDesignedAudit({ spec, paths, ffmpeg, run, finalMp4: paths.finalMp4 });
  }

  fs.writeFileSync(paths.renderPlan, renderPlan(spec, paths, audio));
  console.log(`rendered video: ${paths.finalMp4}`);
}

function renderClip(spec, paths, shot, index, ffmpeg) {
  const width = spec.video?.width ?? defaultWidth;
  const height = spec.video?.height ?? defaultHeight;
  const fps = spec.video?.fps ?? 30;
  const input = path.join(paths.screenshots, shot.screenshot);
  if (!fs.existsSync(input)) throw new Error(`Missing screenshot: ${input}`);
  const output = path.join(paths.clips, `${String(index + 1).padStart(2, "0")}-${shot.id}.mp4`);
  const caption = escapeDrawtext(shot.caption);
  const fontFile = "C\\:/Windows/Fonts/segoeui.ttf";
  const filter = [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white`,
    `drawbox=x=0:y=${height - 130}:w=${width}:h=130:color=black@0.52:t=fill`,
    `drawtext=fontfile='${fontFile}':text='${caption}':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=${height - 86}:box=0`
  ].join(",");
  run(ffmpeg, [
    "-y",
    "-loop", "1",
    "-i", input,
    "-t", String(shot.durationSeconds),
    "-vf", filter,
    "-r", String(fps),
    "-pix_fmt", "yuv420p",
    "-an",
    output
  ], `render clip ${shot.id}`);
  return output;
}

function checkDemo(spec, paths) {
  const ffprobe = findCommand("ffprobe");
  if (!ffprobe) throw new Error("ffprobe was not found.");
  const failures = [];
  const warnings = [];
  const voiceoverStatus = readVoiceoverStatus(paths);
  if (!fs.existsSync(paths.finalMp4)) failures.push(`missing mp4: ${paths.finalMp4}`);
  const capture = readJsonIfExists(paths.captureResults);
  for (const shot of spec.shots) {
    const screenshot = path.join(paths.screenshots, shot.screenshot);
    if (!fs.existsSync(screenshot)) failures.push(`missing screenshot: ${screenshot}`);
    const captured = capture?.shots?.find((item) => item.id === shot.id);
    if (!captured) failures.push(`missing capture metadata for ${shot.id}`);
    else {
      for (const expected of shot.expectedText) {
        if (!captured.expectedText?.[expected]) failures.push(`capture metadata missing expected text for ${shot.id}: ${expected}`);
      }
    }
  }

  let probe = null;
  if (fs.existsSync(paths.finalMp4)) {
    probe = JSON.parse(run(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", paths.finalMp4], "probe final video").stdout);
    const duration = Number(probe.format?.duration ?? 0);
    const video = probe.streams?.find((stream) => stream.codec_type === "video");
    const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
    const subtitleStreams = probe.streams?.filter((stream) => stream.codec_type === "subtitle") ?? [];
    if (!video) failures.push("missing video stream");
    else {
      if (video.width !== (spec.video?.width ?? defaultWidth)) failures.push(`video width is ${video.width}`);
      if (video.height !== (spec.video?.height ?? defaultHeight)) failures.push(`video height is ${video.height}`);
    }
    if (duration < spec.video.minDurationSeconds || duration > spec.video.maxDurationSeconds) {
      failures.push(`duration ${duration.toFixed(2)}s outside ${spec.video.minDurationSeconds}-${spec.video.maxDurationSeconds}s`);
    }
    if (!audio && voiceoverStatus.ok !== false) failures.push("missing audio stream");
    if (!audio && voiceoverStatus.ok === false) warnings.push(`captions-only fallback: ${voiceoverStatus.reason}`);
    if (audio && spec.voice?.requireHumanForFinal && voiceoverStatus.voice !== "human") {
      warnings.push(`synthetic voiceover placeholder; add ${paths.humanVoiceoverWav} before distribution`);
    }
    if (!fs.existsSync(paths.subtitles) || fs.statSync(paths.subtitles).size === 0) failures.push("missing external subtitles.srt");
    if (subtitleStreams.length > 0) failures.push("embedded subtitle stream may duplicate visual lower thirds");
    if (spec.render?.mode === "designed") {
      const expectedSeconds = Math.floor(totalDuration(spec));
      const secondFrames = countMatchingFiles(paths.alignment, /^sec-\d+\.png$/);
      const expectedTransitionFrames = (getRenderUnits(spec).length - 1) * 3;
      const transitionFrames = countMatchingFiles(paths.alignmentTransitions, /^transition-\d+\.png$/);
      if (secondFrames !== expectedSeconds) failures.push(`alignment audit has ${secondFrames}/${expectedSeconds} second frames`);
      if (transitionFrames !== expectedTransitionFrames) failures.push(`transition audit has ${transitionFrames}/${expectedTransitionFrames} frames`);
    }
  }

  const report = renderQualityReport(spec, paths, probe, failures, warnings, voiceoverStatus);
  fs.writeFileSync(paths.qualityReport, report);
  console.log(`quality report: ${paths.qualityReport}`);
  if (failures.length > 0) {
    throw new Error(`demo quality gate failed:\n- ${failures.join("\n- ")}`);
  }
}

function generateVoiceover(spec, paths, ffmpeg, units = getRenderUnits(spec)) {
  const statusPath = path.join(paths.final, "voiceover-status.json");
  const duration = totalDuration(spec);
  if (fs.existsSync(paths.humanVoiceoverWav)) {
    run(ffmpeg, ["-y", "-i", paths.humanVoiceoverWav, "-af", "apad", "-t", String(duration), "-ar", "22050", "-ac", "1", "-c:a", "pcm_s16le", paths.voiceoverWav], "prepare human voiceover");
    const status = { ok: true, voice: "human", source: paths.humanVoiceoverWav, segments: 1 };
    fs.writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
    return status;
  }
  if (process.platform !== "win32") {
    const status = { ok: false, reason: "Windows SAPI is only available on Windows" };
    fs.writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
    return status;
  }
  const segmentDir = path.join(paths.final, "voiceover-segments");
  fs.rmSync(segmentDir, { recursive: true, force: true });
  fs.mkdirSync(segmentDir, { recursive: true });
  const voice = spec.voice?.preferred ?? "Microsoft Zira Desktop";
  const generated = [];
  for (const [index, unit] of units.entries()) {
    const textPath = path.join(segmentDir, `${String(index + 1).padStart(2, "0")}-${unit.id}.txt`);
    const rawWav = path.join(segmentDir, `${String(index + 1).padStart(2, "0")}-${unit.id}-raw.wav`);
    const paddedWav = path.join(segmentDir, `${String(index + 1).padStart(2, "0")}-${unit.id}.wav`);
    const ps1 = path.join(segmentDir, `${String(index + 1).padStart(2, "0")}-${unit.id}.ps1`);
    fs.writeFileSync(textPath, unit.voiceover);
    fs.writeFileSync(ps1, `
Add-Type -AssemblyName System.Speech
$text = Get-Content -Raw -LiteralPath ${psQuote(textPath)}
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
if ($voices -contains ${psQuote(voice)}) { $synth.SelectVoice(${psQuote(voice)}) }
$synth.Rate = 0
$synth.Volume = 100
$synth.SetOutputToWaveFile(${psQuote(rawWav)})
$synth.Speak($text)
$synth.Dispose()
`);
    const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    if (result.status !== 0 || !fs.existsSync(rawWav)) {
      const status = { ok: false, reason: (result.stderr || result.stdout || `SAPI voiceover failed for ${unit.id}`).trim() };
      fs.writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
      return status;
    }
    run(ffmpeg, [
      "-y",
      "-i", rawWav,
      "-af", "apad",
      "-t", String(unit.durationSeconds),
      "-ar", "22050",
      "-ac", "1",
      "-c:a", "pcm_s16le",
      paddedWav
    ], `pad voiceover segment ${unit.id}`);
    generated.push(paddedWav);
  }
  const concatPath = path.join(segmentDir, "voiceover-clips.txt");
  fs.writeFileSync(concatPath, generated.map((file) => `file '${ffmpegPath(file)}'`).join("\n"));
  run(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", concatPath, "-c:a", "pcm_s16le", paths.voiceoverWav], "concat voiceover segments");
  const status = { ok: true, voice, segments: generated.length };
  fs.writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  return status;
}

function readVoiceoverStatus(paths) {
  return readJsonIfExists(path.join(paths.final, "voiceover-status.json")) ?? { ok: false, reason: "voiceover status missing" };
}

function renderCaptureReport(report) {
  const lines = [
    "# Demo Factory Capture Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Method: ${report.method}`,
    "",
    "## Shots",
    ""
  ];
  for (const shot of report.shots) {
    lines.push(`### ${shot.id} - ${shot.title}`);
    lines.push("");
    lines.push(`Screenshot: ${shot.screenshot}`);
    lines.push(`Size: ${shot.sizeBytes} bytes`);
    lines.push(`Clip: x=${shot.clip.x}, y=${shot.clip.y}, width=${shot.clip.width}, height=${shot.clip.height}`);
    lines.push("Expected text:");
    for (const [text, present] of Object.entries(shot.expectedText)) {
      lines.push(`- ${present ? "yes" : "no"}: ${text}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function renderPlan(spec, paths, audio) {
  const units = getRenderUnits(spec);
  return `${[
    "# Demo Factory Render Plan",
    "",
    `Demo: ${spec.id}`,
    `Output: ${paths.finalMp4}`,
    `Resolution: ${spec.video.width}x${spec.video.height}`,
    `Duration target: ${totalDuration(spec)} seconds`,
    `Audio: ${audio.ok ? `yes (${audio.voice})` : `no (${audio.reason})`}`,
    "",
    "## Render scenes",
    "",
    ...units.flatMap((unit) => [
      `- ${unit.id}: ${unit.durationSeconds}s`,
      `  - kind: ${unit.kind ?? "captured"}`,
      `  - caption: ${unit.caption ?? "none"}`
    ])
  ].join("\n")}\n`;
}

function renderQualityReport(spec, paths, probe, failures, warnings, voiceoverStatus) {
  const duration = probe?.format?.duration ? Number(probe.format.duration).toFixed(2) : "unknown";
  const video = probe?.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe?.streams?.find((stream) => stream.codec_type === "audio");
  const subtitles = probe?.streams?.filter((stream) => stream.codec_type === "subtitle") ?? [];
  const distributionReady = failures.length === 0 && (!spec.voice?.requireHumanForFinal || voiceoverStatus?.voice === "human");
  return `${[
    "# Demo Factory Quality Report",
    "",
    `Status: ${failures.length === 0 ? "passed" : "failed"}`,
    "",
    `MP4: ${paths.finalMp4}`,
    `Duration: ${duration}s`,
    `Resolution: ${video ? `${video.width}x${video.height}` : "missing"}`,
    `Video stream: ${video ? "yes" : "no"}`,
    `Audio stream: ${audio ? "yes" : "no"}`,
    `Audio source: ${voiceoverStatus?.voice ?? "none"}`,
    `Distribution ready: ${distributionReady ? "yes" : "no"}`,
    `Subtitle streams: ${subtitles.length} (external SRT: ${fs.existsSync(paths.subtitles) ? "ready" : "missing"})`,
    `Preview frames: ${paths.previewFrames}`,
    ...(spec.render?.mode === "designed" ? [
      `Second-by-second contact sheet: ${paths.alignmentContactSheet}`,
      `Transition contact sheet: ${paths.transitionContactSheet}`
    ] : []),
    "",
    "## Required Evidence",
    "",
    ...spec.shots.map((shot) => `- ${shot.id}: ${shot.expectedText.join(", ")}`),
    "",
    "## Warnings",
    "",
    ...(warnings.length ? warnings.map((warning) => `- ${warning}`) : ["None"]),
    "",
    "## Failures",
    "",
    ...(failures.length ? failures.map((failure) => `- ${failure}`) : ["None"])
  ].join("\n")}\n`;
}

function totalDuration(spec) {
  return getRenderUnits(spec).reduce((sum, unit) => sum + Number(unit.durationSeconds), 0);
}

function previewTimes(duration) {
  return duration <= 45
    ? [3, 8, 16, 25, 33, Math.max(1, duration - 2)]
    : [5, Math.floor(duration * 0.33), Math.floor(duration * 0.66), Math.max(1, duration - 5)];
}

function findChrome() {
  return [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean).find((candidate) => fs.existsSync(candidate));
}

function findCommand(command) {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", [command], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null;
}

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${label} failed\ncommand: ${command} ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result;
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function countMatchingFiles(directory, pattern) {
  if (!fs.existsSync(directory)) return 0;
  return fs.readdirSync(directory).filter((name) => pattern.test(name)).length;
}

function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function ffmpegPath(file) {
  return file.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

async function stopChrome(child, userDataDir) {
  if (!child.killed) child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(3000)]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      return;
    } catch (_) {
      await delay(500);
    }
  }
}

async function waitForFile(file, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(file)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${file}`);
}

function readDevToolsEndpoint(userDataDir) {
  const [port] = fs.readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
  return `http://127.0.0.1:${port}/json/version`;
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.onmessage = (message) => {
      const payload = JSON.parse(message.data);
      if (payload.id && this.pending.has(payload.id)) {
        const { resolve, reject } = this.pending.get(payload.id);
        this.pending.delete(payload.id);
        if (payload.error) reject(new Error(payload.error.message || JSON.stringify(payload.error)));
        else resolve(payload.result || {});
      }
    };
  }
  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
}

async function createCdp(browserEndpoint) {
  const pageTarget = await json(browserEndpoint.replace(/\/json\/version.*$/, "/json/new?about:blank"), { method: "PUT" });
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return { cdp: new Cdp(ws), ws };
}

async function evalJs(cdp, expression, returnByValue = true) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue });
  if (result.exceptionDetails) throw new Error(`Runtime exception: ${JSON.stringify(result.exceptionDetails)}`);
  return result.result?.value;
}

async function setupPage(cdp, spec) {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: spec.video?.width ?? defaultWidth,
    height: spec.video?.height ?? defaultHeight,
    deviceScaleFactor: 1,
    mobile: false
  });
  await cdp.send("Emulation.setEmulatedMedia", {
    media: "screen",
    features: [{ name: "prefers-color-scheme", value: "light" }]
  });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      (() => {
        try {
          localStorage.setItem("color_mode", JSON.stringify({ color_mode: "light", light_theme: "light", dark_theme: "dark" }));
          localStorage.setItem("preferred_color_mode", "light");
          document.documentElement.setAttribute("data-color-mode", "light");
          document.documentElement.setAttribute("data-light-theme", "light");
          document.documentElement.setAttribute("data-dark-theme", "light");
        } catch (_) {}
      })();
    `
  });
}

async function navigate(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await waitUntil(cdp, "document.readyState === 'complete'", 30000);
  await delay(1500);
  await forceLightMode(cdp);
}

async function waitUntil(cdp, predicate, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await evalJs(cdp, `Boolean(${predicate})`)) return;
    } catch (_) {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${predicate}`);
}

async function forceLightMode(cdp) {
  await evalJs(cdp, `
    (() => {
      document.documentElement.setAttribute("data-color-mode", "light");
      document.documentElement.setAttribute("data-light-theme", "light");
      document.documentElement.setAttribute("data-dark-theme", "light");
      const meta = document.querySelector('meta[name="color-scheme"]');
      if (meta) meta.setAttribute("content", "light");
      if (!document.getElementById("agentdiff-capture-light-mode")) {
        const el = document.createElement("style");
        el.id = "agentdiff-capture-light-mode";
        el.textContent = "html, body { color-scheme: light !important; }";
        document.head.appendChild(el);
      }
    })();
  `);
}

async function getClipForStrategy(cdp, spec, strategy) {
  await forceLightMode(cdp);
  const width = spec.video?.width ?? defaultWidth;
  const height = spec.video?.height ?? defaultHeight;
  if (strategy === "checks") {
    return clipFromViewport(0, 110, width, 860, width, height);
  }
  if (strategy === "diff") {
    await waitUntil(cdp, `document.body.innerText.includes("issue_refund") && document.body.innerText.includes("escalate_ticket")`);
    await scrollToText(cdp, "issue_refund", 140);
    const rect = await rectForSelector(cdp, ".file, .js-file");
    return expandRect(rect, 24, 24, 24, 24, { maxHeight: 840, width, height });
  }
  if (strategy === "comment") {
    await waitUntil(cdp, `document.body.innerText.includes("Action required") && document.body.innerText.includes("issue_refund")`);
    const rect = await rectForTextContainerAbsolute(cdp, "agentdiff classification report");
    return { ...expandAbsoluteRect(rect, 24, 24, 24, 24, { maxWidth: 1160, maxHeight: 900 }), beyond: true };
  }
  if (strategy === "doc") {
    await waitUntil(cdp, `document.body.innerText.includes("Evidence loop") && document.body.innerText.includes("verified regression")`);
    await scrollToText(cdp, "V2 evidence bank", 220).catch(async () => scrollToText(cdp, "10 to 22", 220));
    const rect = await rectForSelector(cdp, "article.markdown-body, .markdown-body");
    return expandRect(rect, 32, 32, 32, 32, { maxHeight: 900, width, height });
  }
  return clipFromViewport(0, 0, width, height, width, height);
}

async function getExpectedTextStatus(cdp, expectedText) {
  const status = {};
  for (const text of expectedText) {
    status[text] = await evalJs(cdp, `document.body.innerText.includes(${JSON.stringify(text)})`);
  }
  return status;
}

async function scrollToText(cdp, text, offset = 120) {
  const found = await evalJs(cdp, `
    (() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue && node.nodeValue.includes(${JSON.stringify(text)})) {
          const el = node.parentElement;
          el.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
          window.scrollBy({ top: -${offset}, left: 0, behavior: "instant" });
          return true;
        }
      }
      return false;
    })();
  `);
  if (!found) throw new Error(`Text not found: ${text}`);
  await delay(700);
}

async function rectForSelector(cdp, selector) {
  const rect = await evalJs(cdp, `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })();
  `);
  if (!rect) throw new Error(`Selector not found: ${selector}`);
  return rect;
}

async function rectForTextContainerAbsolute(cdp, text) {
  const rect = await evalJs(cdp, `
    (() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue && node.nodeValue.includes(${JSON.stringify(text)})) {
          let el = node.parentElement;
          for (let i = 0; el && i < 10; i += 1) {
            const r = el.getBoundingClientRect();
            if (r.width > 650 && r.height > 450) {
              return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
            }
            el = el.parentElement;
          }
        }
      }
      return null;
    })();
  `);
  if (!rect) throw new Error(`Absolute text container not found: ${text}`);
  return rect;
}

function clipFromViewport(x, y, width, height, viewportWidth = defaultWidth, viewportHeight = defaultHeight) {
  return {
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: Math.min(viewportWidth - Math.max(0, x), width),
    height: Math.min(viewportHeight - Math.max(0, y), height),
    scale: 1
  };
}

function expandRect(rect, left, top, right, bottom, options = {}) {
  const viewportWidth = options.width ?? defaultWidth;
  const viewportHeight = options.height ?? defaultHeight;
  const x = Math.max(0, Math.floor(rect.x - left));
  const y = Math.max(0, Math.floor(rect.y - top));
  const width = Math.min(viewportWidth - x, Math.ceil(rect.width + left + right));
  const height = Math.min(viewportHeight - y, options.maxHeight ?? viewportHeight, Math.ceil(rect.height + top + bottom));
  return { x, y, width, height, scale: 1 };
}

function expandAbsoluteRect(rect, left, top, right, bottom, options = {}) {
  const x = Math.max(0, Math.floor(rect.x - left));
  const y = Math.max(0, Math.floor(rect.y - top));
  const width = Math.min(options.maxWidth ?? defaultWidth, Math.ceil(rect.width + left + right));
  const height = Math.min(options.maxHeight ?? defaultHeight, Math.ceil(rect.height + top + bottom));
  return { x, y, width, height, scale: 1 };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
