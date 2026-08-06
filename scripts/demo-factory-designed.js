import fs from "node:fs";
import path from "node:path";

const defaultWidth = 1920;
const defaultHeight = 1080;

export function renderDesignedVideo({ spec, paths, ffmpeg, chrome, run }) {
  const scenes = spec.render.scenes;
  const width = spec.video?.width ?? defaultWidth;
  const height = spec.video?.height ?? defaultHeight;
  const fps = spec.video?.fps ?? 30;
  const transitionDuration = Number(spec.render.transitionSeconds ?? 0.3);
  const transitions = spec.render.transitions ?? Array.from({ length: scenes.length - 1 }, () => "slideleft");

  fs.rmSync(paths.designed, { recursive: true, force: true });
  fs.rmSync(paths.alignment, { recursive: true, force: true });
  fs.mkdirSync(paths.designedScenes, { recursive: true });
  fs.mkdirSync(paths.designedClips, { recursive: true });
  fs.mkdirSync(paths.alignmentTransitions, { recursive: true });

  const pngs = scenes.map((scene, index) => renderScenePng({ scene, index, spec, paths, chrome, run, width, height }));
  const clips = scenes.map((scene, index) => renderSceneClip({ scene, index, scenes, png: pngs[index], paths, ffmpeg, run, width, height, fps, transitionDuration }));
  const silentVideo = path.join(paths.designedClips, "video-no-audio.mp4");
  renderTransitions({ scenes, clips, silentVideo, transitions, transitionDuration, ffmpeg, run, fps });

  return { scenes, silentVideo, transitionDuration, transitions };
}

export function writeDesignedAudit({ spec, paths, ffmpeg, run, finalMp4 }) {
  const duration = spec.render.scenes.reduce((sum, scene) => sum + Number(scene.durationSeconds), 0);
  for (let second = 0; second < Math.floor(duration); second += 1) {
    run(ffmpeg, ["-y", "-ss", String(second), "-i", finalMp4, "-frames:v", "1", path.join(paths.alignment, `sec-${String(second + 1).padStart(2, "0")}.png`)], `alignment frame ${second}s`);
  }
  run(ffmpeg, ["-y", "-framerate", "1", "-i", path.join(paths.alignment, "sec-%02d.png"), "-vf", "scale=480:-1,tile=6x7", "-frames:v", "1", "-update", "1", paths.alignmentContactSheet], "alignment contact sheet");

  const boundaries = [];
  let cursor = 0;
  for (const scene of spec.render.scenes.slice(0, -1)) {
    cursor += Number(scene.durationSeconds);
    boundaries.push(cursor - 0.1, cursor + 0.15, cursor + 0.35);
  }
  for (const [index, second] of boundaries.entries()) {
    run(ffmpeg, ["-y", "-ss", String(second), "-i", finalMp4, "-frames:v", "1", path.join(paths.alignmentTransitions, `transition-${String(index + 1).padStart(2, "0")}.png`)], `transition frame ${second}s`);
  }
  run(ffmpeg, ["-y", "-framerate", "1", "-i", path.join(paths.alignmentTransitions, "transition-%02d.png"), "-vf", "scale=640:-1,tile=3x5", "-frames:v", "1", "-update", "1", paths.transitionContactSheet], "transition contact sheet");
  return { secondFrames: Math.floor(duration), transitionFrames: boundaries.length };
}

function renderScenePng({ scene, index, spec, paths, chrome, run, width, height }) {
  if (!chrome) throw new Error("Chrome or Edge is required for designed demo scenes");
  const prefix = `${String(index + 1).padStart(2, "0")}-${scene.id}`;
  const html = path.join(paths.designedScenes, `${prefix}.html`);
  const png = path.join(paths.designedScenes, `${prefix}.png`);
  fs.writeFileSync(html, sceneHtml(spec, scene, width, height));
  run(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--window-size=${width},${height}`,
    `--screenshot=${png}`,
    `file:///${html.replace(/\\/g, "/")}`
  ], `capture designed scene ${scene.id}`);
  return png;
}

function renderSceneClip({ scene, index, scenes, png, paths, ffmpeg, run, width, height, fps, transitionDuration }) {
  const output = path.join(paths.designedClips, `${String(index + 1).padStart(2, "0")}-${scene.id}.mp4`);
  const clipDuration = Number(scene.durationSeconds) + (index < scenes.length - 1 ? transitionDuration : 0);
  const frames = Math.round(clipDuration * fps);
  const zoom = Number(scene.motion?.zoom ?? 1.02);
  const focusX = Number(scene.motion?.x ?? width / 2);
  const focusY = Number(scene.motion?.y ?? height / 2);
  const x = `min(max(${focusX}-(iw/zoom/2),0),iw-iw/zoom)`;
  const y = `min(max(${focusY}-(ih/zoom/2),0),ih-ih/zoom)`;
  const filter = `scale=${width}:${height},zoompan=z='1+(${(zoom - 1).toFixed(4)})*on/${frames}':d=${frames}:x='${x}':y='${y}':s=${width}x${height}:fps=${fps},trim=duration=${clipDuration},setpts=PTS-STARTPTS,format=yuv420p`;
  run(ffmpeg, [
    "-y", "-loop", "1", "-t", "1", "-i", png,
    "-vf", filter,
    "-r", String(fps),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    output
  ], `render designed clip ${scene.id}`);
  return output;
}

function renderTransitions({ scenes, clips, silentVideo, transitions, transitionDuration, ffmpeg, run, fps }) {
  const inputs = clips.flatMap((clip) => ["-i", clip]);
  const filters = [];
  let previous = "[0:v]";
  let offset = Number(scenes[0].durationSeconds);
  for (let index = 1; index < scenes.length; index += 1) {
    const output = index === scenes.length - 1 ? "[outv]" : `[v${index}]`;
    filters.push(`${previous}[${index}:v]xfade=transition=${transitions[index - 1]}:duration=${transitionDuration}:offset=${offset.toFixed(2)}${output}`);
    previous = output;
    offset += Number(scenes[index].durationSeconds);
  }
  run(ffmpeg, [
    "-y", ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "[outv]",
    "-r", String(fps),
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "17",
    "-pix_fmt", "yuv420p",
    silentVideo
  ], "render designed transitions");
}

function sceneHtml(spec, scene, width, height) {
  const renderers = {
    checks: checksScene,
    diff: diffScene,
    "comment-action": commentActionScene,
    "comment-surface": commentSurfaceScene,
    evidence: evidenceScene,
    cta: ctaScene
  };
  const renderer = renderers[scene.kind];
  if (!renderer) throw new Error(`Unsupported designed scene kind: ${scene.kind}`);
  const caption = ["evidence", "cta"].includes(scene.kind) ? "" : `<div class="caption">${esc(scene.caption)}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${baseStyles(width, height)}</style></head><body><div class="frame">${renderer(spec, scene)}${caption}</div></body></html>`;
}

function baseStyles(width, height) {
  return `
    :root { --fg:#1f2328; --muted:#59636e; --border:#d0d7de; --bg:#f6f8fa; --green:#1a7f37; --green-bg:#dafbe1; --red:#cf222e; --red-bg:#ffebe9; --blue:#0969da; --orange-bg:#fff8c5; }
    * { box-sizing:border-box; }
    body { margin:0; width:${width}px; height:${height}px; overflow:hidden; background:#fff; color:var(--fg); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; }
    .frame { position:relative; width:${width}px; height:${height}px; background:#fff; }
    .repo-top { height:74px; border-bottom:1px solid var(--border); background:#f6f8fa; display:flex; align-items:end; gap:28px; padding:0 42px 14px; font-size:16px; }
    .repo-top .active { border-bottom:3px solid #fd8c73; padding-bottom:18px; margin-bottom:-17px; font-weight:600; }
    .pr-head { padding:28px 42px 0; }
    .title { font-size:32px; font-weight:500; margin-bottom:12px; }
    .badge { display:inline-block; padding:6px 11px; border-radius:999px; background:#6e7781; color:white; font-weight:600; margin-right:8px; }
    .branch { background:#ddf4ff; color:#0969da; padding:4px 8px; border-radius:6px; }
    .tabs { display:flex; gap:4px; padding:22px 42px 0; border-bottom:1px solid var(--border); }
    .tab { padding:13px 18px; border:1px solid transparent; border-radius:8px 8px 0 0; font-size:16px; }
    .tab.active { border-color:var(--border); border-bottom-color:white; background:white; font-weight:600; }
    .caption { position:absolute; left:50%; bottom:34px; transform:translateX(-50%); min-width:420px; height:62px; padding:0 30px; border:1px solid rgba(255,255,255,.2); border-radius:14px; background:rgba(13,17,23,.9); box-shadow:0 10px 32px rgba(31,35,40,.22); color:white; display:flex; align-items:center; justify-content:center; font-size:27px; font-weight:600; white-space:nowrap; }
    .panel { border:1px solid var(--border); border-radius:8px; background:white; box-shadow:0 12px 32px rgba(31,35,40,.08); }
    .bot-avatar { width:38px; height:38px; border-radius:50%; display:grid; place-items:center; background:#24292f; color:white; font-size:18px; font-weight:800; }
  `;
}

function checksScene(spec, scene) {
  const checks = scene.checks ?? ["classify", "recorded-harness"];
  return `
    <div class="repo-top"><span>Code</span><span>Issues</span><span class="active">Pull requests</span><span>Actions</span><span>Projects</span><span>Security and quality</span><span>Insights</span></div>
    <div class="pr-head"><div class="title">${esc(scene.prTitle)} <span style="color:var(--muted)">#${spec.pr.number}</span></div><span class="badge">Draft</span><span style="color:var(--muted)">agentdiff-ai wants to merge 1 commit into </span><span class="branch">main</span></div>
    <div class="tabs"><div class="tab">Conversation</div><div class="tab">Commits</div><div class="tab active">Checks ${checks.length}</div><div class="tab">Files changed 1</div></div>
    <div style="display:grid;grid-template-columns:650px 1fr;height:626px"><div style="border-right:1px solid var(--border);padding:26px 42px"><div style="display:flex;align-items:center;gap:14px;font-size:18px;font-weight:650"><div style="width:58px;height:58px;border-radius:50%;background:#2da44e;color:white;display:grid;place-items:center;font-size:34px">&#10003;</div><div>${esc(scene.checkTitle)}<br><span style="font-size:13px;color:var(--muted);font-weight:400">succeeded 3 min ago</span></div></div><div style="margin-top:36px;border-radius:6px;overflow:hidden;border:1px solid var(--border)">${checks.map((check, index) => `<div style="padding:14px 18px;${index === 0 ? "background:#0969da;color:white;font-weight:600" : "color:var(--muted)"}">&#10003; ${esc(check)}</div>`).join("")}</div></div><div style="padding:32px 26px"><h2 style="font-size:22px;margin:0 0 18px">Annotations</h2><div style="color:var(--muted);margin-bottom:36px">1 warning</div><div style="font-size:22px;font-weight:650;margin-bottom:8px">classify</div><div style="color:var(--muted)">succeeded in 5s</div></div></div>
    <div class="panel" style="position:absolute;right:150px;top:480px;width:560px;padding:34px 42px"><div style="font-size:46px;font-weight:750">${esc(scene.calloutTitle)}</div><div style="font-size:32px;color:var(--muted);margin-top:12px">${esc(scene.calloutDetail)}</div></div>`;
}

function diffScene(_spec, scene) {
  const rows = scene.diffLines.map((line) => `<div style="display:grid;grid-template-columns:58px 1fr;align-items:center;height:42px;${line.tone === "removed" ? "background:var(--red-bg)" : line.tone === "added" ? "background:var(--green-bg)" : ""}"><div style="padding-left:22px;color:${line.tone === "removed" ? "var(--red)" : line.tone === "added" ? "var(--green)" : "var(--muted)"}">${line.tone === "removed" ? "-" : line.tone === "added" ? "+" : ""}</div><div style="color:${line.tone === "removed" ? "var(--red)" : line.tone === "added" ? "var(--green)" : "var(--fg)"}">${esc(line.code)}</div></div>`).join("");
  return `<div style="padding:58px 68px 0"><h1 style="font-size:56px;line-height:1;margin:0 0 12px">${esc(scene.headline)}</h1><div style="font-size:32px;color:var(--red)">${esc(scene.subhead)}</div></div><div class="panel" style="position:absolute;left:64px;right:64px;top:236px;height:585px;overflow:hidden"><div style="height:45px;border-bottom:1px solid var(--border);background:#f6f8fa;display:flex;align-items:center;padding:0 18px;font:14px Consolas,monospace;color:var(--muted)">${esc(scene.file)}</div><div style="font:20px Consolas,monospace;padding-top:18px">${rows}</div></div><div class="panel" style="position:absolute;right:120px;top:304px;width:610px;padding:36px 44px"><div style="font-size:34px;color:var(--muted);font-weight:750">Before</div>${scene.beforeCalls.map((call) => `<div style="font:40px Consolas,monospace;color:var(--red);margin:14px 0 20px">${esc(call)}</div>`).join("")}<div style="font-size:34px;color:var(--muted);font-weight:750;margin-top:24px">After</div>${scene.afterCalls.map((call) => `<div style="font:40px Consolas,monospace;color:var(--green);margin-top:12px">${esc(call)}</div>`).join("")}</div>`;
}

function commentFrame(scene, content) {
  return `<div style="display:grid;grid-template-columns:470px 1fr;height:976px"><div style="padding:88px 0 0 96px"><div style="font-size:54px;font-weight:800">${esc(scene.sideTitle)}</div><div style="font-size:31px;color:var(--muted);margin-top:8px">${esc(scene.sideDetail)}</div></div><div style="padding-top:26px"><div class="panel" style="width:1080px;min-height:880px;padding:0 34px 28px;box-shadow:none"><div style="height:72px;margin:0 -34px 26px;padding:0 34px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px"><div class="bot-avatar">A</div><div style="font-size:18px"><strong>agentdiff</strong> <span style="color:var(--muted)">bot commented now</span></div><span style="margin-left:auto;border:1px solid var(--border);border-radius:999px;padding:5px 10px;font-size:13px;color:var(--muted)">sticky report</span></div><div style="font-size:36px;font-weight:750;border-bottom:1px solid var(--border);padding-bottom:18px">agentdiff classification report</div>${content}</div></div></div>`;
}

function commentActionScene(_spec, scene) {
  const summary = Object.entries(scene.summary).map(([key, value]) => `${esc(key)}: ${esc(value)}`).join("<br>");
  return commentFrame(scene, `<div style="font:18px Consolas,monospace;line-height:1.65;margin-top:22px">${summary}</div><div style="margin-top:28px;border:3px solid #fb8c00;background:var(--orange-bg);height:66px;display:flex;align-items:center;padding:0 16px;font-size:27px;font-weight:750">Action required (1)</div><h2 style="font-size:29px;margin:18px 0">${esc(scene.findingTitle)}</h2><div style="font-size:20px;color:var(--muted);line-height:1.6">file: ${esc(scene.file)}<br>type: behavior_surface_change<br>actionability: action_required</div>`);
}

function commentSurfaceScene(_spec, scene) {
  return commentFrame(scene, `<div style="margin-top:24px;border-bottom:1px solid var(--border);padding-bottom:18px;font-size:22px;font-weight:700">Action required (1)</div><h2 style="font-size:27px;margin:18px 0 22px">${esc(scene.findingTitle)}</h2><div style="font-size:20px;color:var(--muted);line-height:1.55;margin-bottom:24px">file: ${esc(scene.file)}<br>actionability: action_required</div><div style="font-size:22px;font-weight:750;margin-bottom:12px">added calls:</div><div style="border:3px solid var(--green);background:rgba(26,127,55,.12);padding:16px 22px;width:520px;font:22px Consolas,monospace;line-height:1.7;color:var(--green)">${scene.addedCalls.map((call) => `+ ${esc(call)}`).join("<br>")}</div><div style="font-size:22px;font-weight:750;margin:28px 0 12px">removed calls:</div><div style="border:3px solid var(--red);background:rgba(207,34,46,.10);padding:16px 22px;width:520px;font:22px Consolas,monospace;color:var(--red)">${scene.removedCalls.map((call) => `- ${esc(call)}`).join("<br>")}</div><p style="font-size:20px;line-height:1.45;margin-top:26px;max-width:790px">${esc(scene.whyItMatters)}</p>`);
}

function evidenceScene(_spec, scene) {
  return `<div style="width:100%;height:100%;display:grid;place-items:center"><div class="panel" style="width:1460px;padding:78px 90px;text-align:center;background:#f6f8fa;box-shadow:none"><div style="font-size:58px;font-weight:800;margin-bottom:60px">${esc(scene.headline)}</div><div style="font-size:42px;color:var(--green);margin-bottom:18px">${esc(scene.added)}</div><div style="font-size:42px;color:var(--red);margin-bottom:22px">${esc(scene.removed)}</div><div style="font-size:50px;color:var(--blue);font-weight:750">${esc(scene.proof)}</div></div></div>`;
}

function ctaScene(_spec, scene) {
  return `<div style="width:100%;height:100%;display:grid;place-items:center;background:#050505;color:white;text-align:center"><div><div style="font-size:112px;font-weight:850">${esc(scene.brand)}</div><div style="font-size:48px;margin-top:30px;color:#e5e7eb">${esc(scene.tagline)}</div><div style="font-size:34px;margin-top:70px;color:#58a6ff">${esc(scene.url)}</div><div style="display:inline-flex;align-items:center;justify-content:center;margin-top:58px;background:#238636;width:480px;height:76px;border-radius:8px;font-size:34px;font-weight:800">${esc(scene.cta)}</div></div></div>`;
}

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
